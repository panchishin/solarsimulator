// Phase 5: the inverter against its datasheet. Efficiency at each point of the published curve,
// overload times off the same curve the ratings come from, DC-side protection, thermal derate,
// and reverse polarity as a fault the wiring has to clear.

import test from "node:test";
import assert from "node:assert/strict";
import { catalog, closeTo, layoutBuilder, staticEnvironment } from "../helpers/fixtures.js";
import { tripSeconds } from "../../engine/failure/tripCurves.js";

const INVERTER = "inverter-12v-1000w";
const BATTERY = "battery-lifepo4-12v-100ah";
const FAT = "wire-cu-4-0awg-thhn";
const definition = catalog.component(INVERTER).model;

/**
 * A pack, an inverter and an AC load, joined without conductors so the numbers are the
 * inverter's own rather than the wiring's. `acLoad` is a catalog id; `packs` puts batteries in
 * parallel, which is how the DC side is made stiff enough to ignore or soft enough to sag.
 */
function bench({ acLoad = null, packs = 1, ambientC = 25, extra = {} } = {}) {
  const builder = layoutBuilder().place("inv", INVERTER, 10, 0, extra);
  for (let index = 0; index < packs; index += 1) {
    builder.place(`bat${index}`, BATTERY, 0, index * 8);
    builder.join(`bat${index}`, "positive", "inv", "dc-positive");
    builder.join(`bat${index}`, "negative", "inv", "dc-negative");
  }
  if (acLoad) {
    builder.place("load", acLoad, 22, 0);
    builder.join("inv", "ac-line", "load", "ac-line");
    builder.join("inv", "ac-neutral", "load", "ac-neutral");
  }
  return builder.world({
    environment: staticEnvironment(ambientC),
    checkInvariants: true
  });
}

test("no-load draw and open-circuit output come from the datasheet, not from a constant", () => {
  const world = bench();
  world.advance(60);
  const inverter = world.measure("inv");

  console.log(
    `idle: ${inverter.powerWatts.toFixed(2)} W from the pack at ${inverter.dcVoltage.toFixed(2)} V, ` +
      `output ${inverter.acVoltage.toFixed(2)} V`
  );
  // Nothing is drawing, so the only DC current is the published no-load draw.
  closeTo(inverter.powerWatts, definition.electrical.idleDrawWatts, 0.02, "idle draw: ");
  // With no load there is no drop across the output impedance, so the terminal is at the set point.
  closeTo(inverter.acVoltage, definition.electrical.outputVoltage, 1e-6, "open-circuit output: ");
  assert.equal(inverter.operating, true);
  assert.equal(world.violations.length, 0);
});

test("efficiency rises with load, and never beats the conversion curve", () => {
  // Four real appliances instead of four chosen wattages. Each is a resistance or a
  // constant-power machine, so what it draws depends on the terminal voltage the inverter holds.
  const cases = [
    { id: "load-led-10w", label: "10 W LED" },
    { id: "load-incandescent-100w", label: "100 W lamp" },
    { id: "load-fridge-400w", label: "400 W fridge" },
    // 1,500 W on a 1,000 W inverter, measured before the overload trip catches up with it.
    { id: "load-hair-dryer-1500w", label: "1500 W dryer", seconds: 20 }
  ];

  const rows = [];
  for (const { id, label, seconds = 120 } of cases) {
    const world = bench({ acLoad: id, packs: 2 });
    world.advance(seconds);
    const inverter = world.measure("inv");
    assert.equal(inverter.operating, true, `${label}: the inverter should still be running`);
    rows.push({
      label,
      watts: inverter.outputWatts,
      fraction: inverter.loadFraction,
      efficiency: inverter.efficiency,
      heatWatts: inverter.heatWatts,
      acVolts: inverter.acVoltage
    });
    console.log(
      `${label}: ${inverter.outputWatts.toFixed(0)} W at ${inverter.acVoltage.toFixed(1)} V = ` +
        `${(inverter.loadFraction * 100).toFixed(1)} % of rating, efficiency ` +
        `${(inverter.efficiency * 100).toFixed(1)} %, losses ${inverter.heatWatts.toFixed(1)} W`
    );
  }

  // Efficiency climbs out of the idle-dominated region: at 10 W the 8 W no-load draw is most of
  // the input; by 1,400 W it is a rounding error.
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(
      rows[index].efficiency > rows[index - 1].efficiency,
      `${rows[index].label} was less efficient than ${rows[index - 1].label}`
    );
  }
  assert.ok(rows[0].efficiency < 0.6, `the 10 W load ran at ${rows[0].efficiency}`);
  assert.ok(rows[rows.length - 1].efficiency > 0.85, `full load ran at ${rows[rows.length - 1].efficiency}`);

  // Terminal efficiency can never beat the conversion curve: the no-load draw and the drop across
  // the output impedance both sit outside it.
  const ceiling = Math.max(...definition.electrical.efficiencyCurve.map((point) => point.efficiency));
  for (const row of rows) {
    assert.ok(row.efficiency < ceiling, `${row.label} beat the curve at ${row.efficiency}`);
  }

  // The output droops under load across its own impedance, which is where part of the loss goes.
  assert.ok(rows[rows.length - 1].acVolts < rows[0].acVolts - 1, "the output should sag under load");
});

