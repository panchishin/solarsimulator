import test from "node:test";
import assert from "node:assert/strict";
import { catalog, layoutBuilder, staticEnvironment } from "../helpers/fixtures.js";
import { tripSeconds } from "../../engine/failure/tripCurves.js";

const BATTERY = "battery-lifepo4-12v-100ah";
const FAT = "wire-cu-4-0awg-thhn";
const HEATER = "load-dc-heater-12v-100w";

/**
 * Two fused branches off one battery: a healthy branch with a heater, and a branch we can short
 * out. The short is a real conductor, so its resistance is part of the answer.
 */
function twoBranches({ shortWireTypeId = FAT, faultFuse = "fuse-atc-30a" } = {}) {
  return layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("bus+", "busbar-250a", 8, 0)
    .place("bus-", "busbar-250a", 8, 10)
    .place("fuse-good", "fuse-atc-30a", 16, 0)
    .place("fuse-fault", faultFuse, 16, 4)
    .place("heater", HEATER, 26, 0)
    .place("fault+", "busbar-250a", 26, 4)
    .wire("bat", "positive", "bus+", "a", FAT)
    .wire("bat", "negative", "bus-", "a", FAT)
    .wire("bus+", "b", "fuse-good", "a", FAT)
    .wire("fuse-good", "b", "heater", "positive", FAT)
    .wire("heater", "negative", "bus-", "b", FAT)
    .wire("bus+", "c", "fuse-fault", "a", FAT)
    .wire("fuse-fault", "b", "fault+", "a", FAT)
    // The fault itself: a conductor straight from the fused branch back to the negative bus.
    .wire("fault+", "b", "bus-", "c", shortWireTypeId, "fault")
    .world({ environment: staticEnvironment(20), checkInvariants: true });
}

test("a dead short blows its own fuse and leaves the rest of the system running", () => {
  const world = twoBranches();
  const log = world.advance(30);

  const faulted = world.measure("fuse-fault");
  const healthy = world.measure("fuse-good");
  const blowEvent = log.events.find(
    (event) => event.deviceId === "fuse-fault" && event.eventId === "blow"
  );

  assert.ok(faulted.blown, "the faulted branch's fuse should be open");
  assert.equal(healthy.blown, false, "the healthy branch's fuse should be untouched");
  assert.ok(blowEvent, "the blow should be recorded as an event");
  console.log(
    `fault fuse opened at ${blowEvent.atSeconds.toExponential(3)} s; healthy branch still at ` +
      `${world.measure("heater").powerWatts.toFixed(1)} W`
  );
  // A 30 A blade fuse on a bolted battery short sees hundreds of amps, and its curve puts that
  // at milliseconds. The number comes from the curve, not from here.
  assert.ok(blowEvent.atSeconds < 0.5, `took ${blowEvent.atSeconds} s`);
  assert.ok(world.measure("heater").powerWatts > 50, "the healthy load should still be powered");
});

test("the fault current and the trip time agree with the datasheet curve", () => {
  const world = twoBranches();
  // One very small step, so nothing has had time to change state.
  world.stepFixed(1e-6);
  const fuse = world.measure("fuse-fault");
  const definition = catalog.component("fuse-atc-30a").model;
  const expected = tripSeconds(
    definition.limits.timeCurrentCurve,
    fuse.multipleOfRating,
    definition.limits.holdMultiple ?? 1
  );
  console.log(
    `fault current ${fuse.currentAmps.toFixed(0)} A = ${fuse.multipleOfRating.toFixed(1)}x rating, ` +
      `curve says ${expected.toExponential(3)} s`
  );
  assert.ok(fuse.multipleOfRating > 5, `only ${fuse.multipleOfRating}x rating`);
  assert.ok(expected < 0.5, `curve gives ${expected} s`);

  const world2 = twoBranches();
  const log = world2.advance(30);
  const blow = log.events.find((event) => event.deviceId === "fuse-fault");
  // The integral is over a changing current, so the trip lands within a factor of a few of the
  // constant-current curve reading rather than exactly on it.
  assert.ok(blow.atSeconds > expected / 5 && blow.atSeconds < expected * 5, `${blow.atSeconds} vs ${expected}`);
});

test("a bolted short is a race between the BMS and the protection device", () => {
  // Same fault, three protection choices. The winner is whichever integral fills first, which is
  // the point of modelling all three as integrals instead of ranking them by hand.
  const outcomes = {};
  for (const [label, componentId] of [
    ["blade fuse", "fuse-atc-30a"],
    ["ANL fuse", "fuse-anl-100a"],
    ["thermal breaker", "breaker-dc-50a"]
  ]) {
    const world = layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("device", componentId, 8, 0)
      .place("bus", "busbar-250a", 16, 0)
      .wire("bat", "positive", "device", "a", FAT)
      .wire("device", "b", "bus", "a", FAT)
      .wire("bus", "b", "bat", "negative", FAT, "fault")
      .world({ environment: staticEnvironment(20) });
    const log = world.advance(10);
    const first = log.events[0];
    outcomes[label] = { deviceId: first?.deviceId, atSeconds: first?.atSeconds };
    console.log(
      `${label}: first to act was ${first?.deviceId} (${first?.eventId}) at ${first?.atSeconds.toExponential(3)} s`
    );
  }
  // A fast blade fuse clears before the BMS can react; the slower devices do not.
  assert.equal(outcomes["blade fuse"].deviceId, "device");
  assert.equal(outcomes["thermal breaker"].deviceId, "bat");
  assert.ok(outcomes["blade fuse"].atSeconds < outcomes["thermal breaker"].atSeconds);
});

