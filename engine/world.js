// The world: catalog + layout + environment, assembled into one netlist, one electrical solve
// and one thermal network, stepped by the adaptive integrator.

import { buildNetlist } from "./core/netlist.js";
import { Solver } from "./core/solver.js";
import { Integrator } from "./core/integrator.js";
import { GRID_SIZE_PX, componentGridSize } from "./core/geometry.js";
import {
  assertConservation,
  checkChargeConservation,
  checkConservation,
  electricalPowerWatts
} from "./core/invariants.js";
import { createComponentDevice } from "./devices/registry.js";
import { createWireDevice } from "./devices/wire.js";
import { DeviceThermal, ThermalNetwork } from "./thermal/network.js";
import {
  failureTemperatureC,
  heatOfCombustionJPerKg,
  ignitionTemperatureC
} from "./thermal/materials.js";
import {
  FailureState,
  accumulateBurn,
  burnHeatWatts,
  hottestNode,
  isBurning,
  transition
} from "./failure/machines.js";

/**
 * A world with no sun: constant ambient, no irradiance. Used by bench tests where the only
 * thing under study is the electrical or thermal behaviour.
 *
 * `planeOfArrayWPerM2` is settable so a test can hold an array at one irradiance without
 * bringing in a date, a site and a sky.
 */
export function createStaticEnvironment({
  ambientTemperatureC,
  windSpeedMPerS = 0,
  planeOfArrayWPerM2 = 0
}) {
  const zero = {
    planeOfArrayWPerM2,
    beamWPerM2: planeOfArrayWPerM2,
    skyDiffuseWPerM2: 0,
    groundReflectedWPerM2: 0,
    incidenceAngleDeg: 0
  };
  const sample = {
    ambientTemperatureC,
    windSpeedMPerS,
    planeOfArrayWPerM2,
    globalHorizontalWPerM2: planeOfArrayWPerM2,
    directNormalWPerM2: planeOfArrayWPerM2,
    diffuseHorizontalWPerM2: 0,
    extraterrestrialNormalWPerM2: 1361,
    solarElevationDeg: planeOfArrayWPerM2 > 0 ? 90 : -90,
    solarAzimuthDeg: 180,
    clearness: planeOfArrayWPerM2 > 0 ? 1 : 0,
    planeOfArray: () => zero
  };
  return { at: () => sample };
}

export class World {
  constructor({
    catalog,
    layout,
    environment,
    ambientTemperatureC,
    checkInvariants = false,
    startSeconds = 0
  }) {
    this.catalog = catalog;
    this.layout = { components: [], wires: [], joins: [], ...layout };
    this.settings = catalog.settings;
    this.fire = catalog.simulation.fire;
    this.checkInvariants = checkInvariants;
    this.timeSeconds = startSeconds;
    this.ambientTemperatureC = ambientTemperatureC ?? catalog.simulation.ambientTemperatureC;
    this.environment = environment ?? createStaticEnvironment({ ambientTemperatureC: this.ambientTemperatureC });
    this.environmentSample = this.environment.at(this.timeSeconds);

    const componentsById = new Map(this.layout.components.map((component) => [component.id, component]));
    this.componentsById = componentsById;

    this.devices = [
      ...this.layout.components.map((instance) => createComponentDevice({ catalog, instance })),
      ...this.layout.wires.map((wire) =>
        createWireDevice({ catalog, wire, componentsById, settings: this.settings })
      )
    ];
    this.deviceById = new Map(this.devices.map((device) => [device.id, device]));

    this.netlist = buildNetlist({ catalog, layout: this.layout, devices: this.devices });

    this.thermalNetwork = new ThermalNetwork({
      catalog,
      ambientC: this.environmentSample.ambientTemperatureC
    });
    for (const device of this.devices) this.attachThermal(device);

    this.solver = new Solver({
      devices: this.devices,
      netlist: this.netlist,
      settings: this.settings,
      world: this
    });
    this.context = this.solver.context;
    this.integrator = new Integrator({ world: this, settings: this.settings });
    this.boxes = new Map(this.devices.map((device) => [device.id, this.boxOf(device)]));
    this.lastSolution = null;
    this.violations = [];
  }

