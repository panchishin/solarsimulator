// NEC Table 310.17 gives the current at which a single insulated conductor in free air reaches
// its insulation rating in a 30 degC ambient. That is a thermal statement, and the engine never
// reads the table: it is given the current and the geometry, makes I^2R, and sheds it by
// convection and radiation. So the table's temperature rise (45 K for the 75 degC column, 30 K
// for the 60 degC column) is something the thermal model has to produce on its own.

import { catalogJson, compare, conductorSteadyState } from "../harness.js";

const AMBIENT_C = 30;
const COLUMNS = [
  { rating: 60, key: "ampacityFreeAir60CAmps" },
  { rating: 75, key: "ampacityFreeAir75CAmps" }
];

const GAUGES = [
  { wireTypeId: "wire-cu-14awg-thhn", gauge: "14" },
  { wireTypeId: "wire-cu-12awg-thhn", gauge: "12" },
  { wireTypeId: "wire-cu-10awg-thhn", gauge: "10" },
  { wireTypeId: "wire-cu-6awg-thhn", gauge: "6" },
  { wireTypeId: "wire-cu-2awg-thhn", gauge: "2" },
  { wireTypeId: "wire-cu-4-0awg-thhn", gauge: "4/0" }
];

export default {
  id: "conductor-ampacity",
  title: "conductor temperature rise at the NEC free-air ampacity",
  reference: ["nec-310-17", "churchill-chu", "incropera"],
  claim:
    "Compared as a rise over the 30 C ambient, because that is the thermal content of the " +
    "table. The model runs the thinnest conductor hot: 14 AWG is a 1.6 mm cylinder whose " +
    "boundary layer is thinner than the correlations were fitted for, and the table's " +
    "small-conductor entries carry termination margin the model has no way to know about.",
  run() {
    const rows = [];
    for (const column of COLUMNS) {
      for (const entry of GAUGES) {
        const amps = catalogJson.conductors.gauges[entry.gauge][column.key];
        const solved = conductorSteadyState({
          wireTypeId: entry.wireTypeId,
          amps,
          ambientC: AMBIENT_C
        });
        rows.push(
          compare(
            `${entry.gauge} AWG rise at ${amps} A (${column.rating} C column)`,
            "K",
            column.rating - AMBIENT_C,
            solved.conductorC - AMBIENT_C,
            0.25
          )
        );
      }
    }
    return rows;
  }
};