/** A branch of parallel heating elements, drawing far more than anything in it is sized for. */
function overloadedBranch({ protect = null, feeder = FAT, elements = 10, feederGrid = 60 } = {}) {
  const builder = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("bus", "busbar-250a", feederGrid, 0);
  if (protect) {
    builder
      .place("protect", protect, Math.round(feederGrid / 3), 0)
      .wire("bat", "positive", "protect", "a", FAT)
      .wire("protect", "b", "bus", "a", feeder, "feeder");
  } else {
    builder.wire("bat", "positive", "bus", "a", feeder, "feeder");
  }
  for (let index = 0; index < elements; index += 1) {
    builder.place(`h${index}`, HEATER, feederGrid + 10, index * 4);
    builder.join("bus", "b", `h${index}`, "positive");
    builder.join(`h${index}`, "negative", "bat", "negative");
  }
  return builder.world({ environment: staticEnvironment(20) });
}

test("a breaker trips on its inverse-time curve and can be reset, unlike a fuse", () => {
  const world = overloadedBranch({ protect: "breaker-dc-50a" });
  world.solveNow();
  const start = world.measure("protect");
  console.log(
    `overloaded branch: ${start.currentAmps.toFixed(1)} A = ${start.multipleOfRating.toFixed(2)}x rating, ` +
      `curve says ${start.secondsToTrip.toFixed(1)} s`
  );
  assert.ok(start.multipleOfRating > 1.3 && start.multipleOfRating < 2.5);

  const log = world.advance(3600);
  const tripEvent = log.events.find((event) => event.deviceId === "protect");
  assert.ok(tripEvent, "the breaker should trip");
  console.log(`breaker tripped at ${tripEvent.atSeconds.toFixed(1)} s (curve said ${start.secondsToTrip.toFixed(1)} s)`);
  assert.equal(world.measure("protect").tripped, true);
  assert.equal(world.measure("bat").contactorClosed, true, "the pack should never have been at risk");

  world.solveNow();
  assert.ok(Math.abs(world.measure("protect").currentAmps) < 1e-3, "a tripped breaker is open");

  // A breaker is resettable; the overload is still there, so it trips straight back out.
  assert.equal(world.device("protect").reset(), true);
  assert.equal(world.measure("protect").tripped, false);
  const second = world.advance(3600);
  assert.ok(second.events.some((event) => event.deviceId === "protect"));
  assert.equal(world.measure("protect").tripped, true);
});

test("an unprotected undersized conductor ignites and burns itself open", () => {
  // No fuse, no breaker: 14 AWG feeding a branch drawing about 100 A. Nothing declares the wire
  // to be the weak link; it is simply the part whose I^2R over its own surface area gets there
  // first, and the temperature it reaches is where PVC ignites.
  const world = overloadedBranch({
    feeder: "wire-cu-14awg-thhn",
    elements: 16,
    feederGrid: 10
  });
  world.solveNow();
  const start = world.measure("feeder");
  console.log(
    `14 AWG feeder: ${start.currentAmps.toFixed(1)} A through ${start.lengthMeters.toFixed(1)} m ` +
      `(rated 30 A), ${start.heatWatts.toFixed(0)} W`
  );
  assert.ok(start.currentAmps > 80, `only ${start.currentAmps} A`);

  // Watch it happen rather than looking only at the end, because once the conductor opens it
  // cools back to ambient.
  const events = [];
  let peakConductorC = 0;
  let peakInsulationC = 0;
  let wentOverRating = false;
  for (let slice = 0; slice < 60 && world.device("feeder").failure !== "consumed"; slice += 1) {
    events.push(...world.advance(10).events);
    const at = world.measure("feeder");
    peakConductorC = Math.max(peakConductorC, at.conductorTemperatureC);
    peakInsulationC = Math.max(peakInsulationC, at.insulationTemperatureC);
    wentOverRating = wentOverRating || at.overInsulationRating;
  }
  const feederEvents = events.filter((event) => event.deviceId === "feeder");
  console.log(
    `feeder peaked at conductor ${peakConductorC.toFixed(0)} C, insulation ${peakInsulationC.toFixed(0)} C; ` +
      `failure ${world.device("feeder").failure}; events ` +
      (feederEvents.map((event) => `${event.eventId}@${event.atSeconds.toFixed(1)}s`).join(", ") || "none")
  );
  assert.ok(wentOverRating, "the insulation should have gone past its 90 C rating");
  assert.notEqual(world.device("feeder").failure, "ok", "the conductor should have failed");
  assert.ok(feederEvents.length > 0, "the failure should be an event");

  // And the consequence is electrical: the branch is dead.
  world.solveNow();
  assert.ok(Math.abs(world.measure("feeder").currentAmps) < 1e-3);
  assert.ok(world.measure("h0").powerWatts < 1e-3, "the loads should have lost their supply");
});

test("a fuse cannot be reset", () => {
  const world = twoBranches();
  world.advance(30);
  const fuse = world.device("fuse-fault");
  assert.equal(fuse.reset(), false);
  assert.equal(world.measure("fuse-fault").blown, true);
});

test("a fuse below its hold current never accumulates damage", () => {
  const world = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("fuse", "fuse-atc-30a", 8, 0)
    .place("heater", HEATER, 16, 0)
    .wire("bat", "positive", "fuse", "a", FAT)
    .wire("fuse", "b", "heater", "positive", FAT)
    .wire("heater", "negative", "bat", "negative", FAT)
    .world({ environment: staticEnvironment(20), checkInvariants: true });

  world.advanceMinutes(60);
  const fuse = world.measure("fuse");
  assert.ok(fuse.currentAmps > 5 && fuse.currentAmps < 30, `${fuse.currentAmps} A`);
  assert.equal(fuse.damage, 0, `damage crept to ${fuse.damage}`);
  assert.equal(fuse.blown, false);
});
