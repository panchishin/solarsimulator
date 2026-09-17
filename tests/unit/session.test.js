// The editor's adapter, exercised the way the page uses it: a circuit of pixel positions and
// terminal names goes in, a running world comes out, and edits do not reset the physics.

import test from "node:test";
import assert from "node:assert/strict";

import { catalog } from "../helpers/fixtures.js";
import {
  GRID_SIZE_PX,
  createSession,
  paletteGroups,
  paletteItems,
  sanitizeCircuit,
  wireTypeOptions
} from "../../js/engine.js";

let nextId = 0;
const uid = () => `id-${nextId++}`;

/** A circuit in the editor's own terms: pixels, not grid spaces. */
function editorCircuit() {
  const components = [];
  const wires = [];
  const place = (componentId, gridX, gridY, extra = {}) => {
    const component = {
      id: uid(),
      componentId,
      x: gridX * GRID_SIZE_PX,
      y: gridY * GRID_SIZE_PX,
      rotation: 0,
      ...extra
    };
    components.push(component);
    return component.id;
  };
  const connect = (from, fromTerminal, to, toTerminal, wireTypeId) => {
    const id = uid();
    wires.push({
      id,
      wireTypeId,
      from: { componentId: from, terminalId: fromTerminal },
      to: { componentId: to, terminalId: toTerminal }
    });
    return id;
  };
  return { components, wires, place, connect, circuit: () => ({ components, wires }) };
}

/** Panel, MPPT, pack and a DC light: the smallest layout that both makes and uses power. */
function cabin() {
  const board = editorCircuit();
  const panel = board.place("pv-mono-300w", 0, 0);
  const mppt = board.place("controller-mppt-50a", 12, 0);
  const pack = board.place("battery-lifepo4-12v-100ah", 24, 0, { indoors: true });
  const light = board.place("load-dc-led-12v-20w", 24, 8);
  const fat = "wire-cu-4-0awg-thhn";
  const thin = "wire-cu-10awg-thhn";
  board.connect(panel, "positive", mppt, "pv-positive", thin);
  board.connect(panel, "negative", mppt, "pv-negative", thin);
  board.connect(mppt, "battery-positive", pack, "positive", fat);
  board.connect(mppt, "battery-negative", pack, "negative", fat);
  board.connect(pack, "positive", light, "positive", thin);
  board.connect(light, "negative", pack, "negative", thin);
  return { board, panel, mppt, pack, light };
}

const session = (circuit, startDate = "2024-06-21T09:00:00-07:00") =>
  createSession({ catalog, circuit, startDate });

test("a circuit built the way the editor builds it runs, and the view reports it", () => {
  const { board, panel, pack, light } = cabin();
  const run = session(board.circuit());
  const before = run.view();

  run.advanceMinutes(60);
  const view = run.view();

  assert.equal(view.devices[panel].kind, "pv");
  assert.ok(view.environment.solarElevationDeg > 0, "the sun is up at 09:00 in June");
  assert.ok(view.devices[panel].powerWatts > 50, `panel made ${view.devices[panel].powerWatts} W`);
  assert.ok(view.devices[light].powerWatts > 10, `light drew ${view.devices[light].powerWatts} W`);
  assert.ok(
    view.devices[pack].stateOfCharge > before.devices[pack].stateOfCharge,
    "an hour of June sun on 300 W of panel puts more in than a 20 W light takes out"
  );

  // Every device reports a temperature to put on its face, whatever it calls the node itself.
  for (const [id, device] of Object.entries(view.devices)) {
    assert.ok(Number.isFinite(device.temperatureC), `${id} (${device.kind}) has no temperature`);
  }

  // The clock is the site's, not the browser's.
  assert.equal(view.date.getTime() - before.date.getTime(), 3600 * 1000);
  console.log(
    `June 21 09:00 + 1 h: ${view.devices[panel].powerWatts.toFixed(0)} W of panel, ` +
      `pack ${(view.devices[pack].stateOfCharge * 100).toFixed(2)} %, ` +
      `ambient ${view.environment.ambientTemperatureC.toFixed(1)} C, ` +
      `GHI ${view.environment.globalHorizontalWPerM2.toFixed(0)} W/m2`
  );
});

test("an edit carries the state of everything that survived it", () => {
  const { board, pack } = cabin();
  const run = session(board.circuit());
  run.advanceMinutes(30);
  const before = run.view();

  // The user drops in a second light and moves the pack. Neither is a reason for the pack to
  // forget its charge or for the clock to go back.
  const second = board.place("load-dc-led-12v-20w", 30, 8);
  board.connect(pack, "positive", second, "positive", "wire-cu-10awg-thhn");
  board.connect(second, "negative", pack, "negative", "wire-cu-10awg-thhn");
  board.components.find(({ id }) => id === pack).y = 4 * GRID_SIZE_PX;
  run.replaceCircuit(board.circuit());
  const after = run.view();

  assert.equal(after.timeSeconds, before.timeSeconds);
  assert.equal(after.devices[pack].stateOfCharge, before.devices[pack].stateOfCharge);
  assert.ok(
    Math.abs(after.devices[pack].cellTemperatureC - before.devices[pack].cellTemperatureC) < 1e-9,
    "the pack's cell temperature came across too"
  );

  run.advanceMinutes(1);
  const running = run.view();
  assert.ok(running.devices[second].powerWatts > 10, "the new light is live");

  // Reset is the one thing that does start over.
  run.reset();
  const fresh = run.view();
  assert.equal(fresh.timeSeconds, 0);
  assert.equal(
    fresh.devices[pack].stateOfCharge,
    catalog.component("battery-lifepo4-12v-100ah").model.electrical.startingStateOfCharge
  );
});

