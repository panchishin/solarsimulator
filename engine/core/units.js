// Physical constants and unit helpers.
//
// Only defined or measured universal constants live here. Every device, material and
// environment parameter lives in the catalog with a `source`. See catalog/schema.md.

/** Stefan-Boltzmann constant, W/m^2K^4. CODATA 2018 (exact, derived from defined SI units). */
export const STEFAN_BOLTZMANN = 5.670374419e-8;

/** Boltzmann constant, J/K. Exact by SI definition (2019). */
export const BOLTZMANN = 1.380649e-23;

/** Elementary charge, C. Exact by SI definition (2019). */
export const ELEMENTARY_CHARGE = 1.602176634e-19;

/** Molar gas constant, J/mol K. Derived from the exact k_B and N_A. */
export const GAS_CONSTANT = 8.31446261815324;

/** Standard acceleration of gravity, m/s^2. Defined value (CGPM 1901). */
export const GRAVITY = 9.80665;

/** Solar constant, W/m^2. Kopp & Lean (2011) total solar irradiance. */
export const SOLAR_CONSTANT = 1361;

/** Reference irradiance of Standard Test Conditions, W/m^2. IEC 61215. */
export const STC_IRRADIANCE = 1000;

/** Reference cell temperature of Standard Test Conditions, degC. IEC 61215. */
export const STC_TEMPERATURE_C = 25;

export const ZERO_CELSIUS_IN_KELVIN = 273.15;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;

export const toKelvin = (celsius) => celsius + ZERO_CELSIUS_IN_KELVIN;
export const toCelsius = (kelvin) => kelvin - ZERO_CELSIUS_IN_KELVIN;

export const degToRad = (degrees) => (degrees * Math.PI) / 180;
export const radToDeg = (radians) => (radians * 180) / Math.PI;

export const ampHoursToCoulombs = (ampHours) => ampHours * SECONDS_PER_HOUR;
export const joulesToWattHours = (joules) => joules / SECONDS_PER_HOUR;
export const wattHoursToJoules = (wattHours) => wattHours * SECONDS_PER_HOUR;

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * exp(x) with a linear continuation above `limit`, and the matching derivative.
 *
 * A junction's exponential overflows long before Newton has finished searching, and simply
 * clamping it flattens the derivative, so the iteration stalls at whatever absurd voltage it
 * first reached. Continuing linearly with the derivative it had at the limit keeps the function
 * monotonic and its Jacobian honest, so Newton walks back down to the real solution. This is
 * the standard device-simulator treatment (Vlach & Singhal, section 6.4).
 */
export function limitedExponential(x, limit = 60) {
  if (x <= limit) {
    const value = Math.exp(x);
    return { value, slope: value };
  }
  const at = Math.exp(limit);
  return { value: at * (1 + (x - limit)), slope: at };
}

/** Thermal voltage kT/q of a single junction at `temperatureC`. */
export const thermalVoltage = (temperatureC) =>
  (BOLTZMANN * toKelvin(temperatureC)) / ELEMENTARY_CHARGE;

/**
 * Linear interpolation over a sorted list of points, clamped at both ends.
 * `points` is an array of objects; `xKey`/`yKey` name the fields.
 */
export function interpolate(points, x, xKey, yKey) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new RangeError("interpolate needs at least one point");
  }
  if (points.length === 1) return points[0][yKey];
  if (x <= points[0][xKey]) return points[0][yKey];
  const last = points[points.length - 1];
  if (x >= last[xKey]) return last[yKey];
  for (let index = 1; index < points.length; index += 1) {
    const upper = points[index];
    const lower = points[index - 1];
    if (x <= upper[xKey]) {
      const span = upper[xKey] - lower[xKey];
      if (span === 0) return lower[yKey];
      const fraction = (x - lower[xKey]) / span;
      return lower[yKey] + fraction * (upper[yKey] - lower[yKey]);
    }
  }
  return last[yKey];
}

/**
 * Log-log interpolation, used for time-current curves where a decade of current spans
 * orders of magnitude of time. Extrapolates along the end segment's slope, which is what
 * datasheet curves do outside their plotted range.
 */
export function interpolateLogLog(points, x, xKey, yKey) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new RangeError("interpolateLogLog needs at least one point");
  }
  if (points.length === 1) return points[0][yKey];
  if (x <= 0) return Number.POSITIVE_INFINITY;
  const lx = Math.log(x);
  const segment = (lower, upper) => {
    const lx0 = Math.log(lower[xKey]);
    const lx1 = Math.log(upper[xKey]);
    const ly0 = Math.log(lower[yKey]);
    const ly1 = Math.log(upper[yKey]);
    if (lx1 === lx0) return lower[yKey];
    return Math.exp(ly0 + ((lx - lx0) / (lx1 - lx0)) * (ly1 - ly0));
  };
  if (x < points[0][xKey]) return segment(points[0], points[1]);
  for (let index = 1; index < points.length; index += 1) {
    if (x <= points[index][xKey]) return segment(points[index - 1], points[index]);
  }
  return segment(points[points.length - 2], points[points.length - 1]);
}
