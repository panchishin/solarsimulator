// Inverter: an isolated converter with a regulated AC output behind its real output impedance,
// a datasheet efficiency curve, an inverse-time overload trip, DC under/over-voltage protection
// with restart hysteresis, thermal derate, and body diodes that conduct on reverse polarity.
//
// The DC draw depends on the AC node voltages and the AC output sags with DC voltage, and both
// couplings are in the Jacobian, so a battery that cannot hold up the bus limits AC output
// inside the same Newton solve. See engine/PHYSICS.md section 7.

import {
  clamp,
  interpolate,
  limitedExponential,
  ramp,
  softMin,
  thermalVoltage
} from "../core/units.js";
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

    /**
     * Continuous rating after thermal derate, W.
     *
     * The taper stops at `derateFloorFraction` rather than reaching zero. Derating sheds load to
     * protect the output stage, and hardware holds a reduced output right up to the temperature it
     * shuts down at. A rating of zero below `shutdownC` makes any output an infinite multiple of
     * rating, so the inverse-time overload accumulator saturates instantly and trips the inverter
     * before the thermal shutdown can: the over-temperature path becomes unreachable and a genuine
     * overheat is reported as an overload.
     */
    ratedOutputWatts(temperatureC) {
      const span = limits.derateEndC - limits.derateStartC;
      const floor = limits.derateFloorFraction ?? 0;
      const taper = clamp((limits.derateEndC - temperatureC) / span, 0, 1);
      return electrical.continuousOutputWatts * (floor + (1 - floor) * taper);
    },

    efficiency(convertedWatts, temperatureC) {
      const fraction = clamp(convertedWatts / electrical.continuousOutputWatts, 0, 1.5);
      const base = interpolate(electrical.efficiencyCurve, fraction, "loadFraction", "efficiency");
      const shifted = base + electrical.efficiencyTempCoefficientPerC * (temperatureC - 25);
      return clamp(shifted, 0.3, 0.999);
    },

    /**
     * The largest output the bridge can synthesise from the bus it is on, V, and its slope.
     *
     * A bridge and transformer are wound to hold the output set point at the lowest input voltage
     * the inverter is rated for, which is its under-voltage cutoff: that ratio is the hardware.
     * Above the cutoff there is headroom and the regulator holds the set point; below it the
     * output droops with the bus, which is what makes the input stop behaving as a constant-power
     * sink on a collapsing bus. Holding 120 V into a 5 V bus is the thing no inverter can do, and
     * assuming it can leaves the DC side with no solution at all.
     */
    outputCeiling(dcVolts) {
      const perDcVolt = electrical.outputVoltage / limits.underVoltageTrip;
      return { volts: Math.max(dcVolts, 0) * perDcVolt, perDcVolt: dcVolts > 0 ? perDcVolt : 0 };
    },

    /** AC output current out of `ac-line`, and the internal converted power, at this point. */
    operatingPoint(ctx) {
      const acVolts = ctx.across(AC_LINE, AC_NEUTRAL);
      const resistance = electrical.outputResistanceOhms;
      const idle = {
        acVolts,
        setVolts: 0,
        outAmps: 0,
        convertedWatts: 0,
        window: 0,
        slopeOutPerAcVolt: 0,
        slopeSetPerDcVolt: 0,
        slopeWindowPerDcVolt: 0
      };
      if (this.mode === "off" || isOpen(this)) return idle;
      if (this.mode === "currentLimited") {
        const outAmps = outputCurrentLimitAmps;
        return {
          ...idle,
          setVolts: acVolts + outAmps * resistance,
          outAmps,
          convertedWatts: (acVolts + outAmps * resistance) * outAmps,
          window: 1
        };
      }
      const dcVolts = ctx.across(DC_POSITIVE, DC_NEGATIVE);
      const ceiling = this.outputCeiling(dcVolts);
      const held = softMin(
        electrical.outputVoltage,
        ceiling.volts,
        electrical.outputRegulationBandVolts
      );
      const window = this.inputWindow(dcVolts);
      const setVolts = held.value * window.value;
      const outAmps = (setVolts - acVolts) / resistance;
      return {
        acVolts,
        setVolts,
        outAmps,
        convertedWatts: setVolts * outAmps,
        window: window.value,
        slopeOutPerAcVolt: -1 / resistance,
        slopeSetPerDcVolt:
          held.slopeB * ceiling.perDcVolt * window.value + held.value * window.perDcVolt,
        slopeWindowPerDcVolt: window.perDcVolt
      };
    },

    /**
     * How much of its input window the bus is inside, 0 to 1, and the slope.
     *
     * Above the input over-voltage limit the bridge stops switching: it stops producing and it
     * stops drawing, control electronics included. Modelling it as still drawing its no-load
     * power there would leave a constant-power sink on a bus nothing is holding up, and a
     * constant-power sink has no operating point on a bus nothing is holding up, so Newton walks
     * off to kilovolts looking for one. The taper is the protection's own hysteresis band, which
     * is a number the datasheet publishes rather than a smoothing constant.
     */
    inputWindow(dcVolts) {
      const width = Math.max(limits.overVoltageTrip - limits.overVoltageRestart, 1e-6);
      const { value, slope } = ramp((limits.overVoltageTrip - dcVolts) / width);
      return { value, perDcVolt: -slope / width };
    },

    seed() {
      return { [AC_LINE]: this.mode === "off" ? 0 : electrical.outputVoltage };
    },

    /**
     * The H-bridge body diodes as seen from the DC terminals: current out of `dc-negative` into
     * the internal node, and the derivative. Silicon, so it is present in every mode.
     */
    diodeBranch(ctx) {
      const volts = ctx.across(DC_NEGATIVE, DIODE_NODE);
      const thermal = diode.idealityFactor * thermalVoltage(ctx.temperature(nodeName));
      const { value, slope } = limitedExponential(volts / thermal);
      return {
        amps: diode.saturationCurrentAmps * (value - 1),
        conductance: (diode.saturationCurrentAmps * slope) / thermal
      };
    },

    stamp(ctx) {
      const leakage = ctx.settings.gminSiemens;
      const dcVolts = ctx.across(DC_POSITIVE, DC_NEGATIVE);

      // The input capacitor bank and the resistor that discharges it. Both are present in every
      // mode, and together they are what gives the input a voltage in the instant after its
      // supply opens: the bank holds the charge it had, and the constant-power input drains it.
      ctx.capacitance(DC_POSITIVE, DC_NEGATIVE, electrical.inputCapacitanceFarads);
      ctx.conductance(DC_POSITIVE, DC_NEGATIVE, 1 / electrical.inputBleedResistanceOhms);

      // Body diodes: present in every state, because they are silicon, not firmware.
      const { amps: diodeAmps, conductance: diodeSlope } = this.diodeBranch(ctx);
      ctx.current(DC_NEGATIVE, DIODE_NODE, diodeAmps, [
        [DC_NEGATIVE, diodeSlope],
        [DIODE_NODE, -diodeSlope]
      ]);
      ctx.conductance(DIODE_NODE, DC_POSITIVE, 1 / Math.max(diode.seriesResistanceOhms, 1e-9));

      if (this.mode === "off" || isOpen(this)) {
        ctx.conductance(AC_LINE, AC_NEUTRAL, leakage);
        return;
      }

      const heatsinkC = ctx.temperature(nodeName);
      const point = this.operatingPoint(ctx);

      if (this.mode === "currentLimited") {
        ctx.current(AC_LINE, AC_NEUTRAL, -point.outAmps, []);
        ctx.conductance(AC_LINE, AC_NEUTRAL, leakage);
      } else {
        // A Thevenin source whose voltage depends on the DC bus, so it is stamped as its
        // conductance plus a current source that the DC nodes appear in.
        const outputConductance = 1 / electrical.outputResistanceOhms;
        ctx.conductance(AC_LINE, AC_NEUTRAL, outputConductance);
        const sourceAmps = point.setVolts * outputConductance;
        const perDcVolt = point.slopeSetPerDcVolt * outputConductance;
        ctx.current(AC_NEUTRAL, AC_LINE, sourceAmps, [
          [DC_POSITIVE, perDcVolt],
          [DC_NEGATIVE, -perDcVolt]
        ]);
      }

      // DC draw. A switching input is a constant-power sink only inside its input window: it
      // cannot pull power out of a collapsed or reversed bus, so below a knee voltage the input is
      // resistive, and above its over-voltage limit it stops switching. That is what the hardware
      // does, and it also keeps Newton from chasing a division by a vanishing voltage or a sink
      // with no operating point on its way to the answer.
      const knee = Math.max(limits.underVoltageTrip * 0.5, 1);
      const efficiency = this.efficiency(Math.max(point.convertedWatts, 0), heatsinkC);
      const inputWatts = this.inputWatts(point, efficiency);

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
      // The draw depends on the bus three times over: directly, through the output set point once
      // the bus can no longer hold it, and through the window it shuts down in.
      const convertedPerDcVolt =
        point.convertedWatts > 0
          ? (point.slopeSetPerDcVolt * (2 * point.setVolts - point.acVolts)) /
            electrical.outputResistanceOhms
          : 0;
      const wattsPerDcVolt =
        electrical.idleDrawWatts * point.slopeWindowPerDcVolt + convertedPerDcVolt / efficiency;
      const slopePerDcVolt = -drawAmps / dcVolts + wattsPerDcVolt / dcVolts;
      const slopePerAcVolt =
        point.convertedWatts > 0
          ? (point.setVolts * point.slopeOutPerAcVolt) / (efficiency * dcVolts)
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

    /**
     * Power into the input capacitor bank, W. The solver's companion model is what the port
     * currents report, so the energy balance has to be stated the same way.
     */
    storedPowerWatts(ctx) {
      if (!(ctx.dt > 0)) return 0;
      const volts = ctx.across(DC_POSITIVE, DC_NEGATIVE);
      const change = volts - ctx.acrossPrevious(DC_POSITIVE, DC_NEGATIVE);
      return ((electrical.inputCapacitanceFarads * change) / ctx.dt) * volts;
    },

    /** Losses, W: idle, conversion, output impedance and body-diode conduction. */
    lossWatts(ctx) {
      // The branch current, not the internal node's net current: the diode and its series
      // resistance meet there, so KCL makes the net zero and the branch's dissipation vanish.
      const diodeLoss = Math.abs(
        ctx.across(DC_NEGATIVE, DC_POSITIVE) * this.diodeBranch(ctx).amps
      );
      const bleedLoss =
        ctx.across(DC_POSITIVE, DC_NEGATIVE) ** 2 / electrical.inputBleedResistanceOhms;
      if (this.mode === "off" || isOpen(this)) return diodeLoss + bleedLoss;
      const heatsinkC = ctx.temperature(nodeName);
      const point = this.operatingPoint(ctx);
      const converted = Math.max(point.convertedWatts, 0);
      const efficiency = this.efficiency(converted, heatsinkC);
      const terminalWatts = point.acVolts * point.outAmps;
      return this.inputWatts(point, efficiency) - terminalWatts + diodeLoss + bleedLoss;
    },

    /** DC input power at this operating point, W: the no-load draw plus what it is converting. */
    inputWatts(point, efficiency) {
      return (
        electrical.idleDrawWatts * point.window + Math.max(point.convertedWatts, 0) / efficiency
      );
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

      const reverseWatts = Math.abs(
        ctx.across(DC_NEGATIVE, DC_POSITIVE) * this.diodeBranch(ctx).amps
      );
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

    onEvent(id, ctx) {
      if (id === "overload-trip") {
        this.state.tripReason = "overload";
        this.mode = "off";
        // The shutdown is latched for the restart delay. Without it the accumulator, which cools
        // as soon as the output is dead, drops below 1 on the next step and the inverter restarts
        // into the same overload, over and over, at the event bisection's resolution.
        this.state.restartAtSeconds = ctx.timeSeconds + limits.restartDelaySeconds;
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
