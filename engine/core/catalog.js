// Catalog v3 loader, provenance validator and accessors.
//
// The engine contains equations; this module is the only way it reaches numbers. Every
// numeric leaf inside a validated region must have a `source` in scope, inherited from the
// nearest enclosing object that declares one. See catalog/schema.md.

import { interpolate, toKelvin } from "./units.js";

/** Regions of the catalog where every number must carry provenance. */
const VALIDATED_REGIONS = ["simulation", "materials", "conductors"];

const SOURCE_PREFIXES = ["ref:", "derived:", "estimate:", "assumption:", "constant:"];

const REQUIRED_ELECTRICAL = {
  battery: [
    "nominalVoltage",
    "capacityAh",
    "startingStateOfCharge",
    "internalResistanceOhms",
    "openCircuitVoltageCurve",
    "coulombicEfficiency"
  ],
  pv: [
    "cellsInSeries",
    "substrings",
    "shortCircuitCurrentAmps",
    "openCircuitVoltage",
    "maxPowerVoltage",
    "maxPowerCurrentAmps",
    "diodeIdeality"
  ],
  chargeController: ["maxInputVoltage", "maxChargeCurrentAmps", "idleDrawWatts", "stages"],
  inverter: [
    "nominalInputVoltage",
    "outputVoltage",
    "continuousOutputWatts",
    "idleDrawWatts",
    "efficiencyCurve",
    "outputResistanceOhms"
  ],
  load: ["behaviour", "ratedVoltage", "ratedPowerWatts"],
  fuse: ["ratedAmps", "coldResistanceOhms"],
  breaker: ["ratedAmps", "coldResistanceOhms"],
  switch: ["closedResistanceOhms"],
  busbar: ["resistanceOhms"]
};

const REQUIRED_LIMITS = {
  fuse: ["timeCurrentCurve"],
  breaker: ["timeCurrentCurve", "magneticMultiple", "magneticTripSeconds"]
};

export class CatalogError extends Error {
  constructor(problems) {
    super(`Catalog is invalid:\n  ${problems.join("\n  ")}`);
    this.name = "CatalogError";
    this.problems = problems;
  }
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProvenanceKey = (key) => key === "source" || key.endsWith("Source");

function checkProvenance(node, path, inheritedSource, references, problems) {
  if (typeof node === "number") {
    if (!inheritedSource) problems.push(`${path} is a number with no source in scope`);
    return;
  }
  if (typeof node === "string" || typeof node === "boolean" || node === null) return;

  if (Array.isArray(node)) {
    node.forEach((entry, index) =>
      checkProvenance(entry, `${path}[${index}]`, inheritedSource, references, problems)
    );
    return;
  }

  let source = inheritedSource;
  for (const [key, value] of Object.entries(node)) {
    if (!isProvenanceKey(key)) continue;
    if (typeof value !== "string") {
      problems.push(`${path}.${key} must be a string`);
      continue;
    }
    if (!SOURCE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      problems.push(
        `${path}.${key} must start with one of ${SOURCE_PREFIXES.join(", ")} (got "${value}")`
      );
      continue;
    }
    for (const match of value.matchAll(/ref:([A-Za-z0-9._-]+)/g)) {
      // Citations sit inside prose, so a trailing sentence period is not part of the key.
      const key_ = match[1].replace(/[.]+$/, "");
      if (!references[key_]) {
        problems.push(`${path}.${key} cites unknown reference "${key_}"`);
      }
    }
    if (key === "source") source = value;
  }

  for (const [key, value] of Object.entries(node)) {
    if (isProvenanceKey(key)) continue;
    // A sibling `<key>Source` annotates exactly this key, and takes precedence over the
    // inherited source for it and everything under it.
    const sibling = node[`${key}Source`];
    const effective = typeof sibling === "string" ? sibling : source;
    checkProvenance(value, `${path}.${key}`, effective, references, problems);
  }
}

export function validateCatalog(json) {
  const problems = [];
  if (json?.schemaVersion !== 3) {
    problems.push(`schemaVersion must be 3 (got ${json?.schemaVersion})`);
  }
  const references = json?.references ?? {};
  if (!isPlainObject(references) || Object.keys(references).length === 0) {
    problems.push("references must be a non-empty object");
  }

  for (const region of VALIDATED_REGIONS) {
    if (json?.[region] === undefined) {
      problems.push(`missing region "${region}"`);
      continue;
    }
    checkProvenance(json[region], region, null, references, problems);
  }

  const materials = json?.materials ?? {};
  for (const [index, wire] of (json?.wires ?? []).entries()) {
    const path = `wires[${index}] (${wire.id ?? "?"})`;
    checkProvenance(wire.model, `${path}.model`, null, references, problems);
    if (!json.conductors?.gauges?.[wire.gauge]) {
      problems.push(`${path} names unknown gauge "${wire.gauge}"`);
    }
    for (const key of ["conductorMaterial", "insulationMaterial"]) {
      if (!materials[wire[key]]) problems.push(`${path}.${key} "${wire[key]}" is not a material`);
    }
  }

  for (const [index, component] of (json?.components ?? []).entries()) {
    const path = `components[${index}] (${component.id ?? "?"})`;
    const model = component.model;
    if (!isPlainObject(model)) {
      problems.push(`${path} has no model`);
      continue;
    }
    checkProvenance(model, `${path}.model`, null, references, problems);

    const required = REQUIRED_ELECTRICAL[model.type];
    if (!required) {
      problems.push(`${path}.model.type "${model.type}" has no registered requirements`);
    } else {
      for (const key of required) {
        if (model.electrical?.[key] === undefined) {
          problems.push(`${path}.model.electrical.${key} is required for type ${model.type}`);
        }
      }
      for (const key of REQUIRED_LIMITS[model.type] ?? []) {
        if (model.limits?.[key] === undefined) {
          problems.push(`${path}.model.limits.${key} is required for type ${model.type}`);
        }
      }
    }

    const nodes = model.thermal?.nodes;
    if (!isPlainObject(nodes) || Object.keys(nodes).length === 0) {
      problems.push(`${path}.model.thermal.nodes must declare at least one node`);
    } else {
      for (const [name, node] of Object.entries(nodes)) {
        if (!materials[node.material]) {
          problems.push(`${path}.model.thermal.nodes.${name}.material "${node.material}" is not a material`);
        }
        if (!(node.massKg > 0)) {
          problems.push(`${path}.model.thermal.nodes.${name}.massKg must be positive`);
        }
      }
      const heatNode = model.thermal.heatNode;
      if (heatNode !== undefined && !nodes[heatNode]) {
        problems.push(`${path}.model.thermal.heatNode "${heatNode}" is not one of its nodes`);
      }
      for (const link of [...(model.thermal.links ?? []), ...(model.thermal.radiationLinks ?? [])]) {
        for (const end of [link.from, link.to]) {
          if (!nodes[end]) problems.push(`${path}.model.thermal link endpoint "${end}" is not a node`);
        }
      }
    }

    if (!Array.isArray(component.terminals) || component.terminals.length === 0) {
      problems.push(`${path} must declare terminals`);
    }
  }

  if (problems.length) throw new CatalogError(problems);
  return json;
}

export class Catalog {
  constructor(json) {
    this.json = validateCatalog(json);
    this.components = new Map(json.components.map((entry) => [entry.id, entry]));
    this.wireTypes = new Map(json.wires.map((entry) => [entry.id, entry]));
    this.simulation = json.simulation;
    this.materials = json.materials;
    this.references = json.references;
  }

