// The sky and the array, over a year, against NREL's numbers for the same site.
//
// Two comparisons, deliberately in that order. The first is global horizontal irradiance, which
// depends only on the sun position, the Bird & Hulstrom clear-sky model and the cloud series, and
// no array orientation enters it. The second is the DC energy a real array delivers through an
// MPPT controller, which adds the transposition onto the tilted plane, the module's temperature
// and the tracking of its maximum power point.
//
// PVWatts publishes AC yield, so the comparison figure is carried back to the array's DC terminals
// through the two derates that stand between them in that run: 14 % system losses and a 96 %
// inverter (ref:pvwatts-v5).

import { compare, layoutBuilder, siteEnvironment } from "../harness.js";

const PUBLISHED_GHI_KWH_PER_M2_DAY = 5.3;
const PUBLISHED_AC_KWH_PER_KWDC = 1650;
const SYSTEM_LOSSES = 0.14;
const PVWATTS_INVERTER_EFFICIENCY = 0.96;
const PANEL = "pv-mono-300w";
const PV_WIRE = "wire-cu-10awg-thhn";
const FAT = "wire-cu-4-0awg-thhn";
const NAMEPLATE_W = 600;

// The 15th of each month, and the number of days that month stands in for.
const MONTHS = [
  ["2024-01-15", 31],
  ["2024-02-15", 29],
  ["2024-03-15", 31],
  ["2024-04-15", 30],
  ["2024-05-15", 31],
  ["2024-06-15", 30],
  ["2024-07-15", 31],
  ["2024-08-15", 31],
  ["2024-09-15", 30],
  ["2024-10-15", 31],
  ["2024-11-15", 30],
  ["2024-12-15", 31]
];

/**
 * Two 300 W panels in series into an MPPT and a 48 V pack that starts nearly empty, so the
 * controller tracks the array all day and never has to curtail it.
 */
function system(localDate) {
  const world = layoutBuilder()
    .place("pv1", PANEL, 0, 0)
    .place("pv2", PANEL, 0, 8)
    .place("mppt", "controller-mppt-50a", 14, 0)
    .place("bat", "battery-lifepo4-48v-100ah", 26, 0, { indoors: true })
    .wire("pv1", "negative", "pv2", "positive", PV_WIRE)
    .wire("pv1", "positive", "mppt", "pv-positive", PV_WIRE)
    .wire("pv2", "negative", "mppt", "pv-negative", PV_WIRE)
    .wire("mppt", "battery-positive", "bat", "positive", FAT)
    .wire("mppt", "battery-negative", "bat", "negative", FAT)
    .world({ environment: siteEnvironment(localDate) });
  world.device("bat").state.stateOfCharge = 0.2;
  return world;
}

/** One local day: array DC watt-hours, and the sky's horizontal and in-plane insolation. */
function day(localDate) {
  const world = system(localDate);
  const environment = siteEnvironment(localDate);
  let arrayWh = 0;
  let horizontalWhPerM2 = 0;
  let planeWhPerM2 = 0;
  for (let minute = 0; minute < 1440; minute += 1) {
    world.advanceMinutes(1);
    arrayWh += (world.measure("pv1").powerWatts + world.measure("pv2").powerWatts) / 60;
    const sky = environment.at(minute * 60);
    horizontalWhPerM2 += sky.globalHorizontalWPerM2 / 60;
    planeWhPerM2 += sky.planeOfArrayWPerM2 / 60;
  }
  return { arrayWh, horizontalWhPerM2, planeWhPerM2 };
}

export default {
  id: "daily-yield",
  title: "annual irradiance and array yield at Denver",
  reference: [
    "nrel-nsrdb-denver",
    "nrel-denver-yield",
    "pvwatts-v5",
    "bird-hulstrom-1981",
    "duffie-beckman"
  ],
  claim:
    "Twelve representative days, the 15th of each month, weighted by the length of the month. " +
    "Horizontal irradiance lands on the published annual mean. The array then over-produces, and " +
    "the whole of the excess is tilt gain: the model's in-plane insolation is 1.22 times its own " +
    "horizontal, where the PVWatts run implies about 1.10. A synthetic cloud series with no " +
    "seasonal structure leaves the model too many clear winter days, and a clear winter day at " +
    "a 40 degree tilt collects nearly twice what the horizontal does. The model also has no " +
    "soiling and no snow.",
  run() {
    let annualArrayWh = 0;
    let horizontalWhPerM2 = 0;
    let planeWhPerM2 = 0;
    let days = 0;
    for (const [date, count] of MONTHS) {
      const sample = day(date);
      annualArrayWh += sample.arrayWh * count;
      horizontalWhPerM2 += sample.horizontalWhPerM2 * count;
      planeWhPerM2 += sample.planeWhPerM2 * count;
      days += count;
    }
    return [
      compare(
        "annual mean global horizontal",
        "kWh/m2/day",
        PUBLISHED_GHI_KWH_PER_M2_DAY,
        horizontalWhPerM2 / days / 1000,
        0.08
      ),
      compare(
        "annual DC yield at the array",
        "kWh/kWdc",
        PUBLISHED_AC_KWH_PER_KWDC / ((1 - SYSTEM_LOSSES) * PVWATTS_INVERTER_EFFICIENCY),
        annualArrayWh / NAMEPLATE_W,
        0.2
      ),
      compare(
        "in-plane gain over horizontal",
        "",
        // The same PVWatts run's AC yield, carried back to the plane of the array through its
        // derates and a 6 % module-temperature loss, over the published horizontal mean.
        PUBLISHED_AC_KWH_PER_KWDC /
          ((1 - SYSTEM_LOSSES) * PVWATTS_INVERTER_EFFICIENCY * 0.94) /
          (365 * PUBLISHED_GHI_KWH_PER_M2_DAY),
        planeWhPerM2 / horizontalWhPerM2,
        0.15
      )
    ];
  }
};
