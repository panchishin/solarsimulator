// Time-current curves for fuses, breakers, BMS over-current and inverter overload.
//
// A single I^2t constant only matches a datasheet at one point: real curves are shallower at
// low multiples and steeper at high ones. Interpolating the published points in log-log space
// and integrating dD/dt = 1/t_trip(I) reproduces every point by construction, and handles a
// current that varies during the step. See engine/PHYSICS.md section 9.

import { interpolateLogLog } from "../core/units.js";

/** Seconds to trip at a steady `multiple` of rating; Infinity below the must-hold multiple. */
export function tripSeconds(curve, multiple, holdMultiple = 1) {
  if (multiple <= holdMultiple) return Number.POSITIVE_INFINITY;
  return interpolateLogLog(curve, multiple, "multiple", "seconds");
}

/** Rate at which the damage integral fills, 1/s. */
export function damageRate({ curve, multiple, holdMultiple = 1 }) {
  const seconds = tripSeconds(curve, multiple, holdMultiple);
  return Number.isFinite(seconds) && seconds > 0 ? 1 / seconds : 0;
}

/**
 * Advance an inverse-time accumulator. Below the hold multiple the element cools, so the
 * accumulator decays with the device's thermal time constant instead of latching.
 * Returns the new accumulator value.
 */
export function advanceDamage({
  damage,
  currentAmps,
  ratedAmps,
  curve,
  holdMultiple = 1,
  thermalTimeConstantSeconds = 60,
  dt
}) {
  const multiple = Math.abs(currentAmps) / ratedAmps;
  if (multiple > holdMultiple) {
    return damage + damageRate({ curve, multiple, holdMultiple }) * dt;
  }
  const decay = Math.exp(-dt / Math.max(thermalTimeConstantSeconds, 1e-6));
  return damage * decay;
}

/** True when the magnetic (instantaneous) element should act. */
export const magneticTripped = ({ currentAmps, ratedAmps, magneticMultiple }) =>
  magneticMultiple !== undefined && Math.abs(currentAmps) >= magneticMultiple * ratedAmps;
