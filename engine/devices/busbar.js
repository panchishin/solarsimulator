// Busbar: taps joined through the bar's real resistance at an internal node, so paralleling
// four devices on one bar is not the same as soldering them together.

import { resistivityAt } from "../core/catalog.js";
import { isOpen } from "../failure/machines.js";

export function createBusbarDevice({ base, catalog }) {
  const electrical = base.electrical;
  const nodeName = base.model.thermal.heatNode ?? Object.keys(base.model.thermal.nodes)[0];
  const material = catalog.material(base.model.thermal.nodes[nodeName].material);
  const referenceC = material.resistivityReferenceTemperatureC;
  const tapNames = base.ports.map((port) => port.name);

  base.internalNodes = ["bar"];
  base.ports = [...base.ports, { name: "bar", domain: "dc", role: "internal" }];
  base.bindings = { ...base.bindings, bar: { internal: true, node: "bar" } };
  base.galvanicGroups = [[...tapNames, "bar"]];

  return Object.assign(base, {
    state: { burnedMassKg: 0, lastAdvanceSeconds: 0 },
    mode: "ok",

    resistanceOhms(temperatureC) {
      const scale = resistivityAt(material, temperatureC) / resistivityAt(material, referenceC);
      return electrical.resistanceOhms * scale;
    },

    stamp(ctx) {
      const leakage = ctx.settings.gminSiemens;
      const resistance = this.resistanceOhms(ctx.temperature(nodeName));
      const conductance = isOpen(this) ? leakage : 1 / Math.max(resistance, 1e-12);
      for (const name of tapNames) ctx.conductance(name, "bar", conductance);
    },

    heat(ctx) {
      const resistance = isOpen(this) ? 0 : this.resistanceOhms(ctx.temperature(nodeName));
      let watts = 0;
      for (const name of tapNames) {
        const amps = this.portCurrents.get(name) ?? 0;
        watts += amps * amps * resistance;
      }
      return { [nodeName]: watts };
    },

    advance(ctx) {
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    measurements(ctx) {
      const currents = tapNames.map((name) => this.portCurrents.get(name) ?? 0);
      const throughAmps = currents.reduce((total, amps) => total + Math.max(amps, 0), 0);
      return {
        currentAmps: throughAmps,
        tapCurrents: Object.fromEntries(tapNames.map((name, index) => [name, currents[index]])),
        overRating: throughAmps > base.limitsSpec.ratedAmps,
        temperatureC: ctx.temperature(nodeName),
        heatWatts: this.heat(ctx)[nodeName],
        failure: this.failure
      };
    }
  });
}
