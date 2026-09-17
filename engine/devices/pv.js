// Photovoltaic module: five-parameter single-diode substrings in series, each with a bypass
// diode, solved inside the network Newton rather than as a separate curve lookup.
//
// The diode parameters are extracted from the datasheet at load time by the Villalva
// iteration, so nothing is fitted to a simulation result. See engine/PHYSICS.md section 5.

import {
  STC_IRRADIANCE,
  STC_TEMPERATURE_C,
  clamp,
  limitedExponential,
  thermalVoltage
} from "../core/units.js";
import { FailureState, isOpen, transition } from "../failure/machines.js";

const diodeExponential = (volts, thermalA) => limitedExponential(volts / thermalA);

/**
 * Current of one single-diode element at `volts`, solved by Newton, with the analytic
 * derivative dI/dV obtained by implicit differentiation.
 */
export function singleDiodeCurrent({ volts, photo, saturation, series, shunt, thermalA }) {
  let current = photo;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const junction = volts + current * series;
    const { value, slope: exponentialSlope } = diodeExponential(junction, thermalA);
    const residual = photo - saturation * (value - 1) - junction / shunt - current;
    const slope = -((saturation * exponentialSlope * series) / thermalA) - series / shunt - 1;
    const step = -residual / slope;
    current += clamp(step, -photo - 5, photo + 5);
    if (Math.abs(step) < 1e-12) break;
  }
  const junction = volts + current * series;
  const { slope: exponentialSlope } = diodeExponential(junction, thermalA);
  const conductance = (saturation * exponentialSlope) / thermalA + 1 / shunt;
  return {
    amps: current,
    slope: -conductance / (1 + series * conductance)
  };
}

/**
 * Extract Iph, I0, Rs and Rsh from the datasheet STC point. Rs is bisected so the model's
 * maximum power equals the datasheet Pmp; Rsh follows from the requirement that the curve pass
 * through the MPP, and Iph from the short-circuit condition (Villalva et al. 2009).
 */
export function fitSingleDiode({
  shortCircuitCurrentAmps,
  openCircuitVoltage,
  maxPowerVoltage,
  maxPowerCurrentAmps,
  cellsInSeries,
  diodeIdeality,
  temperatureC = STC_TEMPERATURE_C
}) {
  const thermalA = diodeIdeality * cellsInSeries * thermalVoltage(temperatureC);
  const saturation =
    shortCircuitCurrentAmps / (diodeExponential(openCircuitVoltage, thermalA).value - 1);
  const targetPower = maxPowerVoltage * maxPowerCurrentAmps;

  const parametersFor = (series) => {
    let shunt = (100 * openCircuitVoltage) / shortCircuitCurrentAmps;
    let photo = shortCircuitCurrentAmps;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      photo = (shortCircuitCurrentAmps * (shunt + series)) / shunt;
      const junction = maxPowerVoltage + maxPowerCurrentAmps * series;
      const denominator =
        photo - saturation * (diodeExponential(junction, thermalA).value - 1) - maxPowerCurrentAmps;
      const nextShunt = denominator > 1e-9 ? junction / denominator : shunt * 2;
      if (!Number.isFinite(nextShunt) || nextShunt <= 0) break;
      if (Math.abs(nextShunt - shunt) < 1e-9) {
        shunt = nextShunt;
        break;
      }
      shunt = nextShunt;
    }
    return { photo, shunt, series, saturation, thermalA };
  };

  const modelMaxPower = (parameters) => {
    let best = 0;
    const steps = 400;
    for (let index = 1; index <= steps; index += 1) {
      const volts = (openCircuitVoltage * index) / steps;
      const { amps } = singleDiodeCurrent({ volts, ...parameters });
      best = Math.max(best, volts * amps);
    }
    return best;
  };

  let low = 0;
  let high = (0.8 * openCircuitVoltage) / shortCircuitCurrentAmps;
  let parameters = parametersFor(low);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    parameters = parametersFor(middle);
    if (modelMaxPower(parameters) > targetPower) low = middle;
    else high = middle;
    if (high - low < 1e-9) break;
  }
  return parametersFor((low + high) / 2);
}