  attachThermal(device) {
    const network = this.thermalNetwork;
    // Equipment placed indoors sits in a conditioned space rather than in the weather. It is a
    // property of the installation, not of the component, so it comes from the layout.
    const ambientOverrideC = device.instance?.indoors
      ? this.catalog.simulation.site.indoorTemperatureC
      : null;
    for (const node of device.thermalNodes) {
      network.addNode({
        key: `${device.id}##${node.name}`,
        deviceId: device.id,
        name: node.name,
        material: node.material,
        massKg: node.massKg,
        surface: node.surface,
        runaway: node.runaway,
        ambientOverrideC
      });
    }
    for (const link of device.thermalLinks) {
      network.addLink(`${device.id}##${link.from}`, `${device.id}##${link.to}`, link.conductanceWPerK);
    }
    for (const link of device.thermalRadiationLinks) {
      network.addRadiationLink({
        ...link,
        from: `${device.id}##${link.from}`,
        to: `${device.id}##${link.to}`
      });
    }
    device.thermal = new DeviceThermal({
      network,
      deviceId: device.id,
      nodeNames: device.thermalNodes.map((node) => node.name),
      heatNodeName: device.heatNodeName
    });

    // Failure thresholds belong to individual nodes, not to devices: a lamp's filament runs at
    // 2700 C inside an envelope that fails at 525 C, so one number per device would be wrong for
    // both of them. Resolved once here from the materials, so no device type can be
    // accidentally exempted from a mechanism.
    device.thermalThresholds = device.thermalNodes.map((node) => ({
      name: node.name,
      ignitionTemperatureC: ignitionTemperatureC(node.material),
      // A node marked non-structural still ignites and still burns; it just does not disable the
      // device by softening. A conductor's insulation is the case: melted insulation is a fire
      // and a short-circuit risk, not an open circuit, and the conductor keeps carrying current
      // until it either ignites its own insulation or melts.
      failureTemperatureC: node.structural === false ? null : failureTemperatureC(node.material),
      combustibleMassKg: heatOfCombustionJPerKg(node.material) > 0 ? node.massKg : 0
    }));
    device.combustibleMassKg = device.thermalThresholds.reduce(
      (total, threshold) => total + threshold.combustibleMassKg,
      0
    );
    // A datasheet limit is a statement about the part the datasheet is about, which is the
    // device's designated heat node.
    if (device.damageTemperatureC === undefined) {
      device.damageTemperatureC = device.limitsSpec?.damageTemperatureC ?? null;
    }
  }

  /** Axis-aligned extent of a device in metres, used for fire spread. */
  boxOf(device) {
    const scale = this.catalog.simulation.metersPerGridSpace;
    if (device.kind === "wire") {
      const points = [device.bindings.a, device.bindings.b].map((binding) => {
        const component = this.componentsById.get(binding.componentId);
        return {
          x: ((component?.x ?? 0) / GRID_SIZE_PX) * scale,
          y: ((component?.y ?? 0) / GRID_SIZE_PX) * scale
        };
      });
      return {
        minX: Math.min(points[0].x, points[1].x),
        maxX: Math.max(points[0].x, points[1].x),
        minY: Math.min(points[0].y, points[1].y),
        maxY: Math.max(points[0].y, points[1].y)
      };
    }
    const instance = device.instance;
    const size = componentGridSize(device.definition, instance.rotation ?? 0);
    const minX = ((instance.x ?? 0) / GRID_SIZE_PX) * scale;
    const minY = ((instance.y ?? 0) / GRID_SIZE_PX) * scale;
    return {
      minX,
      minY,
      maxX: minX + size.width * scale,
      maxY: minY + size.height * scale
    };
  }

  gapBetween(first, second) {
    const a = this.boxes.get(first.id);
    const b = this.boxes.get(second.id);
    const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
    const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
    return Math.hypot(dx, dy);
  }

  solveNow() {
    this.environmentSample = this.environment.at(this.timeSeconds);
    this.thermalNetwork.ambientC = this.environmentSample.ambientTemperatureC;
    this.thermalNetwork.windSpeedMPerS = this.environmentSample.windSpeedMPerS;
    this.lastSolution = this.solver.solve({
      timeSeconds: this.timeSeconds,
      environment: this.environmentSample,
      ambientC: this.environmentSample.ambientTemperatureC
    });
    return this.lastSolution;
  }

