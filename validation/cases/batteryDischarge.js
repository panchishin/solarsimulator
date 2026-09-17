// A pack discharged at C/2 until its BMS opens, against what the manufacturer says the pack
// holds.
//
// The rated capacity is an input, but how much of it comes back out is not: the terminal voltage
// is the OCV curve minus I*R, the resistance rises as the pack empties, the BMS opens on cell
// voltage, and the coulomb counter runs with a coulombic efficiency below one. A pack that gives
// back 100 Ah at C/2 is a claim the manufacturer makes and the model has to earn.

import { compare, layoutBuilder, staticEnvironment } from "../harness.js";

const PACK = "battery-lifepo4-12v-100ah";
const HEATER = "load-dc-heater-12v-100w";
const FAT = "wire-cu-4-0awg-thhn";
const ELEMENTS = 6;
const PUBLISHED_CAPACITY_AH = 100;
const PUBLISHED_NOMINAL_VOLTS = 12.8;

/** Full pack into six resistive elements, so roughly a C/2 discharge, until the BMS opens. */
function discharge() {
  const builder = layoutBuilder()
    .place("bat", PACK, 0, 0, { indoors: true })
    .place("bus", "busbar-250a", 12, 0)
    .wire("bat", "positive", "bus", "a", FAT);
  for (let index = 0; index < ELEMENTS; index += 1) {
    builder
      .place(`load${index}`, HEATER, 24, index * 6)
      .wire("bus", "b", `load${index}`, "positive", FAT)
      .wire(`load${index}`, "negative", "bat", "negative", FAT);
  }
  const world = builder.world({ environment: staticEnvironment(25) });
  const pack = world.device("bat");
  pack.state.stateOfCharge = 1;

  let ampHours = 0;
  let wattHours = 0;
  let seconds = 0;
  const stepSeconds = 30;
  // 12 hours is far longer than a C/2 discharge needs; the loop leaves as soon as the pack does.
  while (seconds < 12 * 3600) {
    world.advance(stepSeconds);
    seconds += stepSeconds;
    const measured = world.measure("bat");
    const amps = Math.abs(measured.currentAmps);
    if (amps < 0.5) break;
    ampHours += (amps * stepSeconds) / 3600;
    wattHours += (Math.abs(measured.powerWatts) * stepSeconds) / 3600;
  }
  return { ampHours, wattHours, hours: seconds / 3600, meanAmps: ampHours / (seconds / 3600) };
}

export default {
  id: "battery-discharge",
  title: "usable capacity of a LiFePO4 pack at C/2",
  reference: ["battleborn-bb10012", "lfp-ocv-typical", "lfp-internal-resistance", "plett-bms"],
  claim:
    "Six resistive elements across a full 12 V 100 Ah pack, run until the BMS opens on low cell " +
    "voltage. The delivered charge is what the coulomb counter, the OCV curve, the internal " +
    "resistance and the cutoff produce between them.",
  run() {
    const result = discharge();
    return [
      compare("delivered charge", "Ah", PUBLISHED_CAPACITY_AH, result.ampHours, 0.08),
      compare(
        "delivered energy",
        "Wh",
        PUBLISHED_CAPACITY_AH * PUBLISHED_NOMINAL_VOLTS,
        result.wattHours,
        0.1
      ),
      compare(
        "mean terminal voltage",
        "V",
        PUBLISHED_NOMINAL_VOLTS,
        result.wattHours / result.ampHours,
        0.05
      )
    ];
  }
};
