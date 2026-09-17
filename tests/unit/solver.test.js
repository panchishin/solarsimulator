import test from "node:test";
import assert from "node:assert/strict";
import { catalog, closeTo, layoutBuilder, staticEnvironment } from "../helpers/fixtures.js";

const BATTERY = "battery-lifepo4-12v-100ah";
const HEATER = "load-dc-heater-12v-100w";
const THIN = "wire-cu-14awg-thhn";
const FAT = "wire-cu-4-0awg-thhn";

/** One battery feeding one resistive element through two conductors. */
function simpleCircuit({ wireTypeId = FAT } = {}) {
  return layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("heater", HEATER, 12, 0)
    .wire("bat", "positive", "heater", "positive", wireTypeId)
    .wire("heater", "negative", "bat", "negative", wireTypeId)
    .world({ environment: staticEnvironment(20) });
}

test("a battery, two conductors and an element solve to Ohm's law", () => {
  const world = simpleCircuit();
  world.solveNow();

  const heater = world.measure("heater");
  const battery = world.measure("bat");
  const wires = world.devices.filter((device) => device.kind === "wire");
  const wireResistance = wires.reduce(
    (total, device) => total + world.measure(device.id).resistanceOhms,
    0
  );

  const openCircuit = battery.openCircuitVoltage;
  const total = openCircuit / heater.currentAmps;
  // Total loop resistance has to equal element + conductors + battery internal resistance.
  closeTo(total, heater.resistanceOhms + wireResistance + battery.internalResistanceOhms, 1e-6);
  // And the element's own numbers have to agree with each other.
  closeTo(heater.voltageVolts / heater.currentAmps, heater.resistanceOhms, 1e-9);
});

test("the same circuit in thin wire loses more voltage at the load", () => {
  const fat = simpleCircuit({ wireTypeId: FAT });
  const thin = simpleCircuit({ wireTypeId: THIN });
  fat.solveNow();
  thin.solveNow();
  const fatLoad = fat.measure("heater");
  const thinLoad = thin.measure("heater");
  assert.ok(
    thinLoad.voltageVolts < fatLoad.voltageVolts - 0.1,
    `thin ${thinLoad.voltageVolts} V vs fat ${fatLoad.voltageVolts} V`
  );
  assert.ok(thinLoad.powerWatts < fatLoad.powerWatts);
});

test("elements in parallel draw the sum of their currents", () => {
  const one = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("bus+", "busbar-250a", 8, 0)
    .place("bus-", "busbar-250a", 8, 8)
    .place("h1", HEATER, 16, 0)
    .wire("bat", "positive", "bus+", "a", FAT)
    .wire("bat", "negative", "bus-", "a", FAT)
    .wire("bus+", "b", "h1", "positive", FAT)
    .wire("h1", "negative", "bus-", "b", FAT)
    .world({ environment: staticEnvironment(20) });

  const two = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("bus+", "busbar-250a", 8, 0)
    .place("bus-", "busbar-250a", 8, 8)
    .place("h1", HEATER, 16, 0)
    .place("h2", HEATER, 16, 4)
    .wire("bat", "positive", "bus+", "a", FAT)
    .wire("bat", "negative", "bus-", "a", FAT)
    .wire("bus+", "b", "h1", "positive", FAT)
    .wire("h1", "negative", "bus-", "b", FAT)
    .wire("bus+", "c", "h2", "positive", FAT)
    .wire("h2", "negative", "bus-", "c", FAT)
    .world({ environment: staticEnvironment(20) });

  one.solveNow();
  two.solveNow();
  const single = one.measure("h1").currentAmps;
  const pair = two.measure("h1").currentAmps + two.measure("h2").currentAmps;
  // Not exactly 2x: the extra current sags the bus through the battery's own resistance.
  assert.ok(pair > 1.9 * single && pair < 2 * single, `${pair} vs ${single}`);
  // The two branches differ by about 0.01 %, because h2 sits further along the busbar and its
  // conductors are a little longer. That asymmetry is the point: it is not imposed anywhere.
  closeTo(two.measure("h1").currentAmps, two.measure("h2").currentAmps, 1e-3);
  assert.notEqual(two.measure("h1").currentAmps, two.measure("h2").currentAmps);
});