  /** Heat into every thermal node, plus the fire couplings between devices. */
  applyHeat() {
    const context = this.context;
    const dynamicLinks = [];
    for (const device of this.devices) {
      context.device = device;
      const distribution = { ...device.heat(context) };
      if (isBurning(device)) {
        const { totalWatts, radiatedWatts } = burnHeatWatts(device, this.fire);
        const name = device.thermal.heatNodeName;
        distribution[name] = (distribution[name] ?? 0) + totalWatts - radiatedWatts;
        const source = hottestNode(device);
        for (const other of this.devices) {
          if (other === device || other.failure === FailureState.consumed) continue;
          const gap = this.gapBetween(device, other);
          if (gap > this.fire.flameRadiusM) continue;
          const viewFactor = 0.5 * (1 - gap / this.fire.flameRadiusM);
          if (viewFactor <= 0) continue;
          dynamicLinks.push({
            from: source.key,
            to: hottestNode(other).key,
            areaM2: source.surface?.areaM2 ?? 0.01,
            emissivity: source.material.emissivity ?? 0.9,
            viewFactor
          });
        }
      }
      device.thermal.applyHeat(distribution);

      // A fan only runs when the device is powered and hot enough to ask for it.
      for (const name of device.thermal.nodeNames) {
        const node = device.thermal.node(name);
        if (node.surface?.fanOnTemperatureC !== undefined) {
          node.fanRunning =
            node.temperatureC >= node.surface.fanOnTemperatureC && device.mode !== "off";
        }
      }
    }
    context.device = null;
    this.thermalNetwork.setDynamicLinks(dynamicLinks);
  }

  /** Every device event, plus the thermal failure events every device shares. */
  eventValues() {
    const context = this.context;
    const values = new Map();
    for (const device of this.devices) {
      context.device = device;
      for (const event of device.events(context)) {
        values.set(`${device.id}::${event.id}`, event.value);
      }
      if (device.failure === FailureState.consumed) continue;

      for (const threshold of device.thermalThresholds) {
        const temperatureC = device.thermal.temperature(threshold.name);
        if (threshold.ignitionTemperatureC !== null && threshold.combustibleMassKg > 0) {
          values.set(
            `${device.id}::__ignition#${threshold.name}`,
            temperatureC - threshold.ignitionTemperatureC
          );
        }
        if (threshold.failureTemperatureC !== null) {
          values.set(
            `${device.id}::__material-failure#${threshold.name}`,
            temperatureC - threshold.failureTemperatureC
          );
        }
      }
      if (device.damageTemperatureC !== null && device.damageTemperatureC !== undefined) {
        values.set(
          `${device.id}::__thermal-damage`,
          device.thermal.temperature() - device.damageTemperatureC
        );
      }
      if (isBurning(device)) {
        values.set(
          `${device.id}::__burn-through`,
          (device.state.burnedMassKg ?? 0) - device.combustibleMassKg
        );
      }
    }
    context.device = null;
    return values;
  }

