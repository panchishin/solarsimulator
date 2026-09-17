// Shared scaffolding for validation cases: the catalog, a layout builder and small runners.
//
// Deliberately the same helpers the tests use, so a validation case cannot accidentally exercise
// a different code path from the one the tests cover.

export {
  catalog,
  catalogJson,
  conductorSteadyState,
  layoutBuilder,
  siteEnvironment,
  staticEnvironment
} from "../tests/helpers/fixtures.js";

import { catalog } from "../tests/helpers/fixtures.js";
import { singleDiodeCurrent } from "../engine/devices/pv.js";

/** A comparison row: what was published, what the model produced, and how close is close enough. */
export const compare = (quantity, unit, published, measured, tolerance) => ({
  quantity,
  unit,
  published,
  measured,
  tolerance
});

/** The model definition of a catalog component, by id. */
export const model = (componentId) => catalog.component(componentId).model;

/**
 * Maximum power of a PV device's own curve at an irradiance and cell temperature, W. A coarse
 * scan brackets the peak, then golden-section sits on it.
 */
export function modulePeakWatts(device, irradiance, cellC) {
  if (irradiance <= 0) return 0;
  const substrings = device.electrical.substrings;
  const parameters = device.substringParameters(irradiance, cellC);
  const watts = (volts) =>
    volts * singleDiodeCurrent({ ...parameters, volts: volts / substrings }).amps;

  const ceiling = device.electrical.openCircuitVoltage * 1.2;
  const samples = 40;
  let bestVolts = 0;
  let bestWatts = -Infinity;
  for (let index = 0; index <= samples; index += 1) {
    const volts = (ceiling * index) / samples;
    const value = watts(volts);
    if (value > bestWatts) {
      bestWatts = value;
      bestVolts = volts;
    }
  }
  let left = Math.max(bestVolts - ceiling / samples, 0);
  let right = Math.min(bestVolts + ceiling / samples, ceiling);
  for (let step = 0; step < 40; step += 1) {
    const a = left + (right - left) / 3;
    const b = right - (right - left) / 3;
    if (watts(a) < watts(b)) left = a;
    else right = b;
  }
  return watts((left + right) / 2);
}

/**
 * Run a world minute by minute for a whole local day, calling `sample(world, minute)` after each
 * minute. Returns whatever the accumulator collected.
 */
export function runDay(world, sample) {
  for (let minute = 0; minute < 1440; minute += 1) {
    world.advanceMinutes(1);
    sample(world, minute);
  }
  return world;
}
