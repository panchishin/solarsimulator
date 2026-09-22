// The single-diode parameters are extracted from four datasheet numbers (Isc, Voc, Vmp, Imp) by
// the Villalva iteration. Sweeping the resulting curve back at Standard Test Conditions checks
// that the extraction reproduces the module it was extracted from, including the fill factor,
// which is not one of the four.

import { compare, layoutBuilder, model, staticEnvironment } from "../harness.js";
import { singleDiodeCurrent } from "../../engine/devices/pv.js";

/** Module current at `volts` from the device's own substring model. */
function moduleCurve(componentId, irradiance, cellC) {
  const world = layoutBuilder()
    .place("pv", componentId, 0, 0)
    .world({ environment: staticEnvironment(20) });
  const device = world.device("pv");
  const substrings = device.electrical.substrings;
  const parameters = device.substringParameters(irradiance, cellC);
  const currentAt = (volts) =>
    singleDiodeCurrent({ ...parameters, volts: volts / substrings }).amps;

  // Open circuit: the voltage where the current crosses zero.
  let low = 0;
  let high = device.electrical.openCircuitVoltage * 1.5;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (currentAt(middle) > 0) low = middle;
    else high = middle;
  }
  const openCircuit = (low + high) / 2;

  // Maximum power point: a coarse scan refined by a golden-section search.
  let bestVolts = 0;
  let bestWatts = -Infinity;
  const samples = 400;
  for (let index = 0; index <= samples; index += 1) {
    const volts = (openCircuit * index) / samples;
    const watts = volts * currentAt(volts);
    if (watts > bestWatts) {
      bestWatts = watts;
      bestVolts = volts;
    }
  }
  let left = Math.max(bestVolts - openCircuit / samples, 0);
  let right = Math.min(bestVolts + openCircuit / samples, openCircuit);
  for (let step = 0; step < 80; step += 1) {
    const a = left + (right - left) / 3;
    const b = right - (right - left) / 3;
    if (a * currentAt(a) < b * currentAt(b)) left = a;
    else right = b;
  }
  const maxPowerVolts = (left + right) / 2;
  const maxPowerAmps = currentAt(maxPowerVolts);

  return {
    shortCircuitAmps: currentAt(0),
    openCircuitVolts: openCircuit,
    maxPowerVolts,
    maxPowerAmps,
    maxPowerWatts: maxPowerVolts * maxPowerAmps
  };
}

const PANELS = [
  { id: "pv-mono-300w", reference: "canadian-solar-cs6k-300ms", label: "CS6K-300MS" },
  { id: "pv-mono-100w", reference: "renogy-100d", label: "RNG-100D" },
  { id: "pv-bifacial-200w", reference: "aeternasol-200w-bifacial", label: "AeternaSol 200 W" }
];

export default {
  id: "panel-stc",
  title: "module I-V curve at Standard Test Conditions",
  reference: PANELS.map((panel) => panel.reference),
  claim:
    "1000 W/m2, 25 C cell. The extraction targets Pmp and is anchored to Isc and Voc, so those " +
    "should be tight; Vmp, Imp and the fill factor are what the fitted series and shunt " +
    "resistances make them. The AeternaSol module is a listing rather than a datasheet: only its " +
    "200 W rating is published, so its rows check that the derived curve is self-consistent and " +
    "extractable, not a vendor claim.",
  run() {
    const rows = [];
    for (const panel of PANELS) {
      const published = model(panel.id).electrical;
      const curve = moduleCurve(panel.id, 1000, 25);
      const publishedPmp = published.maxPowerVoltage * published.maxPowerCurrentAmps;
      rows.push(
        compare(
          `${panel.label} Isc`,
          "A",
          published.shortCircuitCurrentAmps,
          curve.shortCircuitAmps,
          0.01
        ),
        compare(
          `${panel.label} Voc`,
          "V",
          published.openCircuitVoltage,
          curve.openCircuitVolts,
          0.01
        ),
        compare(`${panel.label} Vmp`, "V", published.maxPowerVoltage, curve.maxPowerVolts, 0.03),
        compare(`${panel.label} Imp`, "A", published.maxPowerCurrentAmps, curve.maxPowerAmps, 0.03),
        compare(`${panel.label} Pmp`, "W", publishedPmp, curve.maxPowerWatts, 0.01),
        compare(
          `${panel.label} fill factor`,
          "",
          publishedPmp / (published.openCircuitVoltage * published.shortCircuitCurrentAmps),
          curve.maxPowerWatts / (curve.openCircuitVolts * curve.shortCircuitAmps),
          0.02
        )
      );
    }
    return rows;
  }
};
