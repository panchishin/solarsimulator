// The thermal network: one lumped-capacitance graph across the whole world, so heat can move
// between devices (and fire can spread) rather than each device cooling in isolation.
//
// The implicit step is a Newton solve on the backward-Euler equations, with the analytic
// derivative of the T^4 radiation term. Backward Euler is unconditionally stable, and solving
// the nonlinearity properly is what lets a filament with a 3 mJ/K heat capacity sit at 2700 C
// in the same 60-second step that a 50 kg cabinet barely moves in.

import { SparseSystem } from "../core/linalg.js";
import { surfaceConductance, radiation } from "./convection.js";
import { heatCapacityJPerK } from "./materials.js";

const ABSOLUTE_FLOOR_C = -272;

export class ThermalNetwork {
  constructor({ catalog, ambientC = 20 }) {
    this.catalog = catalog;
    this.air = catalog.material("air");
    this.ambientC = ambientC;
    this.windSpeedMPerS = 0;
    this.nodes = [];
    this.indexByKey = new Map();
    this.links = [];
    this.radiationLinks = [];
    this.dynamicLinks = [];
  }

  addNode({ key, deviceId, name, material, massKg, surface = null, runaway = false }) {
    if (this.indexByKey.has(key)) throw new RangeError(`Duplicate thermal node "${key}"`);
    const node = {
      key,
      deviceId,
      name,
      material,
      massKg,
      surface,
      runaway,
      capacityJPerK: heatCapacityJPerK(material, massKg),
      index: this.nodes.length,
      temperatureC: this.ambientC,
      heatWatts: 0,
      surfaceLossWatts: 0,
      fanRunning: true
    };
    this.indexByKey.set(key, node);
    this.nodes.push(node);
    return node;
  }

  node(key) {
    const node = this.indexByKey.get(key);
    if (!node) throw new RangeError(`Unknown thermal node "${key}"`);
    return node;
  }

  addLink(fromKey, toKey, conductanceWPerK) {
    this.links.push({ a: this.node(fromKey), b: this.node(toKey), conductanceWPerK });
  }

  addRadiationLink({ from, to, areaM2, emissivity, viewFactor = 1, transmittance = 0 }) {
    this.radiationLinks.push({
      a: this.node(from),
      b: this.node(to),
      areaM2,
      emissivity,
      viewFactor,
      transmittance
    });
  }

  /** Fire couplings, rebuilt every step from device positions and burn states. */
  setDynamicLinks(links) {
    this.dynamicLinks = links.map((link) => ({
      a: this.node(link.from),
      b: this.node(link.to),
      areaM2: link.areaM2,
      emissivity: link.emissivity,
      viewFactor: link.viewFactor ?? 1,
      transmittance: 0
    }));
  }

  temperature(key) {
    return this.node(key).temperatureC;
  }

  setHeat(key, watts) {
    this.node(key).heatWatts = watts;
  }

  temperatures() {
    return new Map(this.nodes.map((node) => [node.key, node.temperatureC]));
  }

  restoreTemperatures(snapshot) {
    for (const [key, temperatureC] of snapshot) this.node(key).temperatureC = temperatureC;
  }

  /**
   * Residual and Jacobian of the backward-Euler system at the trial temperatures.
   * `invDt` of zero gives the steady state.
   */
  assemble(trial, previous, invDt, system) {
    const size = this.nodes.length;
    const residual = new Float64Array(size);
    const surfaceLoss = new Float64Array(size);

    for (const node of this.nodes) {
      const index = node.index;
      residual[index] +=
        node.capacityJPerK * invDt * (trial[index] - previous[index]) - node.heatWatts;
      system?.add(index, index, node.capacityJPerK * invDt);

      if (!node.surface) continue;
      const { conductanceWPerK, radiationSlope, radiationWatts = 0 } = surfaceConductance({
        surface: node.surface,
        material: node.material,
        air: this.air,
        surfaceC: trial[index],
        ambientC: this.ambientC,
        windSpeedMPerS: this.windSpeedMPerS,
        fanRunning: node.fanRunning
      });
      const convective = conductanceWPerK * (trial[index] - this.ambientC);
      residual[index] += convective + radiationWatts;
      surfaceLoss[index] += convective + radiationWatts;
      system?.add(index, index, conductanceWPerK + radiationSlope);
    }

    for (const link of this.links) {
      const flow = link.conductanceWPerK * (trial[link.a.index] - trial[link.b.index]);
      residual[link.a.index] += flow;
      residual[link.b.index] -= flow;
      if (!system) continue;
      system.add(link.a.index, link.a.index, link.conductanceWPerK);
      system.add(link.a.index, link.b.index, -link.conductanceWPerK);
      system.add(link.b.index, link.b.index, link.conductanceWPerK);
      system.add(link.b.index, link.a.index, -link.conductanceWPerK);
    }

    for (const link of [...this.radiationLinks, ...this.dynamicLinks]) {
      const from = link.a.index;
      const to = link.b.index;
      const shared = 1 - link.transmittance;
      if (shared > 0) {
        const pair = radiation({
          emissivity: link.emissivity,
          areaM2: link.areaM2,
          viewFactor: link.viewFactor,
          surfaceC: trial[from],
          backgroundC: trial[to]
        });
        residual[from] += shared * pair.watts;
        residual[to] -= shared * pair.watts;
        if (system) {
          system.add(from, from, shared * pair.slopeSurface);
          system.add(from, to, shared * pair.slopeBackground);
          system.add(to, from, -shared * pair.slopeSurface);
          system.add(to, to, -shared * pair.slopeBackground);
        }
      }
      if (link.transmittance > 0) {
        const escaping = radiation({
          emissivity: link.emissivity,
          areaM2: link.areaM2,
          viewFactor: link.viewFactor,
          surfaceC: trial[from],
          backgroundC: this.ambientC
        });
        residual[from] += link.transmittance * escaping.watts;
        surfaceLoss[from] += link.transmittance * escaping.watts;
        system?.add(from, from, link.transmittance * escaping.slopeSurface);
      }
    }

    return { residual, surfaceLoss };
  }

