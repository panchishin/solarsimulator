import test from "node:test";
import assert from "node:assert/strict";
import { CatalogError, Catalog, resistivityAt } from "../../engine/core/catalog.js";
import { catalog, catalogJson } from "../helpers/fixtures.js";

const clone = () => structuredClone(catalogJson);

test("the shipped catalog validates", () => {
  assert.ok(catalog.components.size >= 20);
  assert.ok(catalog.wireTypes.size >= 6);
  assert.ok(Object.keys(catalog.references).length >= 40);
});

test("every component model carries a source", () => {
  for (const [id, definition] of catalog.components) {
    assert.ok(definition.model.source, `${id} has no model.source`);
  }
});

test("an unsourced number in a validated region fails validation", () => {
  const json = clone();
  delete json.simulation.solver.source;
  assert.throws(() => new Catalog(json), CatalogError);
});

test("a citation of a reference that does not exist fails validation", () => {
  const json = clone();
  json.materials.copper.source = "ref:not-a-real-reference";
  assert.throws(() => new Catalog(json), /unknown reference/);
});

test("a source with no recognised prefix fails validation", () => {
  const json = clone();
  json.materials.copper.source = "copper is a metal";
  assert.throws(() => new Catalog(json), /must start with one of/);
});

test("a missing required electrical key fails validation", () => {
  const json = clone();
  const battery = json.components.find((entry) => entry.model.type === "battery");
  delete battery.model.electrical.capacityAh;
  assert.throws(() => new Catalog(json), /capacityAh/);
});

test("a thermal node naming an unknown material fails validation", () => {
  const json = clone();
  const load = json.components.find((entry) => entry.id === "load-led-10w");
  load.model.thermal.nodes.heatsink.material = "unobtainium";
  assert.throws(() => new Catalog(json), /unobtainium/);
});

test("a thermal node with no mass fails validation", () => {
  const json = clone();
  const load = json.components.find((entry) => entry.id === "load-led-10w");
  load.model.thermal.nodes.heatsink.massKg = 0;
  assert.throws(() => new Catalog(json), /massKg/);
});

test("copper resistivity follows its temperature coefficient", () => {
  const copper = catalog.material("copper");
  // NEC Chapter 9 Table 8 gives 8.286 ohm-cmil/ft (1.72e-8 ohm-m) at 20 C for uncoated copper,
  // and the standard coefficient of 0.00393/C puts 75 C copper 21.6 % higher.
  assert.ok(Math.abs(resistivityAt(copper, 20) - 1.72e-8) < 1e-10);
  const ratio = resistivityAt(copper, 75) / resistivityAt(copper, 20);
  assert.ok(Math.abs(ratio - 1.216) < 0.01, `ratio was ${ratio}`);
});

test("tungsten resistivity follows the power law over a wide range", () => {
  const tungsten = catalog.material("tungsten");
  const cold = resistivityAt(tungsten, 20);
  const hot = resistivityAt(tungsten, 2700);
  // The published cold-to-hot resistance ratio of a 2700 C tungsten filament is about 15-16.
  const ratio = hot / cold;
  assert.ok(ratio > 14 && ratio < 18, `ratio was ${ratio}`);
});

test("settings expose solver, integrator and conservation values", () => {
  const settings = catalog.settings;
  assert.ok(settings.gminSiemens > 0);
  assert.ok(settings.maxNewtonIterations >= 20);
  assert.ok(settings.conservation.relativeTolerance > 0);
});
