// Fuse: an inverse-time damage integral against the datasheet time-current curve. Once it
// opens it stays open, and the branch conductance really is leakage.

import { resistivityAt } from "../core/catalog.js";
import { advanceDamage, tripSeconds } from "../failure/tripCurves.js";
import { FailureState, transition } from "../failure/machines.js";

export function createFuseDevice({ base, catalog }) {
  const electrical = base.electrical;
  const limits = base.limitsSpec;
  const nodeName = base.model.thermal.heatNode ?? Object.keys(base.model.thermal.nodes)[0];
  const material = catalog.material(base.model.thermal.nodes[nodeName].material);
  const referenceC = material.resistivityReferenceTemperatureC;

  return Object.assign(base, {
    state: { damage: 0, blown: false, burnedMassKg: 0, lastAdvanceSeconds: 0 },
    mode: "ok",
    ratedAmps: electrical.ratedAmps,

    resistanceOhms(temperatureC) {
      const scale = resistivityAt(material, temperatureC) / resistivityAt(material, referenceC);
      return electrical.coldResistanceOhms * scale;
    },

    stamp(ctx) {
      if (this.state.blown) {
        ctx.conductance("a", "b", ctx.settings.gminSiemens);
        return;
      }
      ctx.conductance("a", "b", 1 / Math.max(this.resistanceOhms(ctx.temperature(nodeName)), 1e-12));
    },

    limits() {
      return this.state.blown ? "open" : "ok";
    },

    heat(ctx) {
      if (this.state.blown) return { [nodeName]: 0 };
      const amps = this.portCurrents.get("a") ?? 0;
      return { [nodeName]: amps * amps * this.resistanceOhms(ctx.temperature(nodeName)) };
    },

    advance(ctx, dt) {
      if (this.state.blown) return;
      this.state.damage = advanceDamage({
        damage: this.state.damage,
        currentAmps: this.portCurrents.get("a") ?? 0,
        ratedAmps: electrical.ratedAmps,
        curve: limits.timeCurrentCurve,
        holdMultiple: limits.holdMultiple ?? 1,
        thermalTimeConstantSeconds: limits.thermalTimeConstantSeconds,
        dt
      });
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events() {
      return this.state.blown ? [] : [{ id: "blow", value: this.state.damage - 1 }];
    },

    onEvent(id) {
      if (id !== "blow") return;
      this.state.blown = true;
      this.state.damage = 1;
      this.mode = "open";
      transition(this, FailureState.tripped, "melting integral reached the rated value");
    },

    /** A blown fuse cannot be reset; replacing it is a layout change. */
    reset() {
      return false;
    },

    measurements(ctx) {
      const amps = this.portCurrents.get("a") ?? 0;
      const multiple = Math.abs(amps) / electrical.ratedAmps;
      return {
        currentAmps: amps,
        multipleOfRating: multiple,
        damage: this.state.damage,
        secondsToTrip: tripSeconds(limits.timeCurrentCurve, multiple, limits.holdMultiple ?? 1),
        blown: this.state.blown,
        temperatureC: ctx.temperature(nodeName),
        heatWatts: this.heat(ctx)[nodeName],
        failure: this.failure
      };
    }
  });
}
