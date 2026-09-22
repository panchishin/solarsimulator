// The editor's view of the engine.
//
// Everything the browser needs from engine/ passes through here, and nothing in here touches the
// DOM, so the same module the page runs is the one the tests run. The editor's circuit is already
// the engine's layout: components carry an id, a catalog id, a pixel position and a rotation, and
// wires carry a conductor type and two terminal endpoints.

import { Catalog } from "../engine/core/catalog.js";
import { World } from "../engine/world.js";
import { createEnvironment } from "../engine/environment/site.js";
import {
  GRID_SIZE_PX,
  componentGridSize,
  rotatedTerminalLayout
} from "../engine/core/geometry.js";

export { GRID_SIZE_PX, componentGridSize, rotatedTerminalLayout };

export const CATALOG_URL = "catalog/catalog.v3.json";

/** Palette order: generation, storage, conversion, distribution, consumption. */
const GROUP_ORDER = ["pv", "battery", "controller", "inverter", "protection", "load"];

const GROUP_LABELS = {
  pv: "Solar",
  battery: "Battery",
  controller: "Controller",
  inverter: "Inverter",
  protection: "Protection",
  load: "Load"
};

export async function fetchCatalog(url = CATALOG_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the catalog (${response.status})`);
  return new Catalog(await response.json());
}

export const groupLabel = (group) => GROUP_LABELS[group] ?? group;

export function paletteGroups(catalog) {
  const present = new Set([...catalog.components.values()].map((entry) => entry.group));
  const ordered = GROUP_ORDER.filter((group) => present.has(group));
  return [...ordered, ...[...present].filter((group) => !ordered.includes(group)).sort()];
}

/** The one specification worth showing under a palette entry's name. */
function headline(definition) {
  const specifications = definition.specifications ?? {};
  const preferred = [
    "Nominal voltage",
    "Rated power",
    "Continuous output",
    "Maximum power",
    "Rated current",
    "Charge current",
    "Power"
  ];
  for (const key of preferred) {
    if (specifications[key]) return specifications[key];
  }
  return Object.values(specifications)[0] ?? "";
}

export function paletteItems(catalog, group = "all") {
  return [...catalog.components.values()]
    .filter((definition) => group === "all" || definition.group === group)
    .map((definition) => ({ ...definition, headline: headline(definition) }));
}

export function wireTypeOptions(catalog) {
  return catalog.json.wires.map((wire) => ({
    id: wire.id,
    name: wire.name,
    gauge: wire.gauge,
    ampacity: catalog.gauge(wire.gauge).ampacityFreeAir75CAmps
  }));
}

/**
 * The system on the receipt: four 200 W modules in series into the 100 A tracker, the golf cart
 * pack, and the 2.5 kW inverter running a fridge and two lamps.
 *
 * Positions are grid squares. Gauges follow the current each run has to carry: 10 AWG for a
 * 10 A string, 6 AWG between tracker and pack, 2 AWG for the 52 A the inverter draws at rating
 * and the 104 A it draws at peak, and lamp cord for the AC branch. Everything but the modules is
 * marked indoors, which is where an installation puts it, and is what lets the pack charge on a
 * winter morning: below freezing its BMS refuses charge.
 */
const DEFAULT_LAYOUT = {
  components: [
    { id: "panel-1", part: "pv-bifacial-200w", grid: [0, 0] },
    { id: "panel-2", part: "pv-bifacial-200w", grid: [0, 4] },
    { id: "panel-3", part: "pv-bifacial-200w", grid: [0, 8] },
    { id: "panel-4", part: "pv-bifacial-200w", grid: [0, 12] },
    { id: "controller", part: "controller-mppt-100a", grid: [7, 5], indoors: true },
    { id: "pack", part: "battery-lifepo4-48v-100ah-golf", grid: [7, 10], indoors: true },
    { id: "inverter", part: "inverter-48v-2500w", grid: [14, 5], indoors: true },
    { id: "fridge", part: "load-fridge-120w", grid: [21, 10], indoors: true },
    { id: "lamp-1", part: "load-led-10w", grid: [21, 1], indoors: true },
    { id: "lamp-2", part: "load-led-10w", grid: [21, 5], indoors: true }
  ],
  wires: [
    ["panel-1", "positive", "panel-2", "negative", "wire-cu-10awg-thhn"],
    ["panel-2", "positive", "panel-3", "negative", "wire-cu-10awg-thhn"],
    ["panel-3", "positive", "panel-4", "negative", "wire-cu-10awg-thhn"],
    ["panel-4", "positive", "controller", "pv-positive", "wire-cu-10awg-thhn"],
    ["panel-1", "negative", "controller", "pv-negative", "wire-cu-10awg-thhn"],
    ["controller", "battery-positive", "pack", "positive", "wire-cu-6awg-thhn"],
    ["controller", "battery-negative", "pack", "negative", "wire-cu-6awg-thhn"],
    ["pack", "positive", "inverter", "dc-positive", "wire-cu-2awg-thhn"],
    ["pack", "negative", "inverter", "dc-negative", "wire-cu-2awg-thhn"],
    ["inverter", "ac-line", "fridge", "ac-line", "wire-cu-12awg-thhn"],
    ["inverter", "ac-neutral", "fridge", "ac-neutral", "wire-cu-12awg-thhn"],
    ["fridge", "ac-line", "lamp-1", "ac-line", "wire-cu-14awg-thhn"],
    ["fridge", "ac-neutral", "lamp-1", "ac-neutral", "wire-cu-14awg-thhn"],
    ["lamp-1", "ac-line", "lamp-2", "ac-line", "wire-cu-14awg-thhn"],
    ["lamp-1", "ac-neutral", "lamp-2", "ac-neutral", "wire-cu-14awg-thhn"]
  ]
};

/** The starter layout, checked against the catalog so a renamed part fails here and not later. */
export function defaultCircuit(catalog) {
  const components = DEFAULT_LAYOUT.components.map(({ id, part, grid, indoors }) => {
    catalog.component(part);
    return {
      id,
      componentId: part,
      x: grid[0] * GRID_SIZE_PX,
      y: grid[1] * GRID_SIZE_PX,
      rotation: 0,
      ...(indoors ? { indoors: true } : {})
    };
  });
  const wires = DEFAULT_LAYOUT.wires.map(([from, fromTerminal, to, toTerminal, wireTypeId], i) => {
    catalog.wireType(wireTypeId);
    return {
      id: `default-wire-${i + 1}`,
      wireTypeId,
      from: { componentId: from, terminalId: fromTerminal },
      to: { componentId: to, terminalId: toTerminal }
    };
  });
  return { components, wires };
}

/**
 * Drop anything the catalog no longer knows about. Saved layouts outlive catalog edits, and the
 * netlist rejects a join to a terminal that does not exist rather than silently ignoring it, so
 * the check belongs here where a stale layout can still be loaded.
 */
export function sanitizeCircuit(catalog, circuit) {
  const components = [];
  const dropped = [];
  for (const component of circuit?.components ?? []) {
    if (catalog.components.has(component.componentId)) components.push(component);
    else dropped.push({ id: component.id, reason: `no such part "${component.componentId}"` });
  }
  const byId = new Map(components.map((component) => [component.id, component]));
  const known = (endpoint) => {
    const component = byId.get(endpoint?.componentId);
    if (!component) return false;
    const definition = catalog.component(component.componentId);
    return definition.terminals.some((terminal) => terminal.id === endpoint.terminalId);
  };
  const wires = [];
  for (const wire of circuit?.wires ?? []) {
    if (!known(wire.from) || !known(wire.to)) {
      dropped.push({ id: wire.id, reason: "one of its terminals is gone" });
      continue;
    }
    const wireTypeId = catalog.wireTypes.has(wire.wireTypeId)
      ? wire.wireTypeId
      : catalog.defaultWireTypeId;
    wires.push({ ...wire, wireTypeId });
  }
  return { circuit: { components, wires }, dropped };
}

/**
 * A running simulation of one layout.
 *
 * Device state lives in the devices, so an edit rebuilds the world and carries the state of every
 * device that survived the edit across to it: moving a load must not reset the pack's charge, and
 * deleting a burnt wire must not un-burn the component next to it.
 */
export class Session {
  constructor({ catalog, circuit, startDate, checkInvariants = false }) {
    this.catalog = catalog;
    this.startDate = startDate instanceof Date ? startDate : new Date(startDate);
    this.checkInvariants = checkInvariants;
    this.dropped = [];
    this.build(circuit, 0);
  }

  build(circuit, startSeconds, carry = null) {
    const { circuit: clean, dropped } = sanitizeCircuit(this.catalog, circuit);
    this.dropped = dropped;
    this.circuit = clean;
    this.world = new World({
      catalog: this.catalog,
      layout: { components: clean.components, wires: clean.wires },
      environment: createEnvironment({ catalog: this.catalog, startDate: this.startDate }),
      checkInvariants: this.checkInvariants,
      startSeconds
    });
    if (carry) this.carryState(carry);
    // Solve once so the layout reads as what it is before anyone presses Run: a panel in the sun
    // is making power the instant it is wired up, not one tick later.
    if (this.world.devices.length > 0) this.world.solveNow(0);
  }

  /** Identity of a device for the purpose of carrying state: same id, same part. */
  identities() {
    const identities = new Map();
    for (const component of this.circuit.components) {
      identities.set(component.id, component.componentId);
    }
    for (const wire of this.circuit.wires) identities.set(wire.id, wire.wireTypeId);
    return identities;
  }

  carryState({ snapshot, identities }) {
    const current = this.identities();
    const world = this.world;
    for (const entry of snapshot.devices) {
      if (identities.get(entry.id) !== current.get(entry.id)) continue;
      const device = world.deviceById.get(entry.id);
      if (!device) continue;
      device.state = structuredClone(entry.state);
      device.mode = entry.mode;
      device.failure = entry.failure;
      device.damageMode = entry.damageMode;
    }
    const keys = new Set(world.thermalNetwork.temperatures().keys());
    world.thermalNetwork.restoreTemperatures(
      [...snapshot.temperatures].filter(([key]) => keys.has(key))
    );
  }

  /** Take the edited circuit, keeping the run going. */
  replaceCircuit(circuit) {
    const carry = { snapshot: this.world.snapshot(), identities: this.identities() };
    this.build(circuit, this.world.timeSeconds, carry);
  }

  /** Back to hour zero with fresh devices. */
  reset() {
    this.build(this.circuit, 0);
  }

  /** Move the clock without disturbing the layout. */
  setStartDate(startDate) {
    this.startDate = startDate instanceof Date ? startDate : new Date(startDate);
    this.build(this.circuit, 0);
  }

  advanceMinutes(minutes) {
    return this.world.advanceMinutes(minutes);
  }

  setSwitchClosed(id, closed) {
    const device = this.world.deviceById.get(id);
    if (device?.setClosed) device.setClosed(closed);
  }

  date() {
    return new Date(this.startDate.getTime() + this.world.timeSeconds * 1000);
  }

  view() {
    const report = this.world.report();
    const wireIds = new Set(this.circuit.wires.map((wire) => wire.id));
    const devices = {};
    for (const [id, entry] of Object.entries(report.devices)) {
      devices[id] = {
        ...entry,
        burning: entry.failure === "burning" || entry.failure === "consumed",
        temperatureC: displayTemperatureC(entry)
      };
    }
    const hazards = report.hazards.map((hazard) => ({
      type: hazard.type,
      message: hazard.message,
      severity: hazard.severity,
      componentIds: hazard.deviceIds.filter((id) => !wireIds.has(id)),
      wireIds: hazard.deviceIds.filter((id) => wireIds.has(id))
    }));
    const environment = report.environment;
    return {
      timeSeconds: report.timeSeconds,
      elapsedMinutes: report.elapsedMinutes,
      date: this.date(),
      environment: {
        ambientTemperatureC: environment.ambientTemperatureC,
        windSpeedMPerS: environment.windSpeedMPerS,
        globalHorizontalWPerM2: environment.globalHorizontalWPerM2,
        solarElevationDeg: environment.solarElevationDeg,
        clearness: environment.clearness
      },
      totals: report.totals,
      devices,
      hazards,
      solver: report.solver,
      dropped: this.dropped
    };
  }
}

/**
 * The temperature to put on a component's face. Every device measures the node its datasheet is
 * about under its own name, so there is no single field to read: a panel reports its cell, a wire
 * its conductor, everything else its case or heatsink.
 */
function displayTemperatureC(entry) {
  return (
    entry.temperatureC ??
    entry.cellTemperatureC ??
    entry.conductorTemperatureC ??
    entry.caseTemperatureC ??
    null
  );
}

export const createSession = (options) => new Session(options);