test("efficiency at half load matches the datasheet within its own losses", () => {
  // 500 W is the curve's 0.5 point, where it publishes 92 %. What comes out at the terminals is
  // that, less the no-load draw and the drop across the output impedance.
  const world = bench({ acLoad: "load-hair-dryer-1500w", packs: 4, extra: {} });
  world.stepFixed(0.5);
  const inverter = world.measure("inv");
  const curve = definition.electrical.efficiencyCurve;
  const published = curve.find((point) => point.loadFraction === 1.0).efficiency;

  const outAmps = inverter.acCurrentAmps;
  const dropLoss = outAmps * outAmps * definition.electrical.outputResistanceOhms;
  const expected =
    inverter.outputWatts /
    (inverter.outputWatts / published + definition.electrical.idleDrawWatts + dropLoss);

  console.log(
    `${inverter.outputWatts.toFixed(0)} W out at ${inverter.acVoltage.toFixed(1)} V: measured ` +
      `${(inverter.efficiency * 100).toFixed(2)} %, datasheet curve ${(published * 100).toFixed(1)} % ` +
      `less ${definition.electrical.idleDrawWatts} W idle and ${dropLoss.toFixed(1)} W in the ` +
      `output impedance = ${(expected * 100).toFixed(2)} %`
  );
  closeTo(inverter.efficiency, expected, 0.02, "terminal efficiency: ");
});

/** Advance in short hops until `deviceId` fires `eventId`, or give up at `horizonSeconds`. */
function advanceToEvent(world, deviceId, eventId, horizonSeconds) {
  const deadline = world.timeSeconds + horizonSeconds;
  while (world.timeSeconds < deadline) {
    const log = world.advance(Math.min(15, deadline - world.timeSeconds));
    const hit = log.events.find(
      (event) => event.deviceId === deviceId && event.eventId === eventId
    );
    if (hit) return hit.atSeconds;
  }
  return null;
}

test("an overload trips on the datasheet curve, then hiccups against its own lockout", () => {
  const world = bench({ acLoad: "load-hair-dryer-1500w", packs: 4 });
  // Let the pack sag and the heatsink warm, so the load has settled where it will spend the wait.
  world.advance(30);
  const steady = world.measure("inv");
  const multiple = steady.outputWatts / steady.ratedOutputWatts;
  const expected = tripSeconds(definition.limits.overloadCurve, multiple, 1);
  console.log(
    `${steady.outputWatts.toFixed(0)} W on a ${steady.ratedOutputWatts.toFixed(0)} W rating = ` +
      `${multiple.toFixed(3)}x, curve says ${expected.toFixed(1)} s`
  );

  const first = advanceToEvent(world, "inv", "overload-trip", 300);
  assert.ok(first !== null, "the inverter should trip on overload");
  console.log(`tripped at ${first.toFixed(1)} s`);
  // The accumulator integrates 1/t(multiple) over a load that moved slightly, and the curve is
  // steep here: a 0.6 % lower output between 1.2x and 1.5x is 6 % more time. The trip lands on the
  // curve read at the settled load, not at the load of the first instant.
  closeTo(first, expected, 0.02, "overload trip time: ");

  const tripped = world.measure("inv");
  assert.equal(tripped.operating, false);
  assert.equal(tripped.tripReason, "overload");
  // The load is dead while the inverter is off, which is the electrical consequence of the trip.
  assert.ok(world.measure("load").powerWatts < 1, "the load should be dead");

  // The shutdown is latched: it stays off for the restart delay even though removing its own
  // output removed the overload.
  world.advance(definition.limits.restartDelaySeconds - 5);
  assert.equal(world.measure("inv").operating, false, "restarted inside its own lockout");

  // Then it restarts into the same overload and trips again, sooner than the first time, because
  // the inverse-time accumulator only cooled for the length of the lockout.
  const second = advanceToEvent(world, "inv", "overload-trip", 300);
  assert.ok(second !== null, "it should restart and trip again");
  const gap = second - first;
  console.log(
    `restarted and tripped again at ${second.toFixed(1)} s, ${gap.toFixed(1)} s later: ` +
      `${(gap - definition.limits.restartDelaySeconds).toFixed(1)} s of running`
  );
  assert.ok(gap > definition.limits.restartDelaySeconds, "the lockout must be served in full");
  assert.ok(gap - definition.limits.restartDelaySeconds < expected, "a hot restart should trip sooner");
});

