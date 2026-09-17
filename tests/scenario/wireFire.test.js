// Phase 6 scenario: an unprotected 14 AWG feeder asked to carry a hundred amps.
//
// Nothing in the layout says the wire is the weak part. It is simply the device whose I^2R over
// its own surface gets to the ignition temperature of PVC first, and once it is burning it eats
// the only thing holding the circuit together. The counterfactual is the same layout with a fuse
// in the feeder, which is the whole reason the code requires one.

import test from "node:test";
import assert from "node:assert/strict";
import { layoutBuilder, staticEnvironment } from "../helpers/fixtures.js";

const THIN = "wire-cu-14awg-thhn";
const DC = "wire-cu-10awg-thhn";
const FAT = "wire-cu-4-0awg-thhn";
const ELEMENTS = 16;

/** A pack, a busbar fed through 14 AWG, sixteen resistive elements, and a bystander. */
function overloadedFeeder({ protect = null } = {}) {
  const builder = layoutBuilder()
    .place("bat", "battery-lifepo4-12v-100ah", 0, 0, { indoors: true })
    .place("bus", "busbar-250a", 10, 0)
    // Close enough to the feeder to be inside the flame radius, so if the fire had the fuel to
    // spread this is what it would reach.
    .place("neighbour", "load-dc-led-12v-20w", 5, 1)
    .wire("bus", "b", "neighbour", "positive", DC)
    .wire("neighbour", "negative", "bat", "negative", DC);
  if (protect) {
    builder
      .place("protect", protect, 5, 0)
      .wire("bat", "positive", "protect", "a", THIN, "feeder")
      .wire("protect", "b", "bus", "a", THIN, "feeder-out");
  } else {
    builder.wire("bat", "positive", "bus", "a", THIN, "feeder");
  }
  for (let index = 0; index < ELEMENTS; index += 1) {
    builder
      .place(`heat${index}`, "load-dc-heater-12v-100w", 20, index * 6)
      .wire("bus", index % 2 === 0 ? "c" : "d", `heat${index}`, "positive", FAT)
      .wire(`heat${index}`, "negative", "bat", "negative", FAT);
  }
  const world = builder.world({ environment: staticEnvironment(25) });
  world.device("bat").state.stateOfCharge = 1;
  return world;
}

const elementWatts = (world) => {
  let watts = 0;
  for (let index = 0; index < ELEMENTS; index += 1) watts += world.measure(`heat${index}`).powerWatts;
  return watts;
};

test("an unprotected feeder ignites, burns through, and puts out its own fire", () => {
  const world = overloadedFeeder();
  const feeder = "feeder";
  world.solveNow();
  const start = world.measure(feeder);
  console.log(
    `feeder: ${start.currentAmps.toFixed(0)} A over ` +
      `${start.lengthMeters.toFixed(2)} m of 14 AWG ` +
      `(rated 30 A), ${start.heatWatts.toFixed(0)} W of heat, elements drawing ${elementWatts(world).toFixed(0)} W`
  );
  assert.ok(start.currentAmps > 100, `the feeder only carried ${start.currentAmps} A`);

  const events = [];
  let peakInsulationC = 0;
  let peakNeighbourC = 0;
  let burningSeconds = 0;
  for (let step = 0; step < 400; step += 1) {
    const advanced = world.advance(5);
    events.push(...advanced.events);
    if (world.device(feeder).failure === "burning") burningSeconds += advanced.advancedSeconds;
    const report = world.report();
    peakInsulationC = Math.max(peakInsulationC, report.devices[feeder].insulationTemperatureC);
    peakNeighbourC = Math.max(peakNeighbourC, report.devices.neighbour.temperatureC);
    if (world.device(feeder).failure === "consumed" && step > 40) break;
  }
  console.log(
    `insulation peaked at ${peakInsulationC.toFixed(0)} C; ` +
      `${events.map((event) => `${event.eventId}@${event.atSeconds.toFixed(1)}s`).join(", ")}; ` +
      `burning for ${burningSeconds.toFixed(0)} s; bystander reached ${peakNeighbourC.toFixed(0)} C`
  );

  // Ignition then burn-through, in that order, and both within a couple of minutes.
  const ignition = events.find((event) => event.eventId.includes("ignition"));
  const burnThrough = events.find((event) => event.eventId.includes("burn-through"));
  assert.ok(ignition, "the insulation never ignited");
  assert.ok(burnThrough, "the conductor never burned through");
  assert.ok(burnThrough.atSeconds > ignition.atSeconds);
  assert.ok(ignition.atSeconds < 120, `ignition took ${ignition.atSeconds} s`);
  assert.equal(world.device(feeder).failure, "consumed");

  // The fire lasts as long as its fuel does, which for a half metre of PVC on a 14 AWG conductor
  // is a matter of seconds, and it ends by opening the circuit that was feeding it.
  assert.ok(burningSeconds > 5 && burningSeconds < 120, `it burned for ${burningSeconds} s`);
  world.solveNow();
  assert.ok(Math.abs(world.measure(feeder).currentAmps) < 1e-3, "the feeder is still conducting");
  assert.ok(elementWatts(world) < 1, `the elements still draw ${elementWatts(world)} W`);

  // A bystander 100 mm away is warmed but survives: a few grams of insulation is not enough fire
  // to take a second device with it.
  assert.ok(peakNeighbourC > 27, `the bystander never felt it: ${peakNeighbourC} C`);
  assert.equal(world.device("neighbour").failure, "ok");
  assert.ok(world.hazards().some((hazard) => hazard.type === "destroyed"));

  // Burning is heat entering the network from a chemical source, and the balance still holds.
  assert.deepEqual(world.violations, []);
});

test("the same feeder behind a fuse never gets warm enough to matter", () => {
  const world = overloadedFeeder({ protect: "fuse-atc-30a" });
  const feeder = "feeder";
  world.solveNow();
  console.log(
    `protected feeder: ${world.measure(feeder).currentAmps.toFixed(0)} A, ` +
      `fuse rated ${world.device("protect").electrical.ratedAmps} A`
  );

  const events = [];
  let peakInsulationC = 0;
  for (let step = 0; step < 200; step += 1) {
    events.push(...world.advance(1).events);
    peakInsulationC = Math.max(peakInsulationC, world.measure(feeder).insulationTemperatureC);
    if (world.measure("protect").blown) break;
  }
  console.log(
    `fuse cleared at ${events
      .map((event) => `${event.deviceId}:${event.eventId}@${event.atSeconds.toFixed(2)}s`)
      .join(", ")}; ` +
      `insulation peaked at ${peakInsulationC.toFixed(0)} C`
  );

  assert.equal(world.measure("protect").blown, true, "the fuse never blew");
  assert.ok(peakInsulationC < 90, `the insulation reached ${peakInsulationC} C, past its rating`);
  assert.equal(world.device(feeder).failure, "ok");
  assert.deepEqual(world.hazards().filter((hazard) => hazard.type === "fire"), []);
  assert.ok(elementWatts(world) < 1, "the branch should be dead");
  assert.deepEqual(world.violations, []);
});
