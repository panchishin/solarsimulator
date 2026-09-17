// Inverter: an isolated converter with a regulated AC output behind its real output impedance,
// a datasheet efficiency curve, an inverse-time overload trip, DC under/over-voltage protection
// with restart hysteresis, thermal derate, and body diodes that conduct on reverse polarity.
//
// The DC draw depends on the AC node voltages and the AC output sags with DC voltage, and both
// couplings are in the Jacobian, so a battery that cannot hold up the bus limits AC output
// inside the same Newton solve. See engine/PHYSICS.md section 7.

import { clamp, interpolate, limitedExponential, thermalVoltage } from "../core/units.js";
import { advanceDamage, tripSeconds } from "../failure/tripCurves.js";
import { FailureState, isOpen, transition } from "../failure/machines.js";

const DC_POSITIVE = "dc-positive";
const DC_NEGATIVE = "dc-negative";
const AC_LINE = "ac-line";
const AC_NEUTRAL = "ac-neutral";
const DIODE_NODE = "body-diode";

export function createInverterDevice({ base, catalog }) {
  const electrical = base.electrical;
  const limits = base.limitsSpec;
  const diode = electrical.bodyDiode;
  const nodeName = base.heatNodeName;
  const outputCurrentLimitAmps = electrical.peakOutputWatts / electrical.outputVoltage;

  base.internalNodes = [DIODE_NODE];
  base.ports = [...base.ports, { name: DIODE_NODE, domain: "dc", role: "internal" }];
  base.bindings = { ...base.bindings, [DIODE_NODE]: { internal: true, node: DIODE_NODE } };
  base.galvanicGroups = [
    [DC_POSITIVE, DC_NEGATIVE, DIODE_NODE],
    [AC_LINE, AC_NEUTRAL]
  ];

  return Object.assign(base, {
    state: {
      overloadDamage: 0,
      restartAtSeconds: -Infinity,
      reverseEnergyJoules: 0,
      tripReason: null,
      energyWh: 0,
      burnedMassKg: 0,
      lastAdvanceSeconds: 0
    },
    mode: "on",

    /** Continuous rating after thermal derate, W. */
    ratedOutputWatts(temperatureC) {
      const span = limits.derateEndC - limits.derateStartC;
      const factor = clamp((limits.derateEndC - temperatureC) / span, 0, 1);
      return electrical.continuousOutputWatts * factor;
    },

    efficiency(convertedWatts, temperatureC) {
      const fraction = clamp(convertedWatts / electrical.continuousOutputWatts, 0, 1.5);
      const base = interpolate(electrical.efficiencyCurve, fraction, "loadFraction", "efficiency");
      const shifted = base + electrical.efficiencyTempCoefficientPerC * (temperatureC - 25);
      return clamp(shifted, 0.3, 0.999);
    },

    /** AC output current out of `ac-line`, and the internal converted power, at this point. */
    operatingPoint(ctx) {
      const acVolts = ctx.across(AC_LINE, AC_NEUTRAL);
      const resistance = electrical.outputResistanceOhms;
      if (this.mode === "off" || isOpen(this)) {
        return { acVolts, outAmps: 0, convertedWatts: 0, slopeOutPerAcVolt: 0 };
      }
      if (this.mode === "currentLimited") {
        const outAmps = outputCurrentLimitAmps;
        return {
          acVolts,
          outAmps,
          convertedWatts: (acVolts + outAmps * resistance) * outAmps,
          slopeOutPerAcVolt: 0
        };
      }
      const setVolts = electrical.outputVoltage;
      const outAmps = (setVolts - acVolts) / resistance;
      return {
        acVolts,
        outAmps,
        convertedWatts: setVolts * outAmps,
        slopeOutPerAcVolt: -1 / resistance
      };
    },

    seed() {
      return { [AC_LINE]: this.mode === "off" ? 0 : electrical.outputVoltage };
    },

    stamp(ctx) {
      const leakage = ctx.settings.gminSiemens;
      const dcVolts = ctx.across(DC_POSITIVE, DC_NEGATIVE);

      // Body diodes: present in every state, because they are silicon, not firmware.
      const diodeVolts = ctx.across(DC_NEGATIVE, DIODE_NODE);
      const thermal = diode.idealityFactor * thermalVoltage(ctx.temperature(nodeName));
      const exponential = limitedExponential(diodeVolts / thermal);
      const diodeAmps = diode.saturationCurrentAmps * (exponential.value - 1);
      const diodeSlope = (diode.saturationCurrentAmps * exponential.slope) / thermal;
      ctx.current(DC_NEGATIVE, DIODE_NODE, diodeAmps, [
        [DC_NEGATIVE, diodeSlope],
        [DIODE_NODE, -diodeSlope]
      ]);
      ctx.conductance(DIODE_NODE, DC_POSITIVE, 1 / Math.max(diode.seriesResistanceOhms, 1e-9));

      if (this.mode === "off" || isOpen(this)) {
        ctx.conductance(DC_POSITIVE, DC_NEGATIVE, leakage);
        ctx.conductance(AC_LINE, AC_NEUTRAL, leakage);
        return;
      }

      const heatsinkC = ctx.temperature(nodeName);
      const point = this.operatingPoint(ctx);

      if (this.mode === "currentLimited") {
        ctx.current(AC_LINE, AC_NEUTRAL, -point.outAmps, []);
        ctx.conductance(AC_LINE, AC_NEUTRAL, leakage);
      } else {
        ctx.thevenin(AC_LINE, AC_NEUTRAL, electrical.outputVoltage, electrical.outputResistanceOhms);
      }

      // DC draw. A switching input is a constant-power sink only while the bus holds up; it
      // cannot pull power out of a collapsed or reversed bus, so below a knee voltage the input
      // is resistive. That is what the hardware does, and it also keeps Newton from chasing a
      // division by a vanishing voltage on its way to the answer.
      const knee = Math.max(limits.underVoltageTrip * 0.5, 1);
      const efficiency = this.efficiency(Math.max(point.convertedWatts, 0), heatsinkC);
      const inputWatts =
        electrical.idleDrawWatts + Math.max(point.convertedWatts, 0) / efficiency;

      if (dcVolts <= knee) {
        const g = inputWatts / (knee * knee);
        const amps = g * Math.max(dcVolts, 0);
        ctx.current(DC_POSITIVE, DC_NEGATIVE, amps, [
          [DC_POSITIVE, dcVolts > 0 ? g : 0],
          [DC_NEGATIVE, dcVolts > 0 ? -g : 0]
        ]);
        return;
      }

      const drawAmps = inputWatts / dcVolts;
      const slopePerDcVolt = -drawAmps / dcVolts;
      const slopePerAcVolt =
        point.convertedWatts > 0
          ? (electrical.outputVoltage * point.slopeOutPerAcVolt) / (efficiency * dcVolts)
          : 0;
      ctx.current(DC_POSITIVE, DC_NEGATIVE, drawAmps, [
        [DC_POSITIVE, slopePerDcVolt],
        [DC_NEGATIVE, -slopePerDcVolt],
        [AC_LINE, slopePerAcVolt],
        [AC_NEUTRAL, -slopePerAcVolt]
      ]);
    },

    limits(ctx) {
      if (isOpen(this)) return "off";
      const dcVolts = ctx.across(DC_POSITIVE, DC_NEGATIVE);
      const heatsinkC = ctx.temperature(nodeName);
      const now = ctx.timeSeconds;

      if (this.mode !== "off") {
        if (dcVolts <= limits.underVoltageTrip) {
          this.state.tripReason = "dc-under-voltage";
          this.state.restartAtSeconds = now + limits.restartDelaySeconds;
          return "off";
        }
        if (dcVolts >= limits.overVoltageTrip) {
          this.state.tripReason = "dc-over-voltage";
          this.state.restartAtSeconds = now + limits.restartDelaySeconds;
          return "off";
        }
        if (heatsinkC >= limits.shutdownC) {
          this.state.tripReason = "over-temperature";
          this.state.restartAtSeconds = now + limits.restartDelaySeconds;
          return "off";
        }
        if (this.state.overloadDamage >= 1) {
          this.state.tripReason = "overload";
          this.state.restartAtSeconds = now + limits.restartDelaySeconds;
          return "off";
        }

        const point = this.operatingPoint(ctx);
        if (this.mode === "currentLimited") {
          const recovered = point.acVolts >= electrical.outputVoltage * 0.98;
          return recovered ? "on" : "currentLimited";
        }
        return point.outAmps > outputCurrentLimitAmps ? "currentLimited" : "on";
      }

      const restorable =
        dcVolts >= limits.underVoltageRestart &&
        dcVolts <= limits.overVoltageRestart &&
        heatsinkC < limits.derateStartC &&
        this.state.overloadDamage < 1;
      return restorable && now >= this.state.restartAtSeconds ? "on" : "off";
    },

    /** Losses, W: idle, conversion, output impedance and body-diode conduction. */
    lossWatts(ctx) {
      const diodeAmps = this.portCurrents.get(DIODE_NODE) ?? 0;
      const diodeLoss = Math.abs(ctx.across(DC_NEGATIVE, DC_POSITIVE) * diodeAmps);
      if (this.mode === "off" || isOpen(this)) return diodeLoss;
      const heatsinkC = ctx.temperature(nodeName);
      const point = this.operatingPoint(ctx);
      const converted = Math.max(point.convertedWatts, 0);
      const efficiency = this.efficiency(converted, heatsinkC);
      const terminalWatts = point.acVolts * point.outAmps;
      return electrical.idleDrawWatts + converted / efficiency - terminalWatts + diodeLoss;
    },

    heat(ctx) {
      return { [nodeName]: this.lossWatts(ctx) };
    },

    advance(ctx, dt) {
      const heatsinkC = ctx.temperature(nodeName);
      const point = this.operatingPoint(ctx);
      const outputWatts = Math.max(point.acVolts * point.outAmps, 0);
      this.state.energyWh += (outputWatts * dt) / 3600;

      const rated = Math.max(this.ratedOutputWatts(heatsinkC), 1e-6);
      this.state.overloadDamage = advanceDamage({
        damage: this.state.overloadDamage,
        currentAmps: outputWatts,
        ratedAmps: rated,
        curve: limits.overloadCurve,
        holdMultiple: 1,
        thermalTimeConstantSeconds: 300,
        dt
      });

      const diodeAmps = this.portCurrents.get(DIODE_NODE) ?? 0;
      const reverseWatts = Math.abs(ctx.across(DC_NEGATIVE, DC_POSITIVE) * diodeAmps);
      if (ctx.across(DC_POSITIVE, DC_NEGATIVE) < 0) {
        this.state.reverseEnergyJoules += reverseWatts * dt;
      }
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events(ctx) {
      const events = [{ id: "overload-trip", value: this.state.overloadDamage - 1 }];
      if (limits.reversePolarityDamageJoules !== undefined) {
        events.push({
          id: "reverse-polarity-damage",
          value: this.state.reverseEnergyJoules - limits.reversePolarityDamageJoules
        });
      }
      return events;
    },

    onEvent(id) {
      if (id === "overload-trip") {
        this.state.tripReason = "overload";
        this.mode = "off";
      }
      if (id === "reverse-polarity-damage") {
        // The body diodes short: the inverter becomes a low-resistance path across the battery,
        // which is exactly what blows an upstream fuse.
        this.damageMode = "short";
        transition(this, FailureState.damaged, "reverse polarity destroyed the H-bridge");
      }
    },

    measurements(ctx) {
      const point = this.operatingPoint(ctx);
      const dcAmps = this.portCurrents.get(DC_POSITIVE) ?? 0;
      const dcVolts = ctx.across(DC_POSITIVE, DC_NEGATIVE);
      const heatsinkC = ctx.temperature(nodeName);
      const outputWatts = Math.max(point.acVolts * point.outAmps, 0);
      const inputWatts = dcVolts * dcAmps;
      return {
        dcVoltage: dcVolts,
        currentAmps: dcAmps,
        acVoltage: point.acVolts,
        acCurrentAmps: point.outAmps,
        outputWatts,
        powerWatts: inputWatts,
        efficiency: inputWatts > 0 ? outputWatts / inputWatts : 0,
        loadFraction: outputWatts / electrical.continuousOutputWatts,
        ratedOutputWatts: this.ratedOutputWatts(heatsinkC),
        overloadDamage: this.state.overloadDamage,
        secondsToOverloadTrip: tripSeconds(
          limits.overloadCurve,
          outputWatts / Math.max(this.ratedOutputWatts(heatsinkC), 1e-6),
          1
        ),
        operating: this.mode !== "off" && !isOpen(this),
        currentLimited: this.mode === "currentLimited",
        tripReason: this.mode === "off" ? this.state.tripReason : null,
        reversePolarity: dcVolts < -0.5,
        reverseEnergyJoules: this.state.reverseEnergyJoules,
        temperatureC: heatsinkC,
        heatWatts: this.lossWatts(ctx),
        energyWh: this.state.energyWh,
        failure: this.failure
      };
    }
  });
}