test("a heatsink above the derate threshold makes a legal load an overload", () => {
  // Same inverter, same load, 60 C ambient. The rating tapers linearly from derateStartC towards
  // derateFloorFraction of nameplate at derateEndC, so this 1,000 W unit is well under half an
  // inverter here.
  const hot = bench({ acLoad: "load-fridge-400w", packs: 2, ambientC: 60 });
  hot.stepFixed(0.5);
  const derated = hot.measure("inv");
  const span = definition.limits.derateEndC - definition.limits.derateStartC;
  const floor = definition.limits.derateFloorFraction;
  const taper = Math.max(0, Math.min(1, (definition.limits.derateEndC - derated.temperatureC) / span));
  const expected =
    definition.electrical.continuousOutputWatts * (floor + (1 - floor) * taper);

  console.log(
    `heatsink ${derated.temperatureC.toFixed(1)} C: rating ${derated.ratedOutputWatts.toFixed(0)} W ` +
      `of ${definition.electrical.continuousOutputWatts} W`
  );
  closeTo(derated.ratedOutputWatts, expected, 1e-9, "derated rating: ");
  assert.ok(
    derated.ratedOutputWatts < definition.electrical.continuousOutputWatts,
    "a hot inverter should not carry its full rating"
  );
});

test("the derate floor keeps the thermal shutdown reachable", () => {
  // The defect this floor fixes: with the taper reaching zero, rating hit 0 W at derateEndC, which
  // is below shutdownC on every derating part in the catalog. Any output was then an infinite
  // multiple of rating, so the inverse-time overload trip always fired first and shutdownC was
  // dead code. The floor is what makes an over-temperature report as one.
  for (const [id, entry] of catalog.components) {
    const limits = entry.model.limits ?? {};
    if (limits.derateStartC === undefined) continue;
    assert.ok(
      limits.derateFloorFraction > 0,
      `${id} derates without a floor, so its rating reaches zero below shutdownC`
    );
    assert.ok(
      limits.shutdownC > limits.derateEndC,
      `${id} shuts down at or below the end of its derate band`
    );
  }
});

test("an undersized DC cable trips the inverter on under-voltage before it delivers anything", () => {
  // The same pack and the same 1,500 W load, once on 4/0 welding cable and once on 3 m of 14 AWG.
  // The difference is entirely in the conductors.
  // Two packs in parallel, because one 100 Ah pack's BMS opens on 140 A of its own accord and
  // this test is about the conductors.
  const build = (wireTypeId) =>
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("bat2", BATTERY, 0, 8)
      .place("inv", INVERTER, 30, 0)
      .place("load", "load-hair-dryer-1500w", 42, 0)
      .wire("bat", "positive", "bat2", "positive", FAT)
      .wire("bat", "negative", "bat2", "negative", FAT)
      .wire("bat", "positive", "inv", "dc-positive", wireTypeId, "feed")
      .wire("bat", "negative", "inv", "dc-negative", wireTypeId, "return")
      .join("inv", "ac-line", "load", "ac-line")
      .join("inv", "ac-neutral", "load", "ac-neutral")
      .world({ environment: staticEnvironment(25), checkInvariants: true });

  const fat = build(FAT);
  fat.advance(20);
  const fatInverter = fat.measure("inv");
  console.log(
    `4/0 cable: bus ${fatInverter.dcVoltage.toFixed(2)} V, ${fatInverter.outputWatts.toFixed(0)} W out, ` +
      `${fat.measure("feed").voltageDropVolts.toFixed(3)} V per conductor`
  );
  assert.equal(fatInverter.operating, true, "the fat cable should carry it");

  const thin = build("wire-cu-14awg-thhn");
  thin.stepFixed(1e-3);
  const thinInverter = thin.measure("inv");
  const pack = thin.measure("bat");

  // A source behind a resistance can deliver at most V^2/4R into anything at all, whatever the
  // load is. This cable puts that ceiling below what the inverter needs, so no operating point
  // exists at any bus voltage: the only thing the inverter can do is shut down.
  const pathOhms =
    thin.measure("feed").resistanceOhms +
    thin.measure("return").resistanceOhms +
    pack.internalResistanceOhms / 2;
  const deliverable = (pack.openCircuitVoltage * pack.openCircuitVoltage) / (4 * pathOhms);
  const needed = 1500 / 0.9;
  console.log(
    `14 AWG: ${pathOhms.toFixed(4)} ohm round trip from a ${pack.openCircuitVoltage.toFixed(2)} V ` +
      `pack can deliver at most ${deliverable.toFixed(0)} W into anything, and the inverter needs ` +
      `about ${needed.toFixed(0)} W: bus ${thinInverter.dcVoltage.toFixed(2)} V, ` +
      `${thinInverter.operating ? "running" : `off on ${thinInverter.tripReason}`}`
  );
  assert.ok(deliverable < needed, "the cable should be past the maximum power it can transfer");

  assert.equal(thinInverter.operating, false);
  assert.equal(thinInverter.tripReason, "dc-under-voltage");
  assert.ok(thin.measure("load").powerWatts < 1, "the load never runs");
  // Latched for the restart delay, then it tries again: an install that hiccups rather than works.
  thin.advance(definition.limits.restartDelaySeconds - 5);
  assert.equal(thin.measure("inv").operating, false, "restarted inside its lockout");
  thin.advance(60);
  assert.equal(thin.measure("inv").tripReason, "dc-under-voltage", "it should still be cycling");
  assert.equal(thin.violations.length, 0);
});

