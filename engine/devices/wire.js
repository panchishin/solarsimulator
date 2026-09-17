// Wire: a real two-port device with gauge, length, temperature-dependent resistance and its
// own conductor and insulation thermal nodes. Ampacity is not looked up anywhere; it falls out
// of the thermal solve.

import { resistivityAt } from "../core/catalog.js";
import { wireLengthMeters } from "../core/geometry.js";
import { FailureState, isOpen, transition } from "../failure/machines.js";
import { DEVICE_DEFAULTS } from "./defaults.js";

export function createWireDevice({ catalog, wire, componentsById, settings }) {
  const wireType = catalog.wireType(wire.wireTypeId ?? catalog.defaultWireTypeId);
  const gauge = catalog.gauge(wireType.gauge);
  const conductorMaterial = catalog.material(wireType.conductorMaterial);
  const insulationMaterial = catalog.material(wireType.insulationMaterial);

  const lengthM = wireLengthMeters(catalog, componentsById, wire);
  const areaM2 = gauge.areaMm2 * 1e-6;
  const conductorDiameterM = gauge.conductorDiameterMm * 1e-3;
  const outerDiameterM = wireType.model.insulationOuterDiameterMm * 1e-3;
  const insulationAreaM2 = (Math.PI / 4) * (outerDiameterM ** 2 - conductorDiameterM ** 2);

  const conductorMassKg = conductorMaterial.densityKgPerM3 * areaM2 * lengthM;
  const insulationMassKg = insulationMaterial.densityKgPerM3 * insulationAreaM2 * lengthM;
  // Radial conduction through a hollow cylinder: G = 2*pi*k*L / ln(Do/Di).
  const radialConductanceWPerK =
    (2 * Math.PI * insulationMaterial.thermalConductivityWPerMK * lengthM) /
    Math.log(outerDiameterM / conductorDiameterM);

  return {
    ...DEVICE_DEFAULTS,
    id: wire.id,
    kind: "wire",
    name: `${wireType.name} (${lengthM.toFixed(2)} m)`,
    catalog,
    wireTypeId: wireType.id,
    lengthM,
    areaM2,
    mode: "ok",
    failure: FailureState.ok,
    damageMode: "open",
    damageTemperatureC: null,
    insulationRatingC: wireType.model.insulationRatingC,
    failureHistory: [],
    state: { burnedMassKg: 0, lastAdvanceSeconds: 0 },
    portCurrents: new Map(),

    ports: [
      { name: "a", domain: null, role: "pass-a" },
      { name: "b", domain: null, role: "pass-b" }
    ],
    bindings: { a: wire.from, b: wire.to },
    galvanicGroups: [["a", "b"]],
    internalNodes: [],

    thermalNodes: [
      { name: "conductor", material: conductorMaterial, massKg: conductorMassKg },
      {
        name: "insulation",
        material: insulationMaterial,
        massKg: insulationMassKg,
        surface: {
          geometry: "horizontalCylinder",
          areaM2: Math.PI * outerDiameterM * lengthM,
          characteristicLengthM: outerDiameterM
        }
      }
    ],
    thermalLinks: [
      { from: "conductor", to: "insulation", conductanceWPerK: radialConductanceWPerK }
    ],
    thermalRadiationLinks: [],
    heatNodeName: "conductor",

    resistanceOhms(temperatureC) {
      return (resistivityAt(conductorMaterial, temperatureC) * this.lengthM) / this.areaM2;
    },

    stamp(ctx) {
      if (isOpen(this)) {
        ctx.conductance("a", "b", ctx.settings.gminSiemens);
        return;
      }
      const resistance = this.resistanceOhms(ctx.temperature("conductor"));
      ctx.conductance("a", "b", 1 / Math.max(resistance, 1e-12));
    },

    heat(ctx) {
      const amps = this.portCurrents.get("a") ?? 0;
      const resistance = isOpen(this)
        ? 0
        : this.resistanceOhms(ctx.temperature("conductor"));
      return { conductor: amps * amps * resistance, insulation: 0 };
    },

    events(ctx) {
      const events = [];
      const melting = conductorMaterial.meltingPointC;
      if (melting !== undefined && this.failure !== FailureState.consumed) {
        events.push({ id: "conductor-melt", value: ctx.temperature("conductor") - melting });
      }
      return events;
    },

    onEvent(id) {
      if (id === "conductor-melt") {
        transition(this, FailureState.consumed, "conductor melted");
      }
    },

    measurements(ctx) {
      const amps = this.portCurrents.get("a") ?? 0;
      const conductorC = ctx.temperature("conductor");
      return {
        currentAmps: amps,
        voltageDropVolts: ctx.across("a", "b"),
        resistanceOhms: this.resistanceOhms(conductorC),
        heatWatts: amps * amps * this.resistanceOhms(conductorC),
        conductorTemperatureC: conductorC,
        insulationTemperatureC: ctx.temperature("insulation"),
        insulationRatingC: this.insulationRatingC,
        overInsulationRating: ctx.temperature("insulation") > this.insulationRatingC,
        lengthMeters: this.lengthM,
        failure: this.failure
      };
    }
  };
}
