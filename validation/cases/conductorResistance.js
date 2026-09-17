// NEC Chapter 9 Table 8 publishes the DC resistance of copper conductors as well as their area.
// The engine only takes the area from it, and computes resistance from the metal's resistivity and
// its temperature coefficient, so the resistance column is an independent check.

import { catalog, compare, layoutBuilder, staticEnvironment } from "../harness.js";

const FEET_PER_KFT = 1000;
const METRES_PER_FOOT = 0.3048;

// Stranded uncoated copper, ohms per 1000 ft at 75 degC.
const PUBLISHED_OHMS_PER_KFT = {
  "wire-cu-14awg-thhn": 3.14,
  "wire-cu-12awg-thhn": 1.98,
  "wire-cu-10awg-thhn": 1.24,
  "wire-cu-6awg-thhn": 0.491,
  "wire-cu-2awg-thhn": 0.194,
  "wire-cu-4-0awg-thhn": 0.0608
};

/** One conductor of known length, on its own, so its resistance is the only thing measured. */
function conductor(wireTypeId) {
  const world = layoutBuilder()
    .place("a", "busbar-250a", 0, 0)
    .place("b", "busbar-250a", 40, 0)
    .wire("a", "a", "b", "a", wireTypeId, "run")
    .world({ environment: staticEnvironment(20) });
  return world.device("run");
}

export default {
  id: "conductor-resistance",
  title: "conductor DC resistance against the NEC table",
  reference: "nec-ch9-t8",
  claim:
    "Resistance is computed from the conductor's cross-sectional area, copper's resistivity and " +
    "its temperature coefficient. The NEC's own resistance column is a few per cent higher " +
    "because a stranded conductor's strands are longer than the cable they make up.",
  run() {
    const rows = [];
    for (const [wireTypeId, published] of Object.entries(PUBLISHED_OHMS_PER_KFT)) {
      const wire = conductor(wireTypeId);
      const perMetre = wire.resistanceOhms(75) / wire.lengthM;
      const perKft = perMetre * FEET_PER_KFT * METRES_PER_FOOT;
      rows.push(
        compare(
          `${catalog.wireType(wireTypeId).name} at 75 C`,
          "ohm/kft",
          published,
          perKft,
          0.08
        )
      );
    }
    return rows;
  }
};