  /**
   * One step of exactly `dt` seconds. Returns the state changes the integrator needs plus any
   * event functions that changed sign, which the integrator bisects before applying.
   */
  stepFixed(dt) {
    const solution = this.solveNow();
    const before = this.eventValues();
    const chargeBefore = new Map();
    for (const device of this.devices) {
      if (device.kind !== "battery") continue;
      this.context.device = device;
      const amps = device.portCurrents.get("positive") ?? 0;
      chargeBefore.set(device.id, {
        stateOfCharge: device.state.stateOfCharge,
        capacityAh: device.nominalCapacityAh(),
        effectiveAmps:
          amps >= 0 ? device.electrical.coulombicEfficiency * amps : amps
      });
    }
    this.context.device = null;

    const socBefore = new Map(
      this.devices
        .filter((device) => device.kind === "battery")
        .map((device) => [device.id, device.state.stateOfCharge])
    );
    const damageBefore = new Map(
      this.devices.map((device) => [device.id, device.state.damage ?? device.state.overloadDamage ?? 0])
    );

    this.applyHeat();
    const violations = this.checkInvariants
      ? checkConservation({
          devices: this.devices,
          ctx: this.context,
          tolerance: this.settings.conservation
        })
      : [];

    const thermalResult = this.thermalNetwork.step(dt);

    const context = this.context;
    for (const device of this.devices) {
      context.device = device;
      device.advance(context, dt);
      accumulateBurn(device, dt, this.fire);
    }
    context.device = null;

    const after = this.eventValues();
    const crossings = [];
    for (const [key, value] of after) {
      const previous = before.get(key);
      if (previous === undefined) continue;
      if (previous < 0 && value >= 0) {
        const split = key.indexOf("::");
        crossings.push({
          deviceId: key.slice(0, split),
          eventId: key.slice(split + 2),
          before: previous,
          after: value
        });
      }
    }

    let maxStateOfChargeChange = 0;
    for (const [id, previous] of socBefore) {
      maxStateOfChargeChange = Math.max(
        maxStateOfChargeChange,
        Math.abs(this.deviceById.get(id).state.stateOfCharge - previous)
      );
    }
    let maxDamageChange = 0;
    for (const [id, previous] of damageBefore) {
      const device = this.deviceById.get(id);
      const now = device.state.damage ?? device.state.overloadDamage ?? 0;
      maxDamageChange = Math.max(maxDamageChange, Math.abs(now - previous));
    }

    if (this.checkInvariants) {
      violations.push(
        ...checkChargeConservation({
          devices: this.devices,
          before: chargeBefore,
          dt,
          tolerance: this.settings.conservation
        })
      );
      assertConservation(violations);
    }
    this.violations = violations;
    this.timeSeconds += dt;

    return {
      dt,
      solution,
      crossings,
      violations,
      maxTemperatureChangeC: thermalResult.maxChangeC,
      maxStateOfChargeChange,
      maxDamageChange
    };
  }

  applyCrossings(crossings) {
    const context = this.context;
    for (const { deviceId, eventId } of crossings) {
      const device = this.deviceById.get(deviceId);
      context.device = device;
      const [kind, nodeName] = eventId.split("#");
      if (kind === "__ignition") {
        transition(device, FailureState.burning, `${nodeName} reached its ignition temperature`);
      } else if (kind === "__material-failure") {
        transition(device, FailureState.damaged, `${nodeName} melted or softened`);
      } else if (kind === "__thermal-damage") {
        transition(
          device,
          FailureState.damaged,
          `${device.thermal.heatNodeName} exceeded ${device.damageTemperatureC} C`
        );
      } else if (kind === "__burn-through") {
        transition(device, FailureState.consumed, "burned through");
      } else {
        device.onEvent(eventId, context);
      }
    }
    context.device = null;
  }

  /** Advance real time by `seconds`, adaptively. */
  advance(seconds) {
    return this.integrator.advance(seconds);
  }

  advanceMinutes(minutes) {
    return this.advance(minutes * 60);
  }

  snapshot() {
    return {
      timeSeconds: this.timeSeconds,
      voltages: Float64Array.from(this.context.voltages),
      temperatures: this.thermalNetwork.temperatures(),
      devices: this.devices.map((device) => ({
        id: device.id,
        state: structuredClone(device.state),
        mode: device.mode,
        failure: device.failure,
        damageMode: device.damageMode,
        historyLength: device.failureHistory.length
      }))
    };
  }

  restore(snapshot) {
    this.timeSeconds = snapshot.timeSeconds;
    this.context.voltages = Float64Array.from(snapshot.voltages);
    this.thermalNetwork.restoreTemperatures(snapshot.temperatures);
    for (const entry of snapshot.devices) {
      const device = this.deviceById.get(entry.id);
      device.state = structuredClone(entry.state);
      device.mode = entry.mode;
      device.failure = entry.failure;
      device.damageMode = entry.damageMode;
      device.failureHistory.length = entry.historyLength;
    }
  }

  device(id) {
    const device = this.deviceById.get(id);
    if (!device) throw new RangeError(`Unknown device "${id}"`);
    return device;
  }

  measure(id) {
    const device = this.device(id);
    this.context.device = device;
    const measurements = device.measurements(this.context);
    this.context.device = null;
    return measurements;
  }

