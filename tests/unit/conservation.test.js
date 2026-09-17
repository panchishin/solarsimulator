import test from "node:test";
import assert from "node:assert/strict";
import { layoutBuilder, staticEnvironment, closeTo } from "../helpers/fixtures.js";

const BATTERY = "battery-lifepo4-12v-100ah";
const FAT = "wire-cu-4-0awg-thhn";

/** Every scenario in this file runs with the conservation checks armed. */
function guarded(builder) {
  return builder.world({ environment: staticEnvironment(20), checkInvariants: true });
}

test("a resistive DC circuit conserves energy on every step", () => {
  const world = guarded(
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("heater", "load-dc-heater-12v-100w", 12, 0)
      .wire("bat", "positive", "heater", "positive", FAT)
      .wire("heater", "negative", "bat", "negative", FAT)
  );
  // assertConservation throws inside stepFixed, so reaching the end is the assertion.
  const log = world.advanceMinutes(20);
  assert.ok(log.steps > 0);
  assert.equal(world.violations.length, 0);
});

test("an inverter and an incandescent lamp conserve energy on every step", () => {
  const world = guarded(
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("inv", "inverter-12v-1000w", 10, 0)
      .place("lamp", "load-incandescent-100w", 22, 0)
      .wire("bat", "positive", "inv", "dc-positive", FAT)
      .wire("bat", "negative", "inv", "dc-negative", FAT)
      .wire("inv", "ac-line", "lamp", "ac-line", "wire-cu-14awg-thhn")
      .wire("lamp", "ac-neutral", "inv", "ac-neutral", "wire-cu-14awg-thhn")
  );
  world.advanceMinutes(10);
  assert.equal(world.violations.length, 0);
  const lamp = world.measure("lamp");
  assert.ok(lamp.filamentTemperatureC > 2000, `filament reached ${lamp.filamentTemperatureC} C`);
});

test("a PV array, controller and battery conserve energy on every step", () => {
  const world = layoutBuilder()
    .place("pv", "pv-mono-300w", 0, 0)
    .place("mppt", "controller-mppt-50a", 10, 0)
    .place("bat", BATTERY, 22, 0)
    .wire("pv", "positive", "mppt", "pv-positive", "wire-cu-10awg-thhn")
    .wire("pv", "negative", "mppt", "pv-negative", "wire-cu-10awg-thhn")
    .wire("mppt", "battery-positive", "bat", "positive", FAT)
    .wire("mppt", "battery-negative", "bat", "negative", FAT)
    .world({
      environment: staticEnvironment(25, 1, 800),
      checkInvariants: true
    });
  world.advanceMinutes(10);
  assert.equal(world.violations.length, 0);
  assert.ok(world.measure("pv").powerWatts > 100, `PV made ${world.measure("pv").powerWatts} W`);
});

test("battery charge is accounted for coulomb by coulomb", () => {
  const world = guarded(
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("heater", "load-dc-heater-12v-100w", 12, 0)
      .wire("bat", "positive", "heater", "positive", FAT)
      .wire("heater", "negative", "bat", "negative", FAT)
  );
  const battery = world.device("bat");
  const start = battery.state.stateOfCharge;
  // Integrate the current the way a shunt meter would, in one-minute slices, because the draw
  // falls as the pack sags.
  let integratedCoulombs = 0;
  for (let minute = 0; minute < 60; minute += 1) {
    world.advanceMinutes(1);
    integratedCoulombs += Math.abs(world.measure("bat").currentAmps) * 60;
  }

  const measured = world.measure("bat");
  const drawnCoulombs = (start - battery.state.stateOfCharge) * measured.nominalCapacityAh * 3600;
  // An 8 A draw for an hour is about 29 kC. The point is that the coulombs removed match the
  // current that flowed, which is what checkChargeConservation enforces every step.
  closeTo(drawnCoulombs, integratedCoulombs, 0.01, "coulombs removed vs current integral: ");
  assert.ok(drawnCoulombs > 25000, `only ${drawnCoulombs} C`);
});

test("the conservation check catches a device that invents heat", () => {
  const world = guarded(
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("heater", "load-dc-heater-12v-100w", 12, 0)
      .wire("bat", "positive", "heater", "positive", FAT)
      .wire("heater", "negative", "bat", "negative", FAT)
  );
  const heater = world.device("heater");
  const honest = heater.heat.bind(heater);
  heater.heat = (ctx) => {
    const distribution = honest(ctx);
    return { ...distribution, element: distribution.element + 500 };
  };
  assert.throws(() => world.advanceMinutes(1), /Conservation violated/);
});

test("the conservation check catches a device that misreports its port currents", () => {
  const world = guarded(
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("heater", "load-dc-heater-12v-100w", 12, 0)
      .wire("bat", "positive", "heater", "positive", FAT)
      .wire("heater", "negative", "bat", "negative", FAT)
  );
  const heater = world.device("heater");
  const honest = heater.stamp.bind(heater);
  heater.stamp = function (ctx) {
    honest(ctx);
    if (ctx.recordCurrents) {
      this.portCurrents.set("positive", (this.portCurrents.get("positive") ?? 0) + 5);
    }
  };
  // Both halves of the check fire: the device's own balance and the network sum.
  assert.throws(() => world.advanceMinutes(1), /Conservation violated/);
});

test("no device can stamp an unbalanced current", () => {
  // ctx.current always puts the same magnitude into one node and out of another, so a device
  // physically cannot create or destroy charge. This is the reason the Tellegen sum is a check
  // on the models rather than on the stamping code.
  const world = guarded(
    layoutBuilder()
      .place("bat", BATTERY, 0, 0)
      .place("heater", "load-dc-heater-12v-100w", 12, 0)
      .wire("bat", "positive", "heater", "positive", FAT)
      .wire("heater", "negative", "bat", "negative", FAT)
  );
  world.solveNow();
  let sum = 0;
  for (const device of world.devices) {
    for (const [portName, amps] of device.portCurrents) {
      if (device.nodes.get(portName) >= 0) sum += amps;
    }
  }
  assert.ok(Math.abs(sum) < 1e-9, `port currents summed to ${sum}`);
});
