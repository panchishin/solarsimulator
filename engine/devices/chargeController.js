// Charge controller, MPPT or PWM.
//
// MPPT: the input is regulated to a tracking reference that perturb-and-observe moves along the
// array's actual I-V curve; the output is whichever of maximum power, current limit or stage
// voltage regulation is binding. PWM: a duty-cycled pass element, so the array is dragged down
// to battery voltage and the loss on a 36-cell panel is emergent rather than assumed.
//
// See engine/PHYSICS.md section 6.

import { clamp, interpolate, ramp, softCorner, softMin } from "../core/units.js";
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
      bindingLoop: null,
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

    /**
     * Charge current limit after thermal derate, A. The taper stops at `derateFloorFraction`:
     * a hot controller throttles its charge current but keeps delivering until it shuts down,
     * and a limit of zero below `shutdownC` would stall charging while the device still reports
     * itself as running.
     */
    chargeCurrentLimitAmps(temperatureC) {
      const span = limits.derateEndC - limits.derateStartC;
      const floor = limits.derateFloorFraction ?? 0;
      const taper = clamp((limits.derateEndC - temperatureC) / span, 0, 1);
      return electrical.maxChargeCurrentAmps * (floor + (1 - floor) * taper);
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

    /**
     * Perturb and observe acts once per call, so a step longer than this would quietly turn the
     * tracker into something slower than the hardware it stands for.
     */
    maxStepSeconds() {
      return isMppt ? electrical.tracking.maxIntegrationStepSeconds : null;
    },

    stamp(ctx) {
      const leakage = ctx.settings.gminSiemens;
      // The negative rails are bonded inside the controller: it is not an isolated converter.
      ctx.conductance(PV_NEGATIVE, BATTERY_NEGATIVE, 1 / Math.max(bondResistance, 1e-12));
      // The voltage sense dividers are across both ports in every mode, including off: the
      // controller has to measure array and pack voltage to do anything at all. They are also what
      // keeps those nodes defined. Without the input divider, a dark array feeding a tracker that
      // has not yet chosen a reference is a pure open circuit; without the output one, a pack that
      // has stopped accepting charge leaves the output rail floating between two elements that
      // both carry no current.
      ctx.conductance(PV_POSITIVE, PV_NEGATIVE, 1 / electrical.inputBleedResistanceOhms);
      ctx.conductance(BATTERY_POSITIVE, BATTERY_NEGATIVE, 1 / electrical.outputBleedResistanceOhms);

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
      // Before the tracker has chosen a reference it is not loading the array: it is measuring the
      // open-circuit voltage it will start from. An unset reference therefore has to mean "draw
      // nothing" rather than "draw at zero error", which would sit exactly on the corner.
      const reference = this.state.referenceVolts ?? Number.POSITIVE_INFINITY;

      // An MPPT runs three control loops at once: hold the array at the tracking reference, hold
      // the output at the stage voltage, and hold the output current at the charge limit. The
      // hardware obeys whichever one binds, so the model takes the minimum of the three rather
      // than switching between modes. Rounding each corner over the loops' error band is what
      // lets Newton see the transitions at all; with hard corners the iteration oscillates
      // between two branches that each look right to the linearisation.
      const band = electrical.inputRegulationBandVolts;

      // Input loop: draw current in proportion to how far the array sits above the reference.
      const corner = softCorner(inputVolts - reference, band);
      const inputConductance = corner.slope / electrical.controlResistanceOhms;
      const inputAmps = corner.value / electrical.controlResistanceOhms;
      ctx.current(PV_POSITIVE, PV_NEGATIVE, inputAmps, [
        [PV_POSITIVE, inputConductance],
        [PV_NEGATIVE, -inputConductance]
      ]);

      // What that input can put on the output, after conversion losses and self-consumption.
      const efficiency = this.efficiency(inputVolts * inputAmps);
      const availableWatts = Math.max(
        efficiency * inputVolts * inputAmps - electrical.idleDrawWatts,
        0
      );
      const availableAmps = availableWatts / outputVolts;
      const availablePerInputVolt =
        availableWatts > 0
          ? (efficiency * (inputAmps + inputVolts * inputConductance)) / outputVolts
          : 0;
      // Delivering a fixed power means the current falls as the output voltage rises: a negative
      // incremental conductance on the output node, which is what a converter really presents.
      const availablePerOutputVolt = availableWatts > 0 ? -availableAmps / outputVolts : 0;

      // Current loop: a flat ceiling on the output, derated by heatsink temperature. It competes
      // with what the array can supply, and the hardware obeys whichever is lower. The handover
      // band is a fraction of the current where the two meet, so the same rounding works at a
      // milliamp after sunset and at the 50 A rating.
      const limitAmps = this.chargeCurrentLimitAmps(ctx.temperature(nodeName));
      const scale = Math.max(
        Math.abs(availableAmps),
        Math.abs(limitAmps),
        electrical.loopCurrentFloorAmps
      );
      const capped = softMin(availableAmps, limitAmps, scale * electrical.loopCurrentBandFraction);
      let deliveredAmps = capped.value;
      let perInputVolt = capped.slopeA * availablePerInputVolt;
      let perOutputVolt = capped.slopeA * availablePerOutputVolt;

      // Stage loop. A charge controller holding a stage voltage does it by backing its duty cycle
      // off as the target approaches, so the model tapers the delivered current to zero across the
      // regulation window rather than computing a current from a headroom voltage. That keeps the
      // output-voltage derivative bounded by delivered/window and, more importantly, valid across
      // the whole window: a stiff regulator expressed as a current gives a linearisation good over
      // a fraction of a millivolt, and Newton then cannot move at all. Until the controller has
      // measured the pack it has no target, so it does not regulate.
      if (this.state.nominalMultiple !== null) {
        const window = electrical.outputRegulationBandVolts;
        const taper = ramp((this.stageTargetVolts() - outputVolts) / window);
        perInputVolt *= taper.value;
        perOutputVolt = taper.value * perOutputVolt - (deliveredAmps * taper.slope) / window;
        deliveredAmps *= taper.value;
      }

      // Delivered current leaves the device at the battery terminal, so it enters as a negative.
      ctx.current(BATTERY_POSITIVE, BATTERY_NEGATIVE, -deliveredAmps, [
        [PV_POSITIVE, -perInputVolt],
        [PV_NEGATIVE, perInputVolt],
        [BATTERY_POSITIVE, -perOutputVolt],
        [BATTERY_NEGATIVE, perOutputVolt]
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
      // An MPPT has no regulating modes to switch into: all three of its loops are stamped at
      // once and the solve decides which one binds. Only the shutdown states are discrete.
      return isMppt ? "tracking" : this.state.stage;
    },

    /** Which of the three control loops is setting the output, for reporting. */
    bindingLoop(ctx) {
      if (this.mode === "off" || isOpen(this) || !isMppt) return null;
      const delivered = -(this.portCurrents.get(BATTERY_POSITIVE) ?? 0);
      if (delivered <= 0) return "none";
      const heatsinkC = ctx.temperature(nodeName);
      if (delivered >= this.chargeCurrentLimitAmps(heatsinkC) * 0.99) return "current-limit";
      const outputVolts = ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE);
      // Inside the regulation window the stage loop is the one tapering the output back.
      if (
        this.state.nominalMultiple !== null &&
        outputVolts >= this.stageTargetVolts() - electrical.outputRegulationBandVolts
      ) {
        return "stage-voltage";
      }
      return "maximum-power";
    },

    /** Loss in the internal negative-rail bond, W. */
    bondLossWatts(ctx) {
      // From the voltage across the bond, not from the negative port current: that port also
      // carries the input return current, so using it would double-count.
      const volts = ctx.across(PV_NEGATIVE, BATTERY_NEGATIVE);
      return (volts * volts) / Math.max(bondResistance, 1e-12);
    },

    /** Loss in the two voltage sense dividers, W. */
    bleedLossWatts(ctx) {
      const inputVolts = ctx.across(PV_POSITIVE, PV_NEGATIVE);
      const outputVolts = ctx.across(BATTERY_POSITIVE, BATTERY_NEGATIVE);
      return (
        (inputVolts * inputVolts) / electrical.inputBleedResistanceOhms +
        (outputVolts * outputVolts) / electrical.outputBleedResistanceOhms
      );
    },

    heat(ctx) {
      // The negative bond joins two ports, so its loss never appears in the difference between
      // input and delivered power and always has to be added. The sense divider is different: it
      // draws its current through the PV terminals, so wherever the loss is computed as input
      // minus delivered it is already counted, and adding it again would invent heat.
      const bondLoss = this.bondLossWatts(ctx);
      if (this.mode === "off" || isOpen(this)) {
        return { [nodeName]: bondLoss + this.bleedLossWatts(ctx) };
      }
      if (!isMppt) {
        const passAmps = this.portCurrents.get(PV_POSITIVE) ?? 0;
        const passResistance =
          this.state.duty > 0 ? electrical.onResistanceOhms / this.state.duty : 0;
        return {
          [nodeName]:
            passAmps * passAmps * passResistance +
            electrical.idleDrawWatts +
            bondLoss +
            this.bleedLossWatts(ctx)
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
        const loop = this.bindingLoop(ctx);
        this.state.bindingLoop = loop;
        if (loop === "maximum-power" && this.state.sinceTrackSeconds >= tracking.intervalSeconds) {
          const inputWatts = this.inputWatts(ctx);
          if (inputWatts < this.state.lastInputWatts) this.state.trackingDirection *= -1;
          this.state.referenceVolts = clamp(
            (this.state.referenceVolts ?? 0) + this.state.trackingDirection * tracking.stepVolts,
            1,
            electrical.maxInputVoltage
          );
          this.state.lastInputWatts = inputWatts;
          this.state.sinceTrackSeconds = 0;
        } else if (loop !== "maximum-power") {
          // Perturbing is pointless when something other than array power is setting the output:
          // the observation carries no information about the maximum power point, and stepping on
          // regardless would walk the reference off to a stale voltage. Park it where the array
          // actually sits so power limiting resumes from the right place.
          const inputVolts = ctx.across(PV_POSITIVE, PV_NEGATIVE);
          if (inputVolts > 1) this.state.referenceVolts = inputVolts;
          this.state.lastInputWatts = this.inputWatts(ctx);
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
        bindingLoop: isMppt ? this.bindingLoop(ctx) : null,
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
