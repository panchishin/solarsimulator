// Phase 6 scenario: a bolted short on a live cabin, and what actually clears it.
//
// The layout is the one from offGridDay.test.js with a switch wired from the busbar to the
// negative rail. The switch starts open and is closed mid-morning, which puts a dead short across
// the pack behind its 100 A ANL fuse. Nothing in the scenario decides which device should act:
// the fuse and the pack's BMS both see the fault current and the faster one wins.

import test from "node:test";
import assert from "node:assert/strict";
import { layoutBuilder, siteEnvironment } from "../helpers/fixtures.js";

const FAT = "wire-cu-4-0awg-thhn";
const DC = "wire-cu-10awg-thhn";
const AC = "wire-cu-14awg-thhn";
const LOADS = ["fridge", "light", "lamp"];

function cabinWithFault() {
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
    .place("fault", "switch-dc-300a", 30, 24, { state: { closed: false } })
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
    .wire("bus", "d", "fault", "a", FAT)
    .wire("fault", "b", "bat", "negative", FAT)
    .world({ environment: siteEnvironment("2024-06-21") });
  world.device("bat").state.stateOfCharge = 0.8;
  return world;
}

const loadWatts = (world) =>
  LOADS.reduce((total, id) => total + world.measure(id).powerWatts, 0);

test("a bolted short is cleared by the pack's BMS, and the fuse never gets the chance", () => {
  const world = cabinWithFault();
  world.advanceMinutes(9 * 60);
  const before = { loads: loadWatts(world), bus: world.measure("bat").terminalVoltage };
  assert.ok(before.loads > 20, `the cabin was not running: ${before.loads} W`);

  world.device("fault").setClosed(true);
  const faultAt = world.timeSeconds;
  const events = [];
  let peakFaultAmps = 0;
  // Millisecond steps first, because the whole event is over in under ten of them.
  for (let step = 0; step < 100; step += 1) {
    events.push(...world.advance(0.001).events);
    peakFaultAmps = Math.max(peakFaultAmps, Math.abs(world.measure("fault").currentAmps));
  }
  const report = world.report();
  console.log(
    `short at ${before.bus.toFixed(2)} V drew ${peakFaultAmps.toFixed(0)} A; ` +
      `events ${events
        .map((event) => `${event.eventId}@${((event.atSeconds - faultAt) * 1000).toFixed(1)}ms`)
        .join(", ")}; ` +
      `fuse at ${(100 * report.devices.fuse.damage).toFixed(1)} % of its curve`
  );

  // A 13 V pack into its own internal resistance and a few metres of 4/0 is a four-figure current.
  assert.ok(peakFaultAmps > 500, `the short only drew ${peakFaultAmps} A`);

  // The BMS is an electronic switch watching current directly; the fuse has to melt. At this
  // multiple of its rating the ANL wants tens of milliseconds and the BMS takes under ten.
  const opened = events.find((event) => event.deviceId === "bat");
  assert.ok(opened, "the BMS never opened");
  const openedAfterMs = (opened.atSeconds - faultAt) * 1000;
  assert.ok(openedAfterMs < 15, `the BMS took ${openedAfterMs} ms`);
  assert.equal(report.devices.fuse.blown, false, "the fuse blew, which is not the fast path");
  assert.ok(report.devices.fuse.damage > 0, "the fuse should still have taken some of the fault");
  assert.ok(
    report.devices.fuse.damage < 0.5,
    `the fuse reached ${report.devices.fuse.damage} of its curve`
  );

  // The consequence is that the whole cabin is dead, not just the faulted branch: a BMS protects
  // the pack, not the circuit, and everything downstream of it goes out.
  assert.ok(loadWatts(world) < 1, `loads still drawing ${loadWatts(world)} W`);
  assert.equal(report.devices.bat.contactorClosed, false);
  assert.ok(report.hazards.some((hazard) => hazard.type === "bms-disconnect"));
  // Nothing was destroyed. A BMS disconnect is recoverable, and that is the point of having one.
  for (const device of world.devices) assert.equal(device.failure, "ok", `${device.id} failed`);
  assert.deepEqual(world.violations, []);
});

test("the BMS keeps retrying into the fault, and the cabin comes back when the fault is cleared", () => {
  const world = cabinWithFault();
  world.advanceMinutes(9 * 60);
  world.device("fault").setClosed(true);

  // Two minutes with the fault in place: the BMS reconnects on its retry timer, sees the same
  // short and opens again.
  const retries = [];
  for (let step = 0; step < 120; step += 1) {
    retries.push(...world.advance(1).events.filter((event) => event.deviceId === "bat"));
  }
  console.log(
    "retries into the fault: " +
      retries.map((event) => `${event.eventId}@${(event.atSeconds % 3600).toFixed(1)}s`).join(", ")
  );
  assert.ok(retries.length >= 2, `the BMS tried ${retries.length} time(s) in two minutes`);
  assert.ok(loadWatts(world) < 1, "the cabin should still be dark");

  // Open the fault and wait out one more retry interval.
  world.device("fault").setClosed(false);
  for (let step = 0; step < 120; step += 1) world.advance(1);
  console.log(
    `after clearing: pack ${world.measure("bat").currentAmps.toFixed(2)} A, loads ${loadWatts(world).toFixed(1)} W`
  );
  assert.equal(world.measure("bat").contactorClosed, true, "the BMS never came back");
  assert.ok(loadWatts(world) > 20, `the cabin came back at only ${loadWatts(world)} W`);
  assert.deepEqual(world.hazards(), []);
  assert.deepEqual(world.violations, []);
});