test("reverse polarity is cleared by the BMS, and the retries are what destroy the inverter", () => {
  // The classic install mistake: the pack's positive on the inverter's negative, through a fuse
  // sized for the inverter. The H-bridge body diodes are silicon, so they conduct whatever the
  // firmware thinks, and three protective devices are now racing.
  const world = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("fuse", "fuse-anl-200a", 8, 0)
    .place("inv", INVERTER, 18, 0)
    .wire("bat", "positive", "fuse", "a", FAT)
    .wire("fuse", "b", "inv", "dc-negative", FAT)
    .wire("bat", "negative", "inv", "dc-positive", FAT)
    .world({ environment: staticEnvironment(20), checkInvariants: true });

  world.stepFixed(1e-6);
  const first = world.measure("inv");
  const fuse = world.measure("fuse");
  console.log(
    `reversed: ${first.dcVoltage.toFixed(2)} V across the input, ` +
      `${Math.abs(fuse.currentAmps).toFixed(0)} A through the fuse = ` +
      `${fuse.multipleOfRating.toFixed(2)}x its rating`
  );
  assert.equal(first.reversePolarity, true, "the inverter should see a reversed bus");
  assert.equal(first.operating, false, "it cannot run backwards");
  assert.ok(Math.abs(fuse.currentAmps) > 400, "the body diodes should draw a fault current");

  // Three devices could clear this: the fuse on its curve, the pack's BMS on its own
  // over-current curve, and the diodes by failing. The BMS is milliseconds and wins.
  const opened = advanceToEvent(world, "bat", "bms-disconnect", 5);
  assert.ok(opened !== null, "the BMS should open");
  const afterOpen = world.measure("inv");
  console.log(
    `the BMS opened at ${(opened * 1000).toFixed(1)} ms with ` +
      `${afterOpen.reverseEnergyJoules.toFixed(1)} J into the diodes, which are destroyed at ` +
      `${definition.limits.reversePolarityDamageJoules} J; the fuse is at ` +
      `${(world.measure("fuse").damage * 100).toFixed(2)} % of its own curve`
  );
  assert.ok(opened < 0.1, `took ${opened} s`);
  assert.equal(world.measure("fuse").blown, false, "the fuse never gets the chance");
  assert.ok(world.measure("fuse").damage < 0.05, "nor does it come close");
  assert.ok(
    afterOpen.reverseEnergyJoules < definition.limits.reversePolarityDamageJoules,
    "one hit does not destroy the diodes"
  );

  // But the BMS reconnects on a timer, and nothing has been rewired, so it faults again. Each
  // attempt puts another slug of energy through the diodes.
  const destroyed = advanceToEvent(world, "inv", "reverse-polarity-damage", 600);
  assert.ok(destroyed !== null, "the retries should eventually destroy the H-bridge");
  const attempts = Math.round(destroyed / 60);
  console.log(
    `destroyed at ${destroyed.toFixed(0)} s after about ${attempts} reconnection attempts, ` +
      `with ${world.measure("inv").reverseEnergyJoules.toFixed(0)} J total; ` +
      `fuse blown: ${world.measure("fuse").blown}`
  );
  assert.equal(world.measure("inv").failure, "damaged");
  assert.ok(attempts >= 3, `destroyed after only ${attempts} attempts`);
  // The fuse in the drawing was never the protection: the pack's own BMS was, every time.
  assert.equal(world.measure("fuse").blown, false, "the fuse still has not operated");
  assert.equal(world.violations.length, 0);
});