export function createPvDevice({ base, catalog }) {
  const electrical = base.electrical;
  const optical = base.model.optical;
  const substringCount = electrical.substrings;
  const cellsPerSubstring = electrical.cellsInSeries / substringCount;

  const stc = fitSingleDiode({
    shortCircuitCurrentAmps: electrical.shortCircuitCurrentAmps,
    openCircuitVoltage: electrical.openCircuitVoltage,
    maxPowerVoltage: electrical.maxPowerVoltage,
    maxPowerCurrentAmps: electrical.maxPowerCurrentAmps,
    cellsInSeries: electrical.cellsInSeries,
    diodeIdeality: electrical.diodeIdeality
  });

  const taps = Array.from({ length: substringCount - 1 }, (_, index) => `tap${index + 1}`);
  base.internalNodes = taps;
  base.ports = [
    ...base.ports,
    ...taps.map((name) => ({ name, domain: "dc", role: "internal" }))
  ];
  base.bindings = {
    ...base.bindings,
    ...Object.fromEntries(taps.map((name) => [name, { internal: true, node: name }]))
  };
  base.galvanicGroups = [["positive", "negative", ...taps]];

  const chain = ["negative", ...taps, "positive"];

  return Object.assign(base, {
    state: { shading: [], energyWh: 0, burnedMassKg: 0, lastAdvanceSeconds: 0 },
    mode: "ok",
    stcParameters: stc,

    /**
     * Plane-of-array irradiance for this panel's own orientation, W/m^2. Two panels on
     * different roof faces see different light from the same sky.
     */
    planeOfArrayWPerM2(ctx) {
      const environment = ctx.environment;
      if (!environment) return 0;
      if (typeof environment.planeOfArray === "function") {
        return environment.planeOfArray({
          tiltDeg: this.instance?.tiltDeg,
          surfaceAzimuthDeg: this.instance?.surfaceAzimuthDeg
        }).planeOfArrayWPerM2;
      }
      return environment.planeOfArrayWPerM2 ?? 0;
    },

    /** Irradiance on each substring, W/m^2, after per-substring shading. */
    substringIrradiance(ctx) {
      const poa = this.planeOfArrayWPerM2(ctx);
      const shading = this.instance?.state?.shading ?? this.state.shading;
      return Array.from({ length: substringCount }, (_, index) => {
        const shade = Array.isArray(shading) ? shading[index] ?? 0 : shading ?? 0;
        return poa * (1 - clamp(shade, 0, 1));
      });
    },

    /** Substring parameters at the present irradiance and cell temperature. */
    substringParameters(irradiance, temperatureC) {
      const deltaT = temperatureC - STC_TEMPERATURE_C;
      const iscTempCoefficient =
        (electrical.iscTempCoefficientPercentPerC / 100) * electrical.shortCircuitCurrentAmps;
      const shortCircuit = electrical.shortCircuitCurrentAmps + iscTempCoefficient * deltaT;
      const photoCurrent = (irradiance / STC_IRRADIANCE) * shortCircuit *
        (stc.photo / electrical.shortCircuitCurrentAmps);
      const thermalA =
        electrical.diodeIdeality * cellsPerSubstring * thermalVoltage(temperatureC);

      // I0 is anchored to the datasheet open-circuit voltage at this temperature, which makes
      // the model reproduce the published Voc temperature coefficient exactly.
      const openCircuit =
        (electrical.openCircuitVoltage *
          (1 + (electrical.vocTempCoefficientPercentPerC / 100) * deltaT)) /
        substringCount;
      const saturation =
        Math.max(photoCurrent, 1e-12) / (diodeExponential(openCircuit, thermalA).value - 1);

      return {
        photo: photoCurrent,
        saturation,
        series: stc.series / substringCount,
        shunt: stc.shunt / substringCount,
        thermalA
      };
    },

    seed() {
      // Spread the open-circuit voltage evenly along the substring chain. Leaving every tap at
      // zero would put the entire string voltage across the last substring, far out on its
      // exponential, and Newton would have to climb back from there.
      const perSubstring = electrical.openCircuitVoltage / substringCount;
      const suggestions = { positive: electrical.openCircuitVoltage, negative: 0 };
      taps.forEach((name, index) => {
        suggestions[name] = perSubstring * (index + 1);
      });
      return suggestions;
    },

    stamp(ctx) {
      const leakage = ctx.settings.gminSiemens;
      if (isOpen(this)) {
        ctx.conductance("negative", "positive", leakage);
        return;
      }
      const cellC = ctx.temperature(this.heatNodeName);
      const irradiance = this.substringIrradiance(ctx);
      const bypass = electrical.bypassDiode;
      const bypassThermal = bypass.idealityFactor * thermalVoltage(cellC);

      for (let index = 0; index < substringCount; index += 1) {
        const low = chain[index];
        const high = chain[index + 1];
        const parameters = this.substringParameters(irradiance[index], cellC);
        const volts = ctx.voltage(high) - ctx.voltage(low);
        const { amps, slope } = singleDiodeCurrent({ volts, ...parameters });
        // Generated current leaves the device at `high`, so the current entering the device
        // there is negative.
        ctx.current(high, low, -amps, [
          [high, -slope],
          [low, slope]
        ]);

        const bypassVolts = ctx.voltage(low) - ctx.voltage(high);
        const exponential = diodeExponential(bypassVolts, bypassThermal);
        const bypassAmps = bypass.saturationCurrentAmps * (exponential.value - 1);
        const bypassSlope = (bypass.saturationCurrentAmps * exponential.slope) / bypassThermal;
        ctx.current(low, high, bypassAmps, [
          [low, bypassSlope],
          [high, -bypassSlope]
        ]);
      }
    },

    opticalWatts(ctx) {
      const irradiance = this.substringIrradiance(ctx);
      const average = irradiance.reduce((total, value) => total + value, 0) / substringCount;
      return average * optical.areaM2 * optical.absorptance;
    },

    generatedWatts(ctx) {
      let watts = 0;
      for (const [portName, amps] of this.portCurrents) {
        watts += ctx.voltage(portName) * amps;
      }
      return -watts;
    },

    externalPowerWatts(ctx) {
      return this.opticalWatts(ctx);
    },

    heat(ctx) {
      return { [this.heatNodeName]: this.opticalWatts(ctx) - this.generatedWatts(ctx) };
    },

    advance(ctx, dt) {
      this.state.energyWh += (Math.max(this.generatedWatts(ctx), 0) * dt) / 3600;
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events(ctx) {
      const damage = base.limitsSpec.damageTemperatureC;
      if (damage === undefined) return [];
      return [{ id: "module-overheat", value: ctx.temperature(this.heatNodeName) - damage }];
    },

    onEvent(id) {
      if (id === "module-overheat") {
        transition(this, FailureState.damaged, "module exceeded its temperature limit");
      }
    },

    measurements(ctx) {
      const amps = this.portCurrents.get("positive") ?? 0;
      const volts = ctx.across("positive", "negative");
      const irradiance = this.substringIrradiance(ctx);
      return {
        currentAmps: -amps,
        voltageVolts: volts,
        powerWatts: this.generatedWatts(ctx),
        irradianceWPerM2: irradiance.reduce((total, value) => total + value, 0) / substringCount,
        substringIrradiance: irradiance,
        cellTemperatureC: ctx.temperature(this.heatNodeName),
        energyWh: this.state.energyWh,
        heatWatts: this.opticalWatts(ctx) - this.generatedWatts(ctx),
        failure: this.failure
      };
    }
  });
}
