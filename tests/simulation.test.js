import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildNetlist,
  calculateTemperature,
  createComponentState,
  createWireState,
  evaluateCircuit,
  simulateTick,
  wirePhysicalProperties
} from "../js/simulation.js";

const catalog = JSON.parse(
  await readFile(new URL("../components.json", import.meta.url), "utf8")
);
const batteryDefinition = catalog.components.find(({ group }) => group === "battery");
const inverterDefinition = catalog.components.find(({ group }) => group === "inverter");
const lightDefinition = catalog.components.find(({ group }) => group === "load");

function component(id, definition, x = 0, y = 0, ambientTemperatureC = 20) {
  return {
    id,
    componentId: definition.id,
    x,
    y,
    state: createComponentState(definition, ambientTemperatureC)
  };
}

const wire = (id, fromComponent, fromTerminal, toComponent, toTerminal) => ({
  id,
  from: { componentId: fromComponent, terminalId: fromTerminal },
  to: { componentId: toComponent, terminalId: toTerminal }
});

function snapshot(components, wires, ambientTemperatureC = 20) {
  return { catalog, components, wires, elapsedMinutes: 0, ambientTemperatureC };
}

test("components begin at ambient temperature and a battery begins at 80 percent charge", () => {
  const state = createComponentState(batteryDefinition);
  assert.equal(state.energyWh, 960);
  assert.equal(state.stateOfCharge, 0.8);
  assert.equal(state.temperatureC, 20);
  assert.equal(createComponentState(inverterDefinition, 15).temperatureC, 15);
});

test("wire physical properties derive from Manhattan grid length", () => {
  const components = [
    component("battery", batteryDefinition, 0, 0),
    component("inverter", inverterDefinition, 240, 96)
  ];
  const connection = wire("wire", "battery", "positive", "inverter", "dc-positive");
  const properties = wirePhysicalProperties(catalog, components, connection);
  const expectedGridSpaces = Math.abs(4 - 10) + Math.abs(0.9 - 5.2);

  assert.ok(Math.abs(properties.lengthMeters - expectedGridSpaces * 0.1) < 1e-9);
  assert.ok(Math.abs(
    properties.resistanceOhms -
    catalog.wire.model.resistivityOhmMeters * properties.lengthMeters /
      (catalog.wire.model.conductorAreaMm2 * 1e-6)
  ) < 1e-12);
  assert.ok(properties.massKg > 0);
  assert.equal(createWireState(catalog, components, connection, 18).temperatureC, 18);
});

test("cooling is scaled by simulated minutes and does not cross ambient", () => {
  const oneMinute = calculateTemperature({
    previousTemperatureC: 40,
    ambientTemperatureC: 20,
    heatWatts: 0,
    massKg: 1,
    specificHeatJPerKgC: 1000,
    minutes: 1,
    coolingCoefficientPerMinute: 0.01
  });
  const tenMinutes = calculateTemperature({
    previousTemperatureC: 40,
    ambientTemperatureC: 20,
    heatWatts: 0,
    massKg: 1,
    specificHeatJPerKgC: 1000,
    minutes: 10,
    coolingCoefficientPerMinute: 0.01
  });

  assert.ok(Math.abs(oneMinute - (20 + 20 * Math.exp(-0.01))) < 1e-9);
  assert.ok(Math.abs(tenMinutes - (20 + 20 * Math.exp(-0.1))) < 1e-9);
  assert.ok(tenMinutes > 20 && tenMinutes < oneMinute);
});

test("zero cooling uses heat energy divided by mass and specific heat", () => {
  const temperature = calculateTemperature({
    previousTemperatureC: 20,
    ambientTemperatureC: 20,
    heatWatts: 100,
    massKg: 2,
    specificHeatJPerKgC: 1000,
    minutes: 10,
    coolingCoefficientPerMinute: 0
  });
  assert.equal(temperature, 50);
});

test("wires collapse connected terminals into electrical nets", () => {
  const components = [
    component("battery", batteryDefinition),
    component("inverter", inverterDefinition)
  ];
  const wires = [
    wire("positive", "battery", "positive", "inverter", "dc-positive"),
    wire("negative", "battery", "negative", "inverter", "dc-negative")
  ];
  const { terminalToNet } = buildNetlist(catalog, components, wires);

  assert.equal(
    terminalToNet.get("battery::positive"),
    terminalToNet.get("inverter::dc-positive")
  );
  assert.notEqual(
    terminalToNet.get("battery::positive"),
    terminalToNet.get("battery::negative")
  );
});