  component(id) {
    const definition = this.components.get(id);
    if (!definition) throw new RangeError(`Unknown component "${id}"`);
    return definition;
  }

  wireType(id) {
    const definition = this.wireTypes.get(id);
    if (!definition) throw new RangeError(`Unknown wire type "${id}"`);
    return definition;
  }

  get defaultWireTypeId() {
    return this.json.wires[0].id;
  }

  material(name) {
    const material = this.materials[name];
    if (!material) throw new RangeError(`Unknown material "${name}"`);
    return material;
  }

  gauge(name) {
    const gauge = this.json.conductors.gauges[name];
    if (!gauge) throw new RangeError(`Unknown conductor gauge "${name}"`);
    return gauge;
  }

  /** Every numeric solver/integrator setting, flattened for convenience. */
  get settings() {
    return {
      ...this.simulation.solver,
      ...this.simulation.integrator,
      conservation: this.simulation.conservation
    };
  }
}

export const createCatalog = (json) => new Catalog(json);

/**
 * Resistivity at temperature. Metals near room temperature use the linear coefficient;
 * refractory metals over a wide range use the power law (see engine/PHYSICS.md section 2).
 */
export function resistivityAt(material, temperatureC) {
  const reference = material.resistivityReferenceTemperatureC;
  if (material.resistivityTempExponent !== undefined) {
    const ratio = toKelvin(temperatureC) / toKelvin(reference);
    return material.resistivityOhmMeters * Math.max(ratio, 1e-6) ** material.resistivityTempExponent;
  }
  const coefficient = material.resistivityTempCoefficientPerC ?? 0;
  return Math.max(
    material.resistivityOhmMeters * (1 + coefficient * (temperatureC - reference)),
    material.resistivityOhmMeters * 1e-3
  );
}

/** Air transport properties at a film temperature, scaled from the catalog reference point. */
export function airProperties(air, filmTemperatureK) {
  const ratio = Math.max(filmTemperatureK / air.referenceTemperatureK, 0.2);
  return {
    conductivityWPerMK: air.thermalConductivityWPerMK * ratio ** air.conductivityTempExponent,
    kinematicViscosityM2PerS: air.kinematicViscosityM2PerS * ratio ** air.viscosityTempExponent,
    prandtl: air.prandtl,
    specificHeatJPerKgC: air.specificHeatJPerKgC
  };
}

/** Interpolate a `{ temperatureC, factor }` table. */
export const temperatureFactor = (table, temperatureC) =>
  table ? interpolate(table, temperatureC, "temperatureC", "factor") : 1;

/** Interpolate a `{ stateOfCharge, factor }` table. */
export const stateOfChargeFactor = (table, stateOfCharge) =>
  table ? interpolate(table, stateOfCharge, "stateOfCharge", "factor") : 1;