test("two identical batteries in parallel share the load evenly", () => {
  const world = layoutBuilder()
    .place("b1", BATTERY, 0, 0)
    .place("b2", BATTERY, 0, 8)
    .place("bus+", "busbar-250a", 10, 0)
    .place("bus-", "busbar-250a", 10, 8)
    .place("heater", HEATER, 18, 0)
    .wire("b1", "positive", "bus+", "a", FAT)
    .wire("b2", "positive", "bus+", "b", FAT)
    .wire("b1", "negative", "bus-", "a", FAT)
    .wire("b2", "negative", "bus-", "b", FAT)
    .wire("bus+", "c", "heater", "positive", FAT)
    .wire("heater", "negative", "bus-", "c", FAT)
    .world({ environment: staticEnvironment(20) });

  world.solveNow();
  const first = world.measure("b1").currentAmps;
  const second = world.measure("b2").currentAmps;
  closeTo(first, second, 1e-6, "parallel packs should share: ");
  assert.ok(first < 0, "batteries should be discharging");
});

test("a battery at a different state of charge takes the smaller share", () => {
  const world = layoutBuilder()
    .place("b1", BATTERY, 0, 0)
    .place("b2", BATTERY, 0, 8)
    .place("bus+", "busbar-250a", 10, 0)
    .place("bus-", "busbar-250a", 10, 8)
    .place("heater", HEATER, 18, 0)
    .wire("b1", "positive", "bus+", "a", FAT)
    .wire("b2", "positive", "bus+", "b", FAT)
    .wire("b1", "negative", "bus-", "a", FAT)
    .wire("b2", "negative", "bus-", "b", FAT)
    .wire("bus+", "c", "heater", "positive", FAT)
    .wire("heater", "negative", "bus-", "c", FAT)
    .world({ environment: staticEnvironment(20) });

  world.device("b2").state.stateOfCharge = 0.3;
  world.solveNow();
  const full = world.measure("b1");
  const low = world.measure("b2");
  assert.ok(
    Math.abs(full.currentAmps) > Math.abs(low.currentAmps),
    `full pack ${full.currentAmps} A, low pack ${low.currentAmps} A`
  );
  // The fuller pack is also charging the emptier one if its terminal voltage is higher.
  assert.ok(full.openCircuitVoltage > low.openCircuitVoltage);
});

test("an open switch stops the current", () => {
  const world = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("sw", "switch-dc-300a", 8, 0)
    .place("heater", HEATER, 16, 0)
    .wire("bat", "positive", "sw", "a", FAT)
    .wire("sw", "b", "heater", "positive", FAT)
    .wire("heater", "negative", "bat", "negative", FAT)
    .world({ environment: staticEnvironment(20) });

  world.solveNow();
  assert.ok(Math.abs(world.measure("heater").currentAmps) > 5);

  world.device("sw").state.closed = false;
  world.solveNow();
  assert.ok(
    Math.abs(world.measure("heater").currentAmps) < 1e-6,
    `${world.measure("heater").currentAmps} A leaked through an open switch`
  );
});

test("every net belongs to exactly one galvanic island in a DC-only circuit", () => {
  const world = simpleCircuit();
  const islands = new Set(world.netlist.nets.map((net) => net.island));
  assert.equal(islands.size, 1);
  assert.equal(world.netlist.mixedDomainNets.length, 0);
});