  /**
   * Advance the network by `dt` seconds (`Infinity` solves the steady state).
   * Returns the largest temperature change, which the integrator uses for step control.
   */
  step(dt, { maxIterations = 60, tolerance = 1e-7 } = {}) {
    const size = this.nodes.length;
    if (size === 0) return { maxChangeC: 0, iterations: 0 };
    const invDt = Number.isFinite(dt) ? 1 / Math.max(dt, 1e-12) : 0;
    const previous = Float64Array.from(this.nodes, (node) => node.temperatureC);
    const trial = Float64Array.from(previous);
    let lastSurfaceLoss = new Float64Array(size);

    let iterations = 0;
    for (; iterations < maxIterations; iterations += 1) {
      const system = new SparseSystem(size);
      const { residual, surfaceLoss } = this.assemble(trial, previous, invDt, system);
      lastSurfaceLoss = surfaceLoss;
      for (let index = 0; index < size; index += 1) system.addRhs(index, -residual[index]);

      const step = system.solve();
      let largest = 0;
      for (let index = 0; index < size; index += 1) {
        largest = Math.max(largest, Math.abs(step[index]));
      }
      // Damp the first strides: a cold filament's linearised radiation is so weak that an
      // undamped Newton step would jump to tens of thousands of degrees and stall.
      const damping = largest > 400 ? 400 / largest : 1;
      for (let index = 0; index < size; index += 1) {
        trial[index] = Math.max(ABSOLUTE_FLOOR_C, trial[index] + damping * step[index]);
      }
      if (largest * damping < tolerance) break;
    }

    let maxChangeC = 0;
    for (const node of this.nodes) {
      maxChangeC = Math.max(maxChangeC, Math.abs(trial[node.index] - node.temperatureC));
      node.temperatureC = trial[node.index];
      node.surfaceLossWatts = lastSurfaceLoss[node.index];
    }
    return { maxChangeC, iterations };
  }

  steadyState(options) {
    return this.step(Number.POSITIVE_INFINITY, options);
  }

  /** Total heat leaving the network to ambient, W. Used by the conservation check. */
  totalSurfaceLossWatts() {
    return this.nodes.reduce((total, node) => total + node.surfaceLossWatts, 0);
  }
}

/** Per-device view of the shared network: names are local, keys are global. */
export class DeviceThermal {
  constructor({ network, deviceId, nodeNames, heatNodeName }) {
    this.network = network;
    this.deviceId = deviceId;
    this.nodeNames = nodeNames;
    this.heatNodeName = heatNodeName ?? nodeNames[0];
  }

  key(name) {
    return `${this.deviceId}##${name}`;
  }

  temperature(name = this.heatNodeName) {
    return this.network.temperature(this.key(name));
  }

  node(name = this.heatNodeName) {
    return this.network.node(this.key(name));
  }

  setHeat(name, watts) {
    this.network.setHeat(this.key(name), watts);
  }

  /** Distribute a `{ nodeName: watts }` map, zeroing any node the device did not name. */
  applyHeat(distribution) {
    for (const name of this.nodeNames) {
      this.setHeat(name, distribution[name] ?? 0);
    }
  }

  hottestTemperature() {
    return Math.max(...this.nodeNames.map((name) => this.temperature(name)));
  }
}
