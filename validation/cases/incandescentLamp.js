// An incandescent lamp is a resistor whose resistance is a property of tungsten at temperature,
// so switching one on is a thermal transient, not an electrical one.
//
// The filament geometry in the catalog was derived to give the rated hot resistance at the
// published colour temperature, so neither of those is a test. Two things were not put in: the
// ratio of cold to hot resistance, which comes from the tungsten resistivity power law
// (ref:crc-tungsten), and how long the filament takes to get there, which comes from its mass
// against its radiating area.

import { compare, layoutBuilder, staticEnvironment } from "../harness.js";

const FAT = "wire-cu-4-0awg-thhn";
const BRANCH = "wire-cu-14awg-thhn";

// GE's handbook: a general-service lamp draws roughly fifteen times its running current at
// switch-on, and is at full brightness in about a tenth of a second.
const PUBLISHED_RESISTANCE_RATIO = 15;
const PUBLISHED_RUN_UP_SECONDS = 0.1;

function lampOnInverter() {
  return layoutBuilder()
    .place("bat", "battery-lifepo4-12v-100ah", 0, 0)
    .place("inv", "inverter-12v-1000w", 10, 0)
    .place("lamp", "load-incandescent-100w", 22, 0)
    .wire("bat", "positive", "inv", "dc-positive", FAT)
    .wire("bat", "negative", "inv", "dc-negative", FAT)
    .wire("inv", "ac-line", "lamp", "ac-line", BRANCH)
    .wire("lamp", "ac-neutral", "inv", "ac-neutral", BRANCH)
    .world({ environment: staticEnvironment(20) });
}

export default {
  id: "incandescent-lamp",
  title: "incandescent filament run-up",
  reference: ["ge-lamp-handbook", "crc-tungsten"],
  claim:
    "The first solve is taken 10 microseconds after switch-on, before the filament has moved, " +
    "which is the cold resistance. The lamp then runs to its operating point and the run-up is " +
    "timed to within 5 % of the steady current.",
  run() {
    const world = lampOnInverter();
    world.advance(1e-5);
    const cold = world.measure("lamp");

    world.advanceMinutes(10);
    const hot = world.measure("lamp");

    // Same lamp again, timed from switch-on.
    const timed = lampOnInverter();
    let seconds = 0;
    let runUpSeconds = Number.NaN;
    while (seconds < 5) {
      timed.advance(0.002);
      seconds += 0.002;
      if (Math.abs(timed.measure("lamp").currentAmps) < 1.05 * Math.abs(hot.currentAmps)) {
        runUpSeconds = seconds;
        break;
      }
    }

    return [
      compare(
        "cold-to-hot resistance ratio",
        "",
        PUBLISHED_RESISTANCE_RATIO,
        hot.resistanceOhms / cold.resistanceOhms,
        0.15
      ),
      compare("run-up time", "s", PUBLISHED_RUN_UP_SECONDS, runUpSeconds, 0.5)
    ];
  }
};
