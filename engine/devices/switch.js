// Manual switch or battery disconnect. Open means leakage conductance, not a deleted branch.

import { resistivityAt } from "../core/catalog.js";
import { isOpen } from "../failure/machines.js";

export function createSwitchDevice({ base, catalog }) {
  const electrical = base.electrical;
  const nodeName = base.model.thermal.heatNode ?? Object.keys(base.model.thermal.nodes)[0];
  const material = catalog.material(base.model.thermal.nodes[nodeName].material);
  const referenceC = material.resistivityReferenceTemperatureC;

  return Object.assign(base, {
    state: {
      closed: base.instance?.state?.closed ?? electrical.startsClosed ?? true,
      burnedMassKg: 0,
      lastAdvanceSeconds: 0
    },
    mode: (base.instance?.state?.closed ?? electrical.startsClosed ?? true) ? "closed" : "open",

    setClosed(closed) {
      this.state.closed = closed;
      this.mode = closed ? "closed" : "open";
    },

    resistanceOhms(temperatureC) {
      const scale = resistivityAt(material, temperatureC) / resistivityAt(material, referenceC);
      return electrical.closedResistanceOhms * scale;
    },

    stamp(ctx) {
      if (!this.state.closed || isOpen(this)) {
        ctx.conductance("a", "b", ctx.settings.gminSiemens);
        return;
      }
      ctx.conductance("a", "b", 1 / Math.max(this.resistanceOhms(ctx.temperature(nodeName)), 1e-12));
    },

    limits() {
      return this.state.closed && !isOpen(this) ? "closed" : "open";
    },

    heat(ctx) {
      const amps = this.portCurrents.get("a") ?? 0;
      const resistance = this.mode === "closed" ? this.resistanceOhms(ctx.temperature(nodeName)) : 0;
      return { [nodeName]: amps * amps * resistance };
    },

    advance(ctx) {
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    measurements(ctx) {
      const amps = this.portCurrents.get("a") ?? 0;
      return {
        currentAmps: amps,
        voltageDropVolts: ctx.across("a", "b"),
        closed: this.state.closed && !isOpen(this),
        overRating: Math.abs(amps) > base.limitsSpec.ratedAmps,
        temperatureC: ctx.temperature(nodeName),
        heatWatts: this.heat(ctx)[nodeName],
        failure: this.failure
      };
    }
  });
}