test("an isolated inverter puts its AC side on its own island", () => {
  const world = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("inv", "inverter-12v-1000w", 8, 0)
    .place("lamp", "load-led-10w", 18, 0)
    .wire("bat", "positive", "inv", "dc-positive", FAT)
    .wire("bat", "negative", "inv", "dc-negative", FAT)
    .wire("inv", "ac-line", "lamp", "ac-line", "wire-cu-14awg-thhn")
    .wire("inv", "ac-neutral", "lamp", "ac-neutral", "wire-cu-14awg-thhn")
    .world({ environment: staticEnvironment(20) });

  const islands = new Set(world.netlist.nets.map((net) => net.island));
  assert.equal(islands.size, 2, "DC and AC sides should be galvanically separate");
  assert.equal(world.netlist.mixedDomainNets.length, 0);
  assert.equal(world.netlist.islands.length, 2);
});

test("an inverter with its DC input left floating simply does not run", () => {
  const world = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("inv", "inverter-12v-1000w", 8, 0)
    .wire("bat", "positive", "inv", "ac-line", FAT)
    .wire("bat", "negative", "inv", "ac-neutral", FAT)
    .world({ environment: staticEnvironment(20) });

  // Each wire end is its own net, so the domains meet at the island level, not the net level.
  assert.equal(world.netlist.mixedDomainNets.length, 0);
  assert.equal(world.netlist.mixedDomainIslands.length, 1);
  assert.ok(world.hazards().some((hazard) => hazard.type === "mixed-domain"));

  world.solveNow();
  const inverter = world.measure("inv");
  // Nothing announces "the DC input is missing": the input voltage is zero, the under-voltage
  // protection sees that, and the output stage is therefore not energised.
  assert.equal(inverter.tripReason, "dc-under-voltage");
  assert.ok(Math.abs(world.measure("bat").currentAmps) < 1e-6);
});

test("miswiring the AC output onto the DC bus stops the inverter from starting", () => {
  const world = layoutBuilder()
    .place("bat", BATTERY, 0, 0)
    .place("inv", "inverter-12v-1000w", 8, 0)
    .wire("bat", "positive", "inv", "dc-positive", FAT)
    .wire("bat", "negative", "inv", "dc-negative", FAT)
    .wire("bat", "positive", "inv", "ac-line", FAT)
    .wire("bat", "negative", "inv", "ac-neutral", FAT)
    .world({ environment: staticEnvironment(20) });

  assert.equal(world.netlist.mixedDomainIslands.length, 1);
  world.solveNow();

  // Nothing in the code looks for this wiring mistake, and no rule says what should happen.
  // What the solve finds is that energising a 120 V output stage onto the node feeding its own
  // 13 V input collapses that input, so the inverter's own under-voltage protection holds it
  // off: it never runs, and the pack is never asked for current. The mistake shows up as a
  // hazard and as an inverter that will not start, not as a fault current.
  world.advance(5);
  assert.equal(world.measure("inv").operating, false);
  assert.equal(world.measure("inv").tripReason, "dc-under-voltage");
  assert.equal(world.measure("inv").outputWatts, 0);
  // The only current is the inverter's own input discharge resistor, a fraction of a milliamp.
  const packAmps = world.measure("bat").currentAmps;
  assert.ok(Math.abs(packAmps) < 1e-3, `${packAmps} A`);
  assert.equal(world.measure("bat").contactorClosed, true, "the pack was never over-stressed");

  const types = world.hazards().map((hazard) => hazard.type);
  assert.ok(types.includes("inverter-trip"), types.join(", "));
  assert.ok(types.includes("mixed-domain"), types.join(", "));
});

test("the solver reaches the same answer from a bad starting guess", () => {
  const world = simpleCircuit();
  const first = world.solveNow().voltages.slice();
  world.context.voltages.fill(-40);
  const second = world.solveNow().voltages.slice();
  for (let index = 0; index < first.length; index += 1) {
    closeTo(second[index], first[index], 1e-6, `node ${index}: `);
  }
});

test("solver settings come from the catalog, not from the code", () => {
  assert.equal(catalog.settings.gminSiemens, catalog.simulation.solver.gminSiemens);
});
