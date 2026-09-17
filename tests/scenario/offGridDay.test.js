// Phase 6 scenario: a whole cabin, a whole day, nothing forced.
//
// One 300 W panel, an MPPT, a 12 V 100 Ah pack behind an ANL fuse, a DC fridge and a DC light on
// a busbar, and an inverter running an LED lamp. The June sun rises on a half-empty pack and the
// day has to balance: what the array makes, what the loads take, what the pack ends up holding.
//
// The numbers below are recorded outputs, not targets. What is asserted is that they still add
// up, that nothing overheats or trips, and that the day's energy closes.

import test from "node:test";
import assert from "node:assert/strict";
import { layoutBuilder, siteEnvironment } from "../helpers/fixtures.js";

const FAT = "wire-cu-4-0awg-thhn";
const DC = "wire-cu-10awg-thhn";
const AC = "wire-cu-14awg-thhn";
const LOADS = ["fridge", "light", "lamp"];

function cabin({ localDate = "2024-06-21", stateOfCharge = 0.6 } = {}) {
  const world = layoutBuilder()
    .place("pv", "pv-mono-300w", 0, 0)
    .place("mppt", "controller-mppt-50a", 12, 0)
    .place("bat", "battery-lifepo4-12v-100ah", 24, 0, { indoors: true })
    .place("fuse", "fuse-anl-100a", 18, 8)
    .place("bus", "busbar-250a", 30, 8)
    .place("fridge", "load-dc-fridge-12v-45w", 40, 0)
    .place("light", "load-dc-led-12v-20w", 40, 8)
    .place("inv", "inverter-12v-1000w", 40, 16)
    .place("lamp", "load-led-10w", 52, 16)
    .wire("pv", "positive", "mppt", "pv-positive", DC)
    .wire("pv", "negative", "mppt", "pv-negative", DC)
    .wire("mppt", "battery-positive", "bat", "positive", FAT)
    .wire("mppt", "battery-negative", "bat", "negative", FAT)
    .wire("bat", "positive", "fuse", "a", FAT)
    .wire("fuse", "b", "bus", "a", FAT)
    .wire("bus", "b", "fridge", "positive", DC)
    .wire("fridge", "negative", "bat", "negative", DC)
    .wire("bus", "c", "light", "positive", DC)
    .wire("light", "negative", "bat", "negative", DC)
    .wire("bus", "d", "inv", "dc-positive", FAT)
    .wire("inv", "dc-negative", "bat", "negative", FAT)
    .wire("inv", "ac-line", "lamp", "ac-line", AC)
    .wire("lamp", "ac-neutral", "inv", "ac-neutral", AC)
    .world({ environment: siteEnvironment(localDate) });
  world.device("bat").state.stateOfCharge = stateOfCharge;
  return world;
}

// Everything between the array and the loads: whatever these turn into heat is the difference
// between what was generated and what was used or stored.
const CONVERSION = ["mppt", "inv", "fuse", "bus"];

/** A day, a minute at a time, integrating everything worth integrating. */
function runDay(world) {
  const startWh = world.measure("bat").energyWh;
  const totals = {
    pvWh: 0,
    loadWh: 0,
    packWh: 0,
    conversionLossWh: 0,
    wiringLossWh: 0,
    minStateOfCharge: 1,
    maxStateOfCharge: 0,
    convergenceRejections: 0
  };
  const events = [];
  for (let minute = 0; minute < 1440; minute += 1) {
    const step = world.advanceMinutes(1);
    events.push(...step.events);
    totals.convergenceRejections += step.convergenceRejected;
    const report = world.report();
    totals.pvWh += report.totals.generatedWatts / 60;
    for (const id of LOADS) totals.loadWh += report.devices[id].powerWatts / 60;
    // Measured at the pack's terminals, so it is positive while the pack is charging and negative
    // overnight when the pack is the one supplying the cabin.
    totals.packWh += report.devices.bat.powerWatts / 60;
    for (const id of CONVERSION) totals.conversionLossWh += report.devices[id].heatWatts / 60;
    for (const [id, device] of Object.entries(report.devices)) {
      if (device.kind === "wire") totals.wiringLossWh += report.devices[id].heatWatts / 60;
    }
    const stateOfCharge = report.devices.bat.stateOfCharge;
    totals.minStateOfCharge = Math.min(totals.minStateOfCharge, stateOfCharge);
    totals.maxStateOfCharge = Math.max(totals.maxStateOfCharge, stateOfCharge);
  }
  return { ...totals, startWh, endWh: world.measure("bat").energyWh, events };
}

