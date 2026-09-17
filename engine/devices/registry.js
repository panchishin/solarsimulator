// Device registry: turns a catalog component plus a layout instance into a device object.
//
// The device interface is deliberately small. `stamp` describes the electrical behaviour at the
// current guess, `limits` picks a mode at the solved point, `heat` says where the losses go,
// `advance` integrates the slow states, and `events` declares the zero crossings that the
// integrator has to land on exactly.

import { DEVICE_DEFAULTS } from "./defaults.js";
import { createBatteryDevice } from "./battery.js";
import { createBreakerDevice } from "./breaker.js";
import { createBusbarDevice } from "./busbar.js";
import { createChargeControllerDevice } from "./chargeController.js";
import { createFuseDevice } from "./fuse.js";
import { createInverterDevice } from "./inverter.js";
import { createLoadDevice } from "./load.js";
import { createPvDevice } from "./pv.js";
import { createSwitchDevice } from "./switch.js";

const FACTORIES = {
  battery: createBatteryDevice,
  breaker: createBreakerDevice,
  busbar: createBusbarDevice,
  chargeController: createChargeControllerDevice,
  fuse: createFuseDevice,
  inverter: createInverterDevice,
  load: createLoadDevice,
  pv: createPvDevice,
  switch: createSwitchDevice
};

/** Galvanically separate port groups. Only the isolated inverter has more than one. */
function galvanicGroupsFor(definition) {
  if (definition.model.type !== "inverter") {
    return [definition.terminals.map((terminal) => terminal.id)];
  }
  const dc = definition.terminals.filter((terminal) => terminal.domain === "dc").map((t) => t.id);
  const ac = definition.terminals.filter((terminal) => terminal.domain === "ac").map((t) => t.id);
  return [dc, ac];
}

/** Resolve `model.thermal` into node descriptors with materials already looked up. */
export function thermalSpecFrom(catalog, model) {
  const nodes = Object.entries(model.thermal.nodes).map(([name, node]) => {
    let surface = node.surface ? { ...node.surface } : null;
    if (surface?.geometry === "faiman") {
      surface.faimanU0 = model.optical.faimanU0;
      surface.faimanU1 = model.optical.faimanU1;
    }
    return {
      name,
      material: catalog.material(node.material),
      massKg: node.massKg,
      surface,
      runaway: node.runaway === true
    };
  });
  return {
    nodes,
    links: model.thermal.links ?? [],
    radiationLinks: model.thermal.radiationLinks ?? [],
    heatNodeName: model.thermal.heatNode ?? nodes[0].name
  };
}

export function createComponentDevice({ catalog, instance }) {
  const definition = catalog.component(instance.componentId);
  const model = definition.model;
  const factory = FACTORIES[model.type];
  if (!factory) throw new RangeError(`No device factory for type "${model.type}"`);

  const thermal = thermalSpecFrom(catalog, model);
  const base = {
    ...DEVICE_DEFAULTS,
    id: instance.id,
    kind: model.type,
    componentId: instance.componentId,
    name: definition.name,
    catalog,
    definition,
    instance,
    model,
    electrical: model.electrical ?? {},
    limitsSpec: model.limits ?? {},
    ports: definition.terminals.map((terminal) => ({
      name: terminal.id,
      domain: terminal.domain,
      role: terminal.role,
      reference: terminal.reference === true
    })),
    bindings: Object.fromEntries(
      definition.terminals.map((terminal) => [
        terminal.id,
        { componentId: instance.id, terminalId: terminal.id }
      ])
    ),
    galvanicGroups: galvanicGroupsFor(definition),
    internalNodes: [],
    domain: definition.terminals[0].domain,
    mode: "ok",
    failure: "ok",
    damageMode: model.limits?.damageMode ?? "open",
    failureHistory: [],
    state: {},
    portCurrents: new Map(),
    thermalNodes: thermal.nodes,
    thermalLinks: thermal.links,
    thermalRadiationLinks: thermal.radiationLinks,
    heatNodeName: thermal.heatNodeName,
    thermal: null
  };

  return factory({ base, catalog });
}

export const deviceTypes = Object.keys(FACTORIES);