test("a connected inverter applies idle drain each tick", () => {
  const components = [
    component("battery", batteryDefinition),
    component("inverter", inverterDefinition)
  ];
  const wires = [
    wire("positive", "battery", "positive", "inverter", "dc-positive"),
    wire("negative", "battery", "negative", "inverter", "dc-negative")
  ];

  const next = simulateTick(snapshot(components, wires), 1);
  const battery = next.components.find(({ id }) => id === "battery");
  const inverter = next.components.find(({ id }) => id === "inverter");

  assert.equal(battery.state.currentAmps, 25 / 12);
  assert.ok(Math.abs(battery.state.energyWh - (960 - 25 / 60)) < 1e-9);
  assert.ok(battery.state.temperatureC > 20);
  assert.equal(inverter.state.heatWatts, 25);
  assert.ok(inverter.state.temperatureC > battery.state.temperatureC);
  assert.ok(next.wires.every(({ state }) => state.temperatureC >= 20));
  assert.deepEqual(next.report.operatingInverterIds, ["inverter"]);
  assert.equal(next.report.hazards.length, 0);
});

test("a disconnected inverter produces no heat and cools toward a changed ambient", () => {
  const inverter = component("inverter", inverterDefinition);
  inverter.state.temperatureC = 40;
  const next = simulateTick(snapshot([inverter], [], 10), 10);

  assert.equal(next.components[0].state.heatWatts, 0);
  assert.ok(next.components[0].state.temperatureC < 40);
  assert.ok(next.components[0].state.temperatureC > 10);
});

test("a battery short naturally produces high current and rapid drain", () => {
  const components = [component("battery", batteryDefinition)];
  const wires = [
    wire("short", "battery", "positive", "battery", "negative")
  ];

  const evaluated = evaluateCircuit(snapshot(components, wires));
  assert.ok(evaluated.currents.get("battery") < 600);
  assert.ok(evaluated.currents.get("battery") > 590);
  assert.ok(evaluated.wireMetrics.get("short").heatWatts > 0);
  assert.equal(evaluated.hazards[0].type, "dc-short");

  const next = simulateTick(snapshot(components, wires), 1);
  assert.ok(next.components[0].state.energyWh > 840);
  assert.ok(next.components[0].state.energyWh < 841);
  assert.ok(next.components[0].state.temperatureC > 38);
  assert.ok(next.wires[0].state.temperatureC > 70);
});

test("a shorted battery cannot drain below zero", () => {
  const battery = component("battery", batteryDefinition);
  battery.state.energyWh = 30;
  battery.state.stateOfCharge = 0.025;
  const wires = [
    wire("short", "battery", "positive", "battery", "negative")
  ];

  const next = simulateTick(snapshot([battery], wires), 1);
  assert.equal(next.components[0].state.energyWh, 0);
  assert.equal(next.components[0].state.stateOfCharge, 0);
});

test("a depleted battery no longer supplies short-circuit current", () => {
  const battery = component("battery", batteryDefinition);
  battery.state.energyWh = 0;
  battery.state.stateOfCharge = 0;
  const wires = [
    wire("short", "battery", "positive", "battery", "negative")
  ];

  const result = evaluateCircuit(snapshot([battery], wires));
  assert.equal(result.currents.get("battery"), 0);
  assert.equal(result.hazards.length, 0);
});

test("reversed inverter polarity is allowed and reported as a hazard", () => {
  const components = [
    component("battery", batteryDefinition),
    component("inverter", inverterDefinition)
  ];
  const wires = [
    wire("positive", "battery", "positive", "inverter", "dc-negative"),
    wire("negative", "battery", "negative", "inverter", "dc-positive")
  ];

  const result = evaluateCircuit(snapshot(components, wires));
  assert.equal(result.hazards[0].type, "reversed-polarity");
  assert.equal(result.currents.get("battery"), 0);
});

test("an incompatible source voltage reports a mismatch", () => {
  const incompatibleCatalog = structuredClone(catalog);
  const incompatibleBattery = incompatibleCatalog.components.find(({ group }) => group === "battery");
  incompatibleBattery.model.voltage = 48;
  const components = [
    component("battery", incompatibleBattery),
    component("inverter", inverterDefinition)
  ];
  const wires = [
    wire("positive", "battery", "positive", "inverter", "dc-positive"),
    wire("negative", "battery", "negative", "inverter", "dc-negative")
  ];

  const result = evaluateCircuit({
    catalog: incompatibleCatalog,
    components,
    wires,
    elapsedMinutes: 0
  });
  assert.equal(result.hazards[0].type, "voltage-mismatch");
  assert.equal(result.currents.get("battery"), 0);
});

