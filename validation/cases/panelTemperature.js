// Two independent checks of the module's temperature behaviour.
//
// The power temperature coefficient is on the datasheet but is not an input to anything: the
// model is given only the Isc and Voc coefficients, and what happens to the maximum power point
// falls out of the diode equation. NOCT is the same kind of check on the thermal side, because
// the module's convection comes from Faiman's coefficients (ref:koehl-2011) rather than from the
// module's own NOCT rating.

import {
  compare,
  layoutBuilder,
  model,
  modulePeakWatts,
  staticEnvironment
} from "../harness.js";

/** Maximum power of the module at an irradiance and cell temperature, W. */
function maxPowerWatts(componentId, irradiance, cellC) {
  const world = layoutBuilder()
    .place("pv", componentId, 0, 0)
    .world({ environment: staticEnvironment(20) });
  return modulePeakWatts(world.device("pv"), irradiance, cellC);
}

/** Cell temperature after an hour at fixed conditions, degC. */
function steadyCellC(componentId, { poa, ambientC, windMPerS }) {
  const world = layoutBuilder()
    .place("pv", componentId, 0, 0)
    .world({ environment: staticEnvironment(ambientC, windMPerS, poa) });
  world.advance(3600);
  return world.measure("pv").cellTemperatureC;
}

const PANELS = [
  { id: "pv-mono-300w", reference: "canadian-solar-cs6k-300ms", label: "CS6K-300MS", noctC: 43 },
  { id: "pv-mono-100w", reference: "renogy-100d", label: "RNG-100D", noctC: 47 }
];

export default {
  id: "panel-temperature",
  title: "power temperature coefficient and NOCT",
  reference: [...PANELS.map((panel) => panel.reference), "koehl-2011", "faiman-2008"],
  claim:
    "dPmp/dT is measured between 25 C and 75 C cell at 1000 W/m2 and compared with the " +
    "datasheet's own coefficient, which the model is never given. NOCT is 800 W/m2, 20 C " +
    "ambient, 1 m/s wind, open circuit. Both modules use the same Faiman coefficients, so the " +
    "model cannot tell their NOCT ratings apart: it lands on the larger module's 43 C, and the " +
    "smaller one's published 47 C is 4 K above anything those coefficients can produce.",
  run() {
    const rows = [];
    for (const panel of PANELS) {
      const published = model(panel.id).electrical;
      const cold = maxPowerWatts(panel.id, 1000, 25);
      const hot = maxPowerWatts(panel.id, 1000, 75);
      const perDegree = (100 * (hot - cold)) / (cold * 50);
      rows.push(
        compare(
          `${panel.label} dPmp/dT`,
          "%/C",
          published.pmpTempCoefficientPercentPerC,
          perDegree,
          0.12
        ),
        compare(
          `${panel.label} NOCT cell temperature`,
          "C",
          panel.noctC,
          steadyCellC(panel.id, { poa: 800, ambientC: 20, windMPerS: 1 }),
          0.1
        )
      );
    }
    return rows;
  }
};
