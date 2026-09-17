// Deterministic synthetic weather: a clearness index over time, an ambient temperature over
// the day, and a wind speed.
//
// Nothing here is random at run time. The cloud series is value noise on a lattice whose
// spacing is the cloud period: each lattice value is a hash of (seed, lattice index), so the
// same hour always yields the same clearness no matter what order hours are asked for. That
// is what makes a simulation reproducible and rewindable.

import { clamp } from "../core/units.js";

const MIN_CLEARNESS = 0.05;
const MAX_CLEARNESS = 1;

/** Mulberry32 PRNG. Small, fast, and fully determined by its 32-bit seed. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic value in [0,1) for an integer lattice `index` under `seed`. A stateless hash
 * rather than a stream, so arbitrary and repeated indices are all cheap and consistent.
 */
export function hashNoise(seed, index) {
  const h = (Math.imul(index | 0, 0x27d4eb2d) ^ (seed >>> 0)) >>> 0;
  return mulberry32(h)();
}

/** Quintic smoothstep 6t^5 - 15t^4 + 10t^3: zero first and second derivative at both ends. */
const smoothstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Weather for one site. Cloud cover is value noise around `cloudMeanClearness` with
 * half-amplitude `cloudAmplitude` and a correlation time of `cloudPeriodHours`.
 *
 * Ambient temperature is an annual sinusoid carrying a daily two-arc cosine. Both cycles matter
 * to a solar array: the annual one because a December cell runs far cooler than a June one at the
 * same irradiance, and the daily one because the hottest part of the afternoon is not the
 * brightest part of the day.
 */
export function createWeather({
  seed = 1,
  cloudPeriodHours = 3,
  cloudMeanClearness = 0.8,
  cloudAmplitude = 0.2,
  windSpeedMPerS = 1,
  annualMeanTemperatureC = 11.6,
  annualTemperatureAmplitudeC = 12,
  coldestDayOfYear = 10,
  dailyTemperatureSwingC = 15,
  temperatureMinHour = 5,
  temperatureMaxHour = 15
} = {}) {
  const period = cloudPeriodHours > 0 ? cloudPeriodHours : 1;

  const clearnessAt = (hoursSinceEpoch) => {
    const position = hoursSinceEpoch / period;
    const cell = Math.floor(position);
    const t = smoothstep(position - cell);
    const noise = hashNoise(seed, cell) * (1 - t) + hashNoise(seed, cell + 1) * t;
    return clamp(
      cloudMeanClearness + cloudAmplitude * (2 * noise - 1),
      MIN_CLEARNESS,
      MAX_CLEARNESS
    );
  };

  /** Daily mean temperature on `dayOfYear`, from the annual cycle alone. */
  const dailyMeanTemperatureC = (dayOfYear) =>
    annualMeanTemperatureC -
    annualTemperatureAmplitudeC *
      Math.cos((2 * Math.PI * (dayOfYear - coldestDayOfYear)) / 365.25);

  const ambientTemperatureC = (localHourOfDay, dayOfYear = 182) => {
    const hour = ((localHourOfDay % 24) + 24) % 24;
    const minHour = ((temperatureMinHour % 24) + 24) % 24;
    const maxHour = ((temperatureMaxHour % 24) + 24) % 24;
    const mean = dailyMeanTemperatureC(dayOfYear);
    const halfSwing = dailyTemperatureSwingC / 2;

    // Forward distance around the clock, so both arcs work whichever extreme comes first and
    // whichever of them wraps past midnight.
    const forward = (from, to) => (((to - from) % 24) + 24) % 24;
    const risingSpan = forward(minHour, maxHour);
    const fallingSpan = 24 - risingSpan;

    const sinceMin = forward(minHour, hour);
    // Each arc is half a cosine cycle, so the curve is flat at both extremes and the two
    // pieces meet with matching slope.
    const fraction =
      sinceMin <= risingSpan
        ? sinceMin / (risingSpan || 1)
        : 1 + (sinceMin - risingSpan) / (fallingSpan || 1);
    return mean - halfSwing * Math.cos(Math.PI * fraction);
  };

  return { clearnessAt, ambientTemperatureC, dailyMeanTemperatureC, windSpeedMPerS };
}

export { MIN_CLEARNESS, MAX_CLEARNESS };
