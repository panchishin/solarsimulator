// Loads. Four behaviours, all of them with an operating window and a thermal consequence:
//
//  constantPower       an electronic load: I = P/V while supplied
//  constantResistance  a heating element, with the alloy's temperature coefficient
//  incandescent        R follows filament temperature, so cold inrush is emergent
//  compressor          duty-cycled, with locked-rotor inrush at every start
//
// See engine/PHYSICS.md section 8.

import { resistivityAt } from "../core/catalog.js";
import { FailureState, isOpen, transition } from "../failure/machines.js";

const SUPPLY_ROLES = new Set(["ac-line", "positive"]);
const RETURN_ROLES = new Set(["ac-neutral", "negative"]);

export function createLoadDevice({ base, catalog }) {
  // A load is the same device whether it is fed from an inverter or straight off the DC bus, so
  // the two ports are found by role rather than by a hard-coded terminal name.
  const LINE = (base.ports.find((port) => SUPPLY_ROLES.has(port.role)) ?? base.ports[0]).name;
  const NEUTRAL = (base.ports.find((port) => RETURN_ROLES.has(port.role)) ?? base.ports[1]).name;
  const electrical = base.electrical;
  const limits = base.limitsSpec;
  const behaviour = electrical.behaviour;
  const minVolts = electrical.minOperatingVoltage ?? 0;
  const knee = Math.max(minVolts * 0.5, electrical.ratedVoltage * 0.05);
  // A constant-power input stage regulates only within its window. Above the voltage that damages
  // it, it is no longer regulating anything, so the model stops pretending: it holds the
  // conductance it had at that voltage and behaves resistively. That matters for more than
  // realism. `I = P/V` has negative incremental conductance, so a constant-power load facing a
  // high-impedance supply has a second, spurious equilibrium at a very high voltage, and Newton
  // will happily walk to it. Turning the characteristic resistive removes it.
  const regulationCeiling = limits.overVoltageDamage ?? null;

  const elementMaterial = electrical.elementMaterial
    ? catalog.material(electrical.elementMaterial)
    : null;
  const filament = electrical.filament ?? null;
  const filamentMaterial = filament ? catalog.material(filament.material) : null;
  const filamentAreaM2 = filament ? (Math.PI / 4) * filament.diameterM ** 2 : 0;
  const referenceResistance = (electrical.ratedVoltage ** 2) / electrical.ratedPowerWatts;

  const state = {
    running: electrical.startsRunning ?? true,
    cycleSeconds: 0,
    startedAtSeconds: -Infinity,
    inrushRemaining: 0,
    energyWh: 0,
    burnedMassKg: 0,
    lastAdvanceSeconds: 0
  };

  function filamentResistance(temperatureC) {
    return (resistivityAt(filamentMaterial, temperatureC) * filament.lengthM) / filamentAreaM2;
  }

  function elementResistance(temperatureC) {
    if (!elementMaterial) return referenceResistance;
    const reference = elementMaterial.resistivityReferenceTemperatureC;
    const coefficient = elementMaterial.resistivityTempCoefficientPerC ?? 0;
    return referenceResistance * (1 + coefficient * (temperatureC - reference));
  }

  /** Power the load asks for right now, W. */
  function demandWatts(ctx) {
    if (behaviour !== "compressor") return electrical.ratedPowerWatts;
    if (!state.running) return 0;
    return state.inrushRemaining > 0
      ? electrical.ratedPowerWatts * electrical.inrushMultiple
      : electrical.ratedPowerWatts;
  }

  return Object.assign(base, {
    state,
    mode: "on",
    behaviour,

    stamp(ctx) {
      if (isOpen(this) || this.mode === "off") {
        ctx.conductance(LINE, NEUTRAL, ctx.settings.gminSiemens);
        return;
      }
      const volts = ctx.across(LINE, NEUTRAL);

      if (behaviour === "incandescent") {
        const resistance = filamentResistance(ctx.temperature("filament"));
        ctx.conductance(LINE, NEUTRAL, 1 / Math.max(resistance, 1e-9));
        return;
      }
      if (behaviour === "constantResistance") {
        const resistance = elementResistance(ctx.temperature(this.thermal.heatNodeName));
        ctx.conductance(LINE, NEUTRAL, 1 / Math.max(resistance, 1e-9));
        return;
      }

      const watts = demandWatts(ctx);
      if (watts <= 0) {
        ctx.conductance(LINE, NEUTRAL, ctx.settings.gminSiemens);
        return;
      }

      // A regulated load draws P/V: pull the bus down and it draws more, which is negative
      // incremental conductance. It is stamped instead as the resistance that draws that power at
      // the present voltage, recomputed every iteration. Both give I = P/V at the answer, but the
      // negative slope is only safe while something stiff is holding the bus. Let the supply stop
      // conducting -- a cold pack blocking charge, a controller tapered off at its stage voltage --
      // and the load's own node goes negative, at which point a Newton step climbs away from the
      // solution instead of down to it and the bus runs off to nowhere. The secant conductance is
      // positive everywhere, so the iteration always walks down to where the supply picks up again.
      //
      // Two clamps bound the characteristic. Below the knee the regulator cannot hold its output and
      // the input turns resistive, and above the voltage that destroys the input stage it is not
      // regulating anything either.
      const magnitude = Math.min(
        Math.max(Math.abs(volts), knee),
        regulationCeiling ?? Number.POSITIVE_INFINITY
      );
      ctx.conductance(LINE, NEUTRAL, watts / (magnitude * magnitude));
    },

    limits(ctx) {
      if (isOpen(this)) return "off";
      const volts = Math.abs(ctx.across(LINE, NEUTRAL));
      if (behaviour === "compressor" && !state.running) return "off";
      if (this.mode === "off") {
        // Restart needs a margin above the drop-out voltage, otherwise a sagging bus makes the
        // load chatter on and off within a single solve.
        return volts >= minVolts * 1.05 ? "on" : "off";
      }
      return volts >= minVolts ? "on" : "off";
    },

    heat(ctx) {
      const amps = this.portCurrents.get(LINE) ?? 0;
      const volts = ctx.across(LINE, NEUTRAL);
      const absorbed = Math.abs(volts * amps);
      if (behaviour === "incandescent") return { filament: absorbed, envelope: 0 };
      const luminous = electrical.luminousEfficiency ?? 0;
      return { [this.thermal.heatNodeName]: absorbed * (1 - luminous) };
    },

    externalPowerWatts(ctx) {
      const luminous = electrical.luminousEfficiency ?? 0;
      if (luminous === 0) return 0;
      const amps = this.portCurrents.get(LINE) ?? 0;
      // Light leaving the lamp is not heat, so it leaves the energy balance here.
      return -Math.abs(ctx.across(LINE, NEUTRAL) * amps) * luminous;
    },

    advance(ctx, dt) {
      const amps = this.portCurrents.get(LINE) ?? 0;
      const volts = ctx.across(LINE, NEUTRAL);
      state.energyWh += (Math.abs(volts * amps) * dt) / 3600;

      if (behaviour === "compressor") {
        state.cycleSeconds = (state.cycleSeconds + dt) % electrical.cycleSeconds;
        const runWindow = electrical.cycleSeconds * electrical.dutyCycle;
        const shouldRun = state.cycleSeconds < runWindow;
        if (shouldRun && !state.running) {
          state.running = true;
          state.inrushRemaining = electrical.inrushSeconds;
        } else if (!shouldRun) {
          state.running = false;
          state.inrushRemaining = 0;
        } else {
          state.inrushRemaining = Math.max(0, state.inrushRemaining - dt);
        }
      }
      state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events(ctx) {
      const events = [];
      if (behaviour === "incandescent" && limits.filamentBurnoutTemperatureC !== undefined) {
        events.push({
          id: "filament-burnout",
          value: ctx.temperature("filament") - limits.filamentBurnoutTemperatureC
        });
      }
      if (limits.overVoltageDamage !== undefined) {
        events.push({
          id: "over-voltage",
          value: Math.abs(ctx.across(LINE, NEUTRAL)) - limits.overVoltageDamage
        });
      }
      if (behaviour === "compressor" && electrical.inrushSeconds > 0) {
        events.push({ id: "inrush-end", value: -state.inrushRemaining });
      }
      return events;
    },

    onEvent(id) {
      if (id === "filament-burnout") {
        transition(this, FailureState.damaged, "filament burned out");
      }
      if (id === "over-voltage") {
        transition(this, FailureState.damaged, "supply voltage above the load's limit");
      }
      if (id === "inrush-end") state.inrushRemaining = 0;
    },

    measurements(ctx) {
      const amps = this.portCurrents.get(LINE) ?? 0;
      const volts = ctx.across(LINE, NEUTRAL);
      const result = {
        currentAmps: amps,
        voltageVolts: volts,
        powerWatts: Math.abs(volts * amps),
        temperatureC: ctx.temperature(this.thermal.heatNodeName),
        energyWh: state.energyWh,
        running: this.mode === "on" && !isOpen(this),
        failure: this.failure
      };
      if (behaviour === "incandescent") {
        result.filamentTemperatureC = ctx.temperature("filament");
        result.envelopeTemperatureC = ctx.temperature("envelope");
        result.resistanceOhms = filamentResistance(ctx.temperature("filament"));
      }
      if (behaviour === "compressor") {
        result.inrush = state.inrushRemaining > 0;
      }
      return result;
    }
  });
}
