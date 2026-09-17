// Charge controller, MPPT or PWM.
//
// MPPT: the input is regulated to a tracking reference that perturb-and-observe moves along the
// array's actual I-V curve; the output is whichever of maximum power, current limit or stage
// voltage regulation is binding. PWM: a duty-cycled pass element, so the array is dragged down
// to battery voltage and the loss on a 36-cell panel is emergent rather than assumed.
//
// See engine/PHYSICS.md section 6.

import { clamp, interpolate } from "../core/units.js";
import { FailureState, isOpen, transition } from "../failure/machines.js";

const PV_POSITIVE = "pv-positive";
const PV_NEGATIVE = "pv-negative";
const BATTERY_POSITIVE = "battery-positive";
const BATTERY_NEGATIVE = "battery-negative";

const STAGE_BULK = "bulk";
const STAGE_ABSORB = "absorb";
const STAGE_FLOAT = "float";

export function createChargeControllerDevice({ base }) {
  const electrical = base.electrical;
  const limits = base.limitsSpec;
  const stages = electrical.stages;
  const isMppt = base.model.topology === "mppt";
  const nodeName = base.heatNodeName;
  const bondResistance = electrical.negativeBondResistanceOhms;

  return Object.assign(base, {
    state: {
      referenceVolts: null,
      trackingDirection: 1,
      lastInputWatts: 0,
      sinceTrackSeconds: 0,
      duty: 1,
      stage: STAGE_BULK,
      absorbSeconds: 0,
      nominalMultiple: null,
      energyWh: 0,
      burnedMassKg: 0,
      lastAdvanceSeconds: 0
    },
    mode: isMppt ? "tracking" : "bulk",
    topology: base.model.topology,

    stageTargetVolts() {
      const multiple = this.state.nominalMultiple ?? 1;
      const absorb = stages.absorbVoltagePer12V * multiple;
      const float = stages.floatVoltagePer12V * multiple;
      return this.state.stage === STAGE_FLOAT ? float : absorb;
    },

    chargeCurrentLimitAmps(temperatureC) {
      const span = limits.derateEndC - limits.derateStartC;
      const derate = clamp((limits.derateEndC - temperatureC) / span, 0, 1);
      return electrical.maxChargeCurrentAmps * derate;
    },

    efficiency(watts) {
      if (!electrical.efficiencyCurve) return 1;
      const rated = electrical.maxChargeCurrentAmps * 12 * (this.state.nominalMultiple ?? 1);
      const fraction = clamp(watts / Math.max(rated, 1e-6), 0.01, 1.2);
      return interpolate(electrical.efficiencyCurve, fraction, "loadFraction", "efficiency");
    },

    seed() {
      return {};
    },

    stamp(ctx) {
      const leakage = ctx.settings.gminSiemens;
      // The negative rails are bonded inside the controller: it is not an isolated converter.
      ctx.conductance(PV_NEGATIVE, BATTERY_NEGATIVE, 1 / Math.max(bondResistance, 1e-12));

      if (this.mode === "off" || isOpen(this)) {
        ctx.conductance(PV_POSITIVE, PV_NEGATIVE, leakage);
        ctx.conductance(BATTERY_POSITIVE, BATTERY_NEGATIVE, leakage);
        return;
      }

      if (!isMppt) {
        const conductance = this.state.duty / Math.max(electrical.onResistanceOhms, 1e-9);
        ctx.conductance(PV_POSITIVE, BATTERY_POSITIVE, Math.max(conductance, leakage));
        const outputVolts = Math.max(ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE), 1);
        const idleAmps = electrical.idleDrawWatts / outputVolts;
        ctx.current(BATTERY_POSITIVE, BATTERY_NEGATIVE, idleAmps, [
          [BATTERY_POSITIVE, -idleAmps / outputVolts],
          [BATTERY_NEGATIVE, idleAmps / outputVolts]
        ]);
        return;
      }

      const inputVolts = ctx.across(PV_POSITIVE, PV_NEGATIVE);
      const outputVolts = Math.max(ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE), 1);
      const reference = this.state.referenceVolts ?? inputVolts;

      if (this.mode === "tracking") {
        const above = inputVolts > reference;
        const conductance = above ? 1 / electrical.controlResistanceOhms : leakage;
        const inputAmps = conductance * (inputVolts - reference);
        ctx.current(PV_POSITIVE, PV_NEGATIVE, inputAmps, [
          [PV_POSITIVE, conductance],
          [PV_NEGATIVE, -conductance]
        ]);

        const inputWatts = inputVolts * inputAmps;
        const efficiency = this.efficiency(inputWatts);
        const delivered = Math.max(efficiency * inputWatts - electrical.idleDrawWatts, 0);
        const outputAmps = -delivered / outputVolts;
        const perInputVolt = -(efficiency * (inputAmps + inputVolts * conductance)) / outputVolts;
        const perOutputVolt = delivered / (outputVolts * outputVolts);
        ctx.current(BATTERY_POSITIVE, BATTERY_NEGATIVE, outputAmps, [
          [PV_POSITIVE, perInputVolt],
          [PV_NEGATIVE, -perInputVolt],
          [BATTERY_POSITIVE, perOutputVolt],
          [BATTERY_NEGATIVE, -perOutputVolt]
        ]);
        return;
      }

      // Regulating modes: the output is the constraint and the input power follows from it.
      let deliveredAmps;
      let perOutputVoltDelivered;
      if (this.mode === "currentLimited") {
        deliveredAmps = this.chargeCurrentLimitAmps(ctx.temperature(nodeName));
        perOutputVoltDelivered = 0;
        ctx.current(BATTERY_POSITIVE, BATTERY_NEGATIVE, -deliveredAmps, []);
        ctx.conductance(BATTERY_POSITIVE, BATTERY_NEGATIVE, leakage);
      } else {
        const target = this.stageTargetVolts();
        const regulation = electrical.outputRegulationResistanceOhms;
        deliveredAmps = (target - outputVolts) / regulation;
        perOutputVoltDelivered = -1 / regulation;
        ctx.thevenin(BATTERY_POSITIVE, BATTERY_NEGATIVE, target, regulation);
      }

      const deliveredWatts = outputVolts * deliveredAmps;
      const efficiency = this.efficiency(Math.max(deliveredWatts, 0));
      const requiredWatts = Math.max(deliveredWatts, 0) / efficiency + electrical.idleDrawWatts;
      const usableInputVolts = Math.max(inputVolts, 1);
      const inputAmps = requiredWatts / usableInputVolts;
      const perInputVolt = inputVolts > 1 ? -inputAmps / usableInputVolts : 0;
      const perOutputVolt =
        deliveredWatts > 0
          ? (deliveredAmps + outputVolts * perOutputVoltDelivered) /
            (efficiency * usableInputVolts)
          : 0;
      ctx.current(PV_POSITIVE, PV_NEGATIVE, inputAmps, [
        [PV_POSITIVE, perInputVolt],
        [PV_NEGATIVE, -perInputVolt],
        [BATTERY_POSITIVE, perOutputVolt],
        [BATTERY_NEGATIVE, -perOutputVolt]
      ]);
    },

    deliveredWatts(ctx) {
      const amps = this.portCurrents.get(BATTERY_POSITIVE) ?? 0;
      return -ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE) * amps;
    },

    inputWatts(ctx) {
      const amps = this.portCurrents.get(PV_POSITIVE) ?? 0;
      return ctx.across(PV_POSITIVE, PV_NEGATIVE) * amps;
    },

    limits(ctx) {
      if (isOpen(this)) return "off";
      const inputVolts = ctx.across(PV_POSITIVE, PV_NEGATIVE);
      const outputVolts = ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE);
      const heatsinkC = ctx.temperature(nodeName);

      // Both of these change what `stamp` does, so the solver has to be told to solve again
      // rather than record currents from a state it never solved.
      if (this.state.nominalMultiple === null && outputVolts > 6) {
        this.state.nominalMultiple = clamp(Math.round(outputVolts / 12), 1, 4);
        ctx.requestResolve();
      }
      if (this.state.referenceVolts === null && inputVolts > 1) {
        // Real trackers start from an open-circuit sweep; 80 % of Voc is the classic opening bid.
        this.state.referenceVolts = 0.8 * inputVolts;
        ctx.requestResolve();
      }

      if (inputVolts > electrical.maxInputVoltage || heatsinkC >= limits.shutdownC) return "off";
      if (this.mode === "off") {
        const recovered =
          inputVolts <= electrical.maxInputVoltage * 0.95 && heatsinkC < limits.derateStartC;
        return recovered ? (isMppt ? "tracking" : "bulk") : "off";
      }
      if (!isMppt) return this.state.stage;

      const target = this.stageTargetVolts();
      const currentLimit = this.chargeCurrentLimitAmps(heatsinkC);
      const delivered = -(this.portCurrents.get(BATTERY_POSITIVE) ?? 0);

      if (outputVolts >= target && this.state.stage !== STAGE_BULK) return "voltageLimited";
      if (outputVolts >= target) return "voltageLimited";
      if (this.mode === "voltageLimited") {
        return outputVolts < target - 0.05 * target ? "tracking" : "voltageLimited";
      }
      if (delivered > currentLimit * 1.001) return "currentLimited";
      if (this.mode === "currentLimited") {
        return inputVolts >= 0.98 * (this.state.referenceVolts ?? inputVolts) * 1.2
          ? "tracking"
          : "currentLimited";
      }
      return "tracking";
    },

    /** Loss in the internal negative-rail bond, W. */
    bondLossWatts(ctx) {
      // From the voltage across the bond, not from the negative port current: that port also
      // carries the input return current, so using it would double-count.
      const volts = ctx.across(PV_NEGATIVE, BATTERY_NEGATIVE);
      return (volts * volts) / Math.max(bondResistance, 1e-12);
    },

    heat(ctx) {
      const bondLoss = this.bondLossWatts(ctx);
      if (this.mode === "off" || isOpen(this)) return { [nodeName]: bondLoss };
      if (!isMppt) {
        const passAmps = this.portCurrents.get(PV_POSITIVE) ?? 0;
        const passResistance =
          this.state.duty > 0 ? electrical.onResistanceOhms / this.state.duty : 0;
        return {
          [nodeName]: passAmps * passAmps * passResistance + electrical.idleDrawWatts + bondLoss
        };
      }
      const input = Math.max(this.inputWatts(ctx), 0);
      const delivered = Math.max(this.deliveredWatts(ctx), 0);
      return { [nodeName]: Math.max(input - delivered, 0) + bondLoss };
    },

    advance(ctx, dt) {
      const delivered = this.deliveredWatts(ctx);
      const deliveredAmps = -(this.portCurrents.get(BATTERY_POSITIVE) ?? 0);
      const outputVolts = ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE);
      this.state.energyWh += (Math.max(delivered, 0) * dt) / 3600;

      const target = this.stageTargetVolts();
      const tail = stages.tailCurrentFraction * electrical.maxChargeCurrentAmps;
      if (this.state.stage === STAGE_BULK && outputVolts >= target - 0.01) {
        this.state.stage = STAGE_ABSORB;
        this.state.absorbSeconds = 0;
      } else if (this.state.stage === STAGE_ABSORB) {
        this.state.absorbSeconds += dt;
        if (deliveredAmps < tail || this.state.absorbSeconds >= stages.absorbHoldSeconds) {
          this.state.stage = STAGE_FLOAT;
        }
      } else if (this.state.stage === STAGE_FLOAT) {
        const float = stages.floatVoltagePer12V * (this.state.nominalMultiple ?? 1);
        if (outputVolts < float - 0.5) this.state.stage = STAGE_BULK;
      }

      if (isMppt) {
        this.state.sinceTrackSeconds += dt;
        const tracking = electrical.tracking;
        if (this.mode === "tracking" && this.state.sinceTrackSeconds >= tracking.intervalSeconds) {
          const inputWatts = this.inputWatts(ctx);
          if (inputWatts < this.state.lastInputWatts) this.state.trackingDirection *= -1;
          this.state.referenceVolts = clamp(
            (this.state.referenceVolts ?? 0) + this.state.trackingDirection * tracking.stepVolts,
            1,
            electrical.maxInputVoltage
          );
          this.state.lastInputWatts = inputWatts;
          this.state.sinceTrackSeconds = 0;
        } else if (this.mode !== "tracking") {
          // Leave the reference where the array actually is, so returning to tracking does not
          // start from a stale operating point.
          const inputVolts = ctx.across(PV_POSITIVE, PV_NEGATIVE);
          if (inputVolts > 1) this.state.referenceVolts = inputVolts;
        }
      } else {
        const limitAmps = this.chargeCurrentLimitAmps(ctx.temperature(nodeName));
        const overVoltage = outputVolts > target;
        const overCurrent = deliveredAmps > limitAmps;
        const stepPerSecond = 0.2;
        const step = stepPerSecond * Math.min(dt, 5);
        this.state.duty = clamp(
          overVoltage || overCurrent ? this.state.duty - step : this.state.duty + step,
          0,
          1
        );
      }
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events(ctx) {
      const events = [];
      if (limits.overVoltageDamageMultiple !== undefined) {
        events.push({
          id: "input-over-voltage",
          value:
            ctx.across(PV_POSITIVE, PV_NEGATIVE) -
            electrical.maxInputVoltage * limits.overVoltageDamageMultiple
        });
      }
      if (limits.damageTemperatureC !== undefined) {
        events.push({
          id: "controller-overheat",
          value: ctx.temperature(nodeName) - limits.damageTemperatureC
        });
      }
      return events;
    },

    onEvent(id) {
      if (id === "input-over-voltage") {
        transition(this, FailureState.damaged, "PV input voltage above the controller's rating");
      }
      if (id === "controller-overheat") {
        transition(this, FailureState.damaged, "controller exceeded its temperature limit");
      }
    },

    measurements(ctx) {
      const input = this.inputWatts(ctx);
      const delivered = this.deliveredWatts(ctx);
      return {
        inputVoltage: ctx.across(PV_POSITIVE, PV_NEGATIVE),
        inputCurrentAmps: this.portCurrents.get(PV_POSITIVE) ?? 0,
        inputWatts: input,
        outputVoltage: ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE),
        currentAmps: -(this.portCurrents.get(BATTERY_POSITIVE) ?? 0),
        powerWatts: delivered,
        efficiency: input > 0 ? delivered / input : 0,
        stage: this.state.stage,
        mode: this.mode,
        duty: isMppt ? null : this.state.duty,
        referenceVolts: this.state.referenceVolts,
        temperatureC: ctx.temperature(nodeName),
        heatWatts: this.heat(ctx)[nodeName],
        energyWh: this.state.energyWh,
        failure: this.failure
      };
    }
  });
}