test("a saved layout that outlived the catalog loads without the parts it lost", () => {
  const { board, panel, mppt } = cabin();
  const circuit = board.circuit();
  circuit.components.push({ id: "ghost", componentId: "load-plasma-lamp-1mw", x: 0, y: 0 });
  circuit.wires.push({
    id: "ghost-wire",
    wireTypeId: "wire-cu-10awg-thhn",
    from: { componentId: "ghost", terminalId: "positive" },
    to: { componentId: panel, terminalId: "positive" }
  });
  circuit.wires.push({
    id: "bad-terminal",
    wireTypeId: "wire-cu-10awg-thhn",
    from: { componentId: panel, terminalId: "ac-line" },
    to: { componentId: mppt, terminalId: "pv-positive" }
  });
  circuit.wires.push({
    id: "unknown-gauge",
    wireTypeId: "wire-cu-30awg-magnet",
    from: { componentId: panel, terminalId: "positive" },
    to: { componentId: mppt, terminalId: "pv-positive" }
  });

  const { circuit: clean, dropped } = sanitizeCircuit(catalog, circuit);
  assert.deepEqual(
    dropped.map(({ id }) => id).sort(),
    ["bad-terminal", "ghost", "ghost-wire"]
  );
  assert.equal(
    clean.wires.find(({ id }) => id === "unknown-gauge").wireTypeId,
    catalog.defaultWireTypeId,
    "an unknown conductor becomes the default one rather than taking the layout down"
  );

  // And the session builds from it, which is the point of the check.
  const run = session(circuit);
  assert.equal(run.view().devices.ghost, undefined);
  run.advanceMinutes(1);
});

test("a switch in the layout can be operated", () => {
  const board = editorCircuit();
  const pack = board.place("battery-lifepo4-12v-100ah", 0, 0, { indoors: true });
  const disconnect = board.place("switch-dc-300a", 8, 0);
  const heater = board.place("load-dc-heater-12v-100w", 16, 0);
  board.connect(pack, "positive", disconnect, "a", "wire-cu-6awg-thhn");
  board.connect(disconnect, "b", heater, "positive", "wire-cu-6awg-thhn");
  board.connect(heater, "negative", pack, "negative", "wire-cu-6awg-thhn");

  const run = session(board.circuit());
  run.advanceMinutes(1);
  assert.ok(run.view().devices[heater].powerWatts > 50, "closed by default");

  run.setSwitchClosed(disconnect, false);
  run.advanceMinutes(1);
  const open = run.view();
  assert.ok(
    open.devices[heater].powerWatts < 0.1,
    `an open switch still passed ${open.devices[heater].powerWatts} W`
  );

  run.setSwitchClosed(disconnect, true);
  run.advanceMinutes(1);
  assert.ok(run.view().devices[heater].powerWatts > 50, "and it comes back");
});

test("hazards arrive labelled by what the editor draws", () => {
  // A kilowatt of heater on half a metre of 14 AWG: 80 A through a conductor whose insulation is
  // rated for 90 C.
  const board = editorCircuit();
  const pack = board.place("battery-lifepo4-12v-100ah", 0, 0, { indoors: true });
  const bus = board.place("busbar-250a", 10, 0);
  const feeder = board.connect(pack, "positive", bus, "a", "wire-cu-14awg-thhn");
  const heaters = [];
  for (let index = 0; index < 10; index += 1) {
    const heater = board.place("load-dc-heater-12v-100w", 20, index * 4);
    heaters.push(heater);
    board.connect(bus, "bcd"[index % 3], heater, "positive", "wire-cu-6awg-thhn");
    board.connect(heater, "negative", pack, "negative", "wire-cu-6awg-thhn");
  }

  const run = session(board.circuit());
  let hazard = null;
  for (let minute = 0; minute < 5 && !hazard; minute += 1) {
    run.advanceMinutes(1);
    hazard = run.view().hazards.find((item) => item.wireIds.length > 0);
  }
  const view = run.view();
  assert.ok(hazard, `no wire hazard after 5 minutes: ${JSON.stringify(view.hazards)}`);
  assert.deepEqual(hazard.wireIds, [feeder]);
  assert.deepEqual(hazard.componentIds, []);
  console.log(
    `feeder at ${view.devices[feeder].currentAmps.toFixed(0)} A: ` +
      `insulation ${view.devices[feeder].insulationTemperatureC.toFixed(0)} C ` +
      `(rated ${view.devices[feeder].insulationRatingC} C) after ` +
      `${view.elapsedMinutes.toFixed(0)} min, hazard "${hazard.message}"`
  );
});

test("the palette covers the catalog", () => {
  const groups = paletteGroups(catalog);
  const all = paletteItems(catalog);
  assert.equal(all.length, catalog.components.size);
  for (const item of all) {
    assert.ok(groups.includes(item.group), `${item.id} is in no palette group`);
    assert.ok(item.headline.length > 0, `${item.id} has nothing to show under its name`);
    assert.ok(item.terminals.length > 0);
    assert.ok(item.gridSize.width > 0 && item.gridSize.height > 0);
  }
  const filtered = groups.flatMap((group) => paletteItems(catalog, group));
  assert.equal(filtered.length, all.length, "every component appears in exactly one group");

  const wires = wireTypeOptions(catalog);
  assert.equal(wires.length, catalog.wireTypes.size);
  for (const wire of wires) assert.ok(wire.ampacity > 0, `${wire.id} has no ampacity`);
  console.log(
    `palette: ${all.length} parts in ${groups.length} groups, ` +
      `${wires.length} conductors from ${wires[0].gauge} to ${wires[wires.length - 1].gauge} AWG`
  );
});