  /** Hazards are read out of device state, never inferred from the shape of the netlist. */
  hazards() {
    const hazards = [];
    const add = (type, message, deviceIds, severity = "warning") =>
      hazards.push({ type, message, deviceIds, severity });

    for (const device of this.devices) {
      const name = device.name ?? `${device.kind} ${device.id.slice(0, 6)}`;
      const measurements = this.measure(device.id);
      if (device.failure === FailureState.burning) {
        add("fire", `${name} is burning.`, [device.id], "critical");
      } else if (device.failure === FailureState.consumed) {
        add("destroyed", `${name} has burned through and is open.`, [device.id], "critical");
      } else if (device.failure === FailureState.damaged) {
        const how = device.damageMode === "short" ? "shorted" : "open";
        add("damaged", `${name} is damaged (${how}).`, [device.id], "critical");
      } else if (device.failure === FailureState.tripped) {
        add("tripped", `${name} has opened its circuit.`, [device.id], "warning");
      }

      if (device.kind === "wire" && measurements.overInsulationRating) {
        add(
          "wire-over-temperature",
          `${name} insulation is at ${measurements.insulationTemperatureC.toFixed(0)} °C, above its ${measurements.insulationRatingC} °C rating.`,
          [device.id]
        );
      }
      if (device.kind === "battery" && measurements.runaway) {
        add("thermal-runaway", `${name} is in thermal runaway.`, [device.id], "critical");
      }
      if (device.kind === "battery" && !measurements.contactorClosed && device.failure === FailureState.ok) {
        add("bms-disconnect", `${name} BMS has disconnected the pack.`, [device.id]);
      }
      if (device.kind === "inverter") {
        if (measurements.reversePolarity) {
          add(
            "reverse-polarity",
            `${name} DC input is reversed; its body diodes are conducting ${Math.abs(measurements.currentAmps).toFixed(0)} A.`,
            [device.id],
            "critical"
          );
        }
        if (measurements.tripReason) {
          add("inverter-trip", `${name} shut down: ${measurements.tripReason}.`, [device.id]);
        } else if (measurements.currentLimited) {
          add("inverter-overload", `${name} is in output current limit.`, [device.id]);
        }
      }
      if ((device.kind === "switch" || device.kind === "busbar") && measurements.overRating) {
        add("over-rating", `${name} is carrying more than its rated current.`, [device.id]);
      }
      if (device.kind === "chargeController" && device.mode === "off" && device.failure === FailureState.ok) {
        add("controller-off", `${name} has stopped charging.`, [device.id]);
      }
    }

    // Advisory only. Bonding an inverter's AC neutral to the DC negative is normal practice,
    // and a genuine cross-domain fault shows up above as a damaged device or a blown fuse,
    // because the current it draws goes through the same solve as everything else.
    for (const island of this.netlist.mixedDomainIslands) {
      const componentIds = new Set();
      for (const net of island.nets) {
        for (const terminal of net.terminals) componentIds.add(terminal.componentId);
      }
      add(
        "mixed-domain",
        `AC and DC are conductively connected (${[...island.domains].sort().join(" and ")}).`,
        [...componentIds]
      );
    }
    if (this.lastSolution?.chattered) {
      add("solver", "Devices are fighting for control; the operating point is unstable.", []);
    }
    return hazards;
  }

  report() {
    const context = this.context;
    const devices = {};
    let storedWh = 0;
    let generatedWatts = 0;
    let loadWatts = 0;
    let heatWatts = 0;

    for (const device of this.devices) {
      context.device = device;
      const measurements = device.measurements(context);
      devices[device.id] = {
        kind: device.kind,
        name: device.name ?? device.kind,
        mode: device.mode,
        failure: device.failure,
        ...measurements
      };
      if (device.kind === "battery") storedWh += measurements.energyWh ?? 0;
      if (device.kind === "pv") generatedWatts += Math.max(measurements.powerWatts ?? 0, 0);
      if (device.kind === "load") loadWatts += measurements.powerWatts ?? 0;
      heatWatts += Object.values(device.heat(context)).reduce((total, watts) => total + watts, 0);
    }
    context.device = null;

    return {
      timeSeconds: this.timeSeconds,
      elapsedMinutes: this.timeSeconds / 60,
      environment: this.environmentSample,
      devices,
      hazards: this.hazards(),
      totals: { storedWh, generatedWatts, loadWatts, heatWatts },
      solver: {
        iterations: this.lastSolution?.iterations ?? 0,
        modePasses: this.lastSolution?.passes ?? 0,
        residualNorm: this.lastSolution?.residualNorm ?? 0,
        chattered: this.lastSolution?.chattered ?? false
      },
      violations: this.violations
    };
  }
}

export const createWorld = (options) => new World(options);