test("joining AC and DC terminals reports a mixed-domain hazard", () => {
  const components = [
    component("battery", batteryDefinition),
    component("inverter", inverterDefinition)
  ];
  const wires = [
    wire("mixed", "battery", "positive", "inverter", "ac-line")
  ];

  const result = evaluateCircuit(snapshot(components, wires));
  assert.equal(result.hazards[0].type, "mixed-ac-dc");
  assert.deepEqual(result.hazards[0].wireIds, ["mixed"]);
});

test("the configured tick duration advances simulated time", () => {
  const next = simulateTick(snapshot([component("battery", batteryDefinition)], []), 15);
  assert.equal(next.elapsedMinutes, 15);
  assert.equal(next.components[0].state.energyWh, 960);
});

test("a 100 W light runs from 80 to 20 percent with only marginal battery warming", (context) => {
  let system = snapshot(
    [
      component("battery", batteryDefinition, 0, 120),
      component("inverter", inverterDefinition, 240, 120),
      component("light", lightDefinition, 480, 120)
    ],
    [
      wire("dc-positive", "battery", "positive", "inverter", "dc-positive"),
      wire("dc-negative", "battery", "negative", "inverter", "dc-negative"),
      wire("ac-line", "inverter", "ac-line", "light", "ac-line"),
      wire("ac-neutral", "inverter", "ac-neutral", "light", "ac-neutral")
    ]
  );
  const peakTemperatures = Object.fromEntries(
    [...system.components.map(({ id }) => [id, 20]), ...system.wires.map(({ id }) => [id, 20])]
  );

  while (system.components.find(({ id }) => id === "battery").state.stateOfCharge > 0.2) {
    system = simulateTick(system, 1);
    for (const item of [...system.components, ...system.wires]) {
      peakTemperatures[item.id] = Math.max(peakTemperatures[item.id], item.state.temperatureC);
    }
  }

  const battery = system.components.find(({ id }) => id === "battery");
  context.diagnostic(`100 W light runtime: ${system.elapsedMinutes} minutes`);
  for (const [id, temperatureC] of Object.entries(peakTemperatures)) {
    context.diagnostic(`${id} peak: ${temperatureC.toFixed(2)} °C`);
  }
  assert.ok(system.elapsedMinutes >= 315 && system.elapsedMinutes <= 320);
  assert.ok(peakTemperatures.battery < 21);
  assert.ok(peakTemperatures.battery > 20);
  assert.ok(peakTemperatures.inverter > peakTemperatures.battery);
  assert.ok(peakTemperatures.light > peakTemperatures.inverter);
  assert.equal(system.report.operatingLoadIds[0], "light");
  assert.ok(battery.state.stateOfCharge <= 0.2);
});

test("shorting a battery creates high temperatures in minutes", (context) => {
  let system = snapshot(
    [component("battery", batteryDefinition, 0, 0)],
    [wire("short", "battery", "positive", "battery", "negative")]
  );
  let batteryReached80C = null;
  let wireReached80C = null;
  let peakBatteryC = 20;
  let peakWireC = 20;

  while (system.components[0].state.energyWh > 0) {
    system = simulateTick(system, 1);
    peakBatteryC = Math.max(peakBatteryC, system.components[0].state.temperatureC);
    peakWireC = Math.max(peakWireC, system.wires[0].state.temperatureC);
    if (batteryReached80C === null && peakBatteryC >= 80) batteryReached80C = system.elapsedMinutes;
    if (wireReached80C === null && peakWireC >= 80) wireReached80C = system.elapsedMinutes;
  }

  context.diagnostic(`Battery depleted after ${system.elapsedMinutes} minutes`);
  context.diagnostic(`Battery peak: ${peakBatteryC.toFixed(2)} °C; reached 80 °C at ${batteryReached80C} min`);
  context.diagnostic(`Wire peak: ${peakWireC.toFixed(2)} °C; reached 80 °C at ${wireReached80C} min`);
  assert.ok(wireReached80C <= 2);
  assert.ok(batteryReached80C <= 4);
  assert.ok(peakBatteryC > 150);
  assert.ok(system.elapsedMinutes <= 9);
});
