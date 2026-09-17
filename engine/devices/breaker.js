// Thermal-magnetic breaker: the same inverse-time band as a fuse, plus an instantaneous
// magnetic element, plus a manual reset.

import { resistivityAt } from "../core/catalog.js";
import { advanceDamage, magneticTripped, tripSeconds } from "../failure/tripCurves.js";
import { FailureState, transition } from "../failure/machines.js";

export function createBreakerDevice({ base, catalog }) {
  const electrical = base.electrical;
  const limits = base.limitsSpec;
  const nodeName = base.model.thermal.heatNode ?? Object.keys(base.model.thermal.nodes)[0];
  const material = catalog.material(base.model.thermal.nodes[nodeName].material);
  const referenceC = material.resistivityReferenceTemperatureC;
  const startsClosed = limits.startsClosed ?? true;

  return Object.assign(base, {
    state: {
      damage: 0,
      tripped: !startsClosed,
      magneticSeconds: 0,
      burnedMassKg: 0,
      lastAdvanceSeconds: 0
    },
    mode: startsClosed ? "closed" : "open",
    ratedAmps: electrical.ratedAmps,

    resistanceOhms(temperatureC) {
      const scale = resistivityAt(material, temperatureC) / resistivityAt(material, referenceC);
      return electrical.coldResistanceOhms * scale;
    },

    stamp(ctx) {
      if (this.state.tripped) {
        ctx.conductance("a", "b", ctx.settings.gminSiemens);
        return;
      }
      ctx.conductance("a", "b", 1 / Math.max(this.resistanceOhms(ctx.temperature(nodeName)), 1e-12));
    },

    limits() {
      return this.state.tripped ? "open" : "closed";
    },

    heat(ctx) {
      if (this.state.tripped) return { [nodeName]: 0 };
      const amps = this.portCurrents.get("a") ?? 0;
      return { [nodeName]: amps * amps * this.resistanceOhms(ctx.temperature(nodeName)) };
    },

    advance(ctx, dt) {
      if (this.state.tripped) return;
      const amps = this.portCurrents.get("a") ?? 0;
      this.state.damage = advanceDamage({
        damage: this.state.damage,
        currentAmps: amps,
        ratedAmps: electrical.ratedAmps,
        curve: limits.timeCurrentCurve,
        holdMultiple: limits.holdMultiple ?? 1,
        thermalTimeConstantSeconds: limits.thermalTimeConstantSeconds,
        dt
      });
      const inMagneticRegion = magneticTripped({
        currentAmps: amps,
        ratedAmps: electrical.ratedAmps,
        magneticMultiple: limits.magneticMultiple
      });
      this.state.magneticSeconds = inMagneticRegion ? this.state.magneticSeconds + dt : 0;
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events() {
      if (this.state.tripped) return [];
      return [
        { id: "thermal-trip", value: this.state.damage - 1 },
        { id: "magnetic-trip", value: this.state.magneticSeconds - limits.magneticTripSeconds }
      ];
    },

    onEvent(id) {
      if (id !== "thermal-trip" && id !== "magnetic-trip") return;
      this.state.tripped = true;
      this.mode = "open";
      transition(
        this,
        FailureState.tripped,
        id === "magnetic-trip" ? "instantaneous magnetic trip" : "inverse-time thermal trip"
      );
    },

    /** Manual reset: the mechanism is fine, the operator has to close it again. */
    reset() {
      this.state.tripped = false;
      this.state.damage = 0;
      this.state.magneticSeconds = 0;
      this.mode = "closed";
      this.failure = FailureState.ok;
      return true;
    },

    measurements(ctx) {
      const amps = this.portCurrents.get("a") ?? 0;
      const multiple = Math.abs(amps) / electrical.ratedAmps;
      return {
        currentAmps: amps,
        multipleOfRating: multiple,
        damage: this.state.damage,
        secondsToTrip: tripSeconds(limits.timeCurrentCurve, multiple, limits.holdMultiple ?? 1),
        tripped: this.state.tripped,
        temperatureC: ctx.temperature(nodeName),
        heatWatts: this.heat(ctx)[nodeName],
        failure: this.failure
      };
    }
  });
}