test("a cabin runs a June day on one panel and ends the day fuller than it started", () => {
  const world = cabin();
  const day = runDay(world);
  console.log(
    `June 21: array ${day.pvWh.toFixed(0)} Wh, loads ${day.loadWh.toFixed(0)} Wh, ` +
      `pack ${day.startWh.toFixed(0)} -> ${day.endWh.toFixed(0)} Wh, ` +
      `SoC ${day.minStateOfCharge.toFixed(3)} to ${day.maxStateOfCharge.toFixed(3)}, ` +
      `${day.convergenceRejections} steps retried`
  );

  // A 300 W panel at Denver in June makes between four and six times its nameplate in a day.
  assert.ok(day.pvWh > 1200 && day.pvWh < 1900, `array made ${day.pvWh} Wh`);
  // The loads are a 45 W fridge duty-cycling, a 20 W light and a 10 W lamp behind an inverter.
  assert.ok(day.loadWh > 700 && day.loadWh < 1600, `loads took ${day.loadWh} Wh`);
  // More sun than load, so the pack ends up ahead, and it fills at some point in the afternoon.
  assert.ok(day.endWh > day.startWh, `pack fell from ${day.startWh} to ${day.endWh} Wh`);
  assert.ok(day.maxStateOfCharge > 0.99, `pack only reached ${day.maxStateOfCharge}`);
  // And it is never taken below the depth of discharge a lithium pack tolerates.
  assert.ok(day.minStateOfCharge > 0.2, `pack fell to ${day.minStateOfCharge}`);

  // A full pack that has stopped accepting charge, an MPPT still pushing into it and a compressor
  // starting are three stiff things changing hands at once, and some of those steps have to be
  // retried shorter. A handful over a day is the integrator working; hundreds would mean the
  // operating point itself is unstable.
  assert.ok(
    day.convergenceRejections < 100,
    `${day.convergenceRejections} steps had to be retried`
  );

  // Nothing in the cabin was abused: no conservation violation, no hazard, no failed device.
  assert.deepEqual(world.violations, []);
  assert.deepEqual(world.hazards(), []);
  for (const device of world.devices) assert.equal(device.failure, "ok", `${device.id} failed`);
});

test("the day's energy closes across the whole cabin", () => {
  const world = cabin();
  const day = runDay(world);

  // Every watt-hour the array made went one of four places: a load, the pack, the conversion
  // stages or the wiring. This is the per-step conservation invariant integrated over a day, and
  // the point of writing it out is that it is measured at the terminals of separate devices.
  const accounted = day.loadWh + day.packWh + day.conversionLossWh + day.wiringLossWh;
  const residual = day.pvWh - accounted;
  console.log(
    `array ${day.pvWh.toFixed(1)} Wh = loads ${day.loadWh.toFixed(1)} + pack ${day.packWh.toFixed(1)} ` +
      `+ conversion ${day.conversionLossWh.toFixed(1)} + wiring ${day.wiringLossWh.toFixed(1)}, ` +
      `residual ${residual.toFixed(2)} Wh (${((100 * residual) / day.pvWh).toFixed(3)} %)`
  );
  assert.ok(
    Math.abs(residual) < 0.01 * day.pvWh,
    `${residual} Wh of the array's ${day.pvWh} Wh is unaccounted for`
  );

  // The inverter's own no-load draw runs all night and is the largest single loss in a cabin
  // this small, so conversion has to dominate the wiring.
  assert.ok(
    day.conversionLossWh > day.wiringLossWh,
    `conversion ${day.conversionLossWh} Wh against wiring ${day.wiringLossWh} Wh`
  );
});

test("December costs the cabin its margin, not its production", () => {
  const june = runDay(cabin({ localDate: "2024-06-21" }));
  const december = runDay(cabin({ localDate: "2024-12-21" }));
  console.log(
    `December 21: array ${december.pvWh.toFixed(0)} Wh, loads ${december.loadWh.toFixed(0)} Wh, ` +
      `pack ${december.startWh.toFixed(0)} -> ${december.endWh.toFixed(0)} Wh, ` +
      `SoC ${december.minStateOfCharge.toFixed(3)} to ${december.maxStateOfCharge.toFixed(3)}`
  );

  // A 40 degree tilt at 40 degrees latitude is aimed at the winter sun, and a December cell runs
  // 30 K cooler than a June one, so the array's daily output barely falls.
  assert.ok(
    december.pvWh > 0.8 * june.pvWh,
    `December made ${december.pvWh} Wh against June's ${june.pvWh} Wh`
  );
  // What December takes away is the night: fifteen hours of load instead of nine, so the pack is
  // drawn deeper and the day no longer ends ahead.
  assert.ok(
    december.minStateOfCharge < june.minStateOfCharge,
    `December bottomed at ${december.minStateOfCharge}, June at ${june.minStateOfCharge}`
  );
  assert.ok(
    december.endWh - december.startWh < june.endWh - june.startWh,
    "December should not gain more than June"
  );
  assert.deepEqual(december.events.filter((event) => event.eventId.includes("trip")), []);
});
