import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildNetlist,
  calculateTemperature,
  createComponentState,
  createWireState,
  evaluateCircuit,
  findCoolingCoefficient,
  resetSimulation,
  simulateTick,
  wirePhysicalProperties
} from "../js/simulation.js";

const catalog = JSON.parse(
  await readFile(new URL("../components.json", import.meta.url), "utf8")
);
const batteryDefinition = catalog.components.find(({ group }) => group === "battery");
const inverterDefinition = catalog.components.find(({ group }) => group === "inverter");
const lightDefinition = catalog.components.find(({ group }) => group === "load");
const hairDryerDefinition = catalog.components.find(({ id }) => id === "load-hair-dryer-1200w");
const fridgeDefinition = catalog.components.find(({ id }) => id === "load-fridge-400w");

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

function runLightScenario(testCatalog = catalog) {
  let system = {
    ...snapshot(
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
    ),
    catalog: testCatalog
  };
  const peakTemperatures = Object.fromEntries(
    [...system.components.map(({ id }) => [id, 20]), ...system.wires.map(({ id }) => [id, 20])]
  );

  while (system.components.find(({ id }) => id === "battery").state.stateOfCharge > 0.2) {
    system = simulateTick(system, 1);
    for (const item of [...system.components, ...system.wires]) {
      peakTemperatures[item.id] = Math.max(peakTemperatures[item.id], item.state.temperatureC);
    }
  }
  return { system, peakTemperatures };
}

test("components begin at ambient temperature and a battery begins at 80 percent charge", () => {
  const state = createComponentState(batteryDefinition);
  assert.equal(state.energyWh, 960);
  assert.equal(state.stateOfCharge, 0.8);
  assert.equal(state.temperatureC, 20);
  assert.equal(createComponentState(inverterDefinition, 15).temperatureC, 15);
});

test("catalog includes the requested battery and inverter variants", () => {
  const batteries = catalog.components
    .filter(({ group }) => group === "battery")
    .map(({ model }) => `${model.voltage}V-${model.capacityAh}Ah`)
    .sort();
  const inverters = catalog.components
    .filter(({ group }) => group === "inverter")
    .map(({ model }) => `${model.inputVoltage}V-${model.maxOutputWatts}W`)
    .sort();

  assert.deepEqual(batteries, [
    "12V-100Ah",
    "12V-200Ah",
    "48V-100Ah",
    "48V-200Ah"
  ]);
  assert.deepEqual(inverters, [
    "12V-1000W",
    "12V-3000W",
    "48V-10000W",
    "48V-3000W",
    "48V-5000W"
  ]);
  assert.equal(
    catalog.components.find(({ id }) => id === "inverter-12v-3000w").name,
    "12V 3kW Inverter"
  );
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

  assert.ok(battery.state.currentAmps > 1.9 && battery.state.currentAmps < 2.1);
  assert.ok(
    Math.abs((960 - battery.state.energyWh) - battery.state.powerWatts / 60) < 1e-9
  );
  assert.ok(battery.state.temperatureC > 20);
  assert.equal(inverter.state.heatWatts, 25);
  const wireHeatWatts = next.wires.reduce(
    (total, connection) => total + connection.state.heatWatts,
    0
  );
  assert.ok(
    Math.abs(
      battery.state.powerWatts -
      inverter.state.powerWatts -
      battery.state.heatWatts -
      wireHeatWatts
    ) < 0.01
  );
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
  assert.ok(evaluated.currents.get("battery") < 630);
  assert.ok(evaluated.currents.get("battery") > 620);
  assert.ok(evaluated.wireMetrics.get("short").heatWatts > 0);
  assert.equal(evaluated.hazards[0].type, "dc-short");

  const next = simulateTick(snapshot(components, wires), 1);
  assert.ok(next.components[0].state.energyWh > 827);
  assert.ok(next.components[0].state.energyWh < 829);
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

test("two cross-connected batteries form a hot closed source loop", (context) => {
  const components = [
    component("battery-a", batteryDefinition, 0, 0),
    component("battery-b", batteryDefinition, 240, 0),
    component("inverter", inverterDefinition, 480, 0)
  ];
  const wires = [
    wire("cross-a", "battery-a", "positive", "battery-b", "negative"),
    wire("cross-b", "battery-b", "positive", "battery-a", "negative"),
    wire("dangling", "battery-a", "positive", "inverter", "dc-positive")
  ];
  const initial = snapshot(components, wires);
  const evaluated = evaluateCircuit(initial);
  const firstCurrent = evaluated.currents.get("battery-a");
  const secondCurrent = evaluated.currents.get("battery-b");
  const totalWireResistance = wires.filter(({ id }) => id.startsWith("cross")).reduce(
    (total, connection) =>
      total + wirePhysicalProperties(catalog, components, connection).resistanceOhms,
    0
  );
  const expectedCurrent = 25.2 / (0.04 + totalWireResistance);

  assert.equal(evaluated.hazards[0].type, "battery-loop-short");
  assert.ok(Math.abs(firstCurrent - expectedCurrent) < 1e-9);
  assert.ok(Math.abs(firstCurrent - secondCurrent) < 1e-9);
  assert.ok(evaluated.wireMetrics.get("cross-a").heatWatts > 0);
  assert.ok(evaluated.wireMetrics.get("cross-b").heatWatts > 0);
  assert.equal(evaluated.wireMetrics.get("dangling").currentAmps, 0);

  const next = simulateTick(initial, 1);
  context.diagnostic(`Two-battery loop current: ${firstCurrent.toFixed(2)} A`);
  for (const battery of next.components.filter(({ id }) => id.startsWith("battery"))) {
    context.diagnostic(
      `${battery.id}: ${battery.state.temperatureC.toFixed(2)} °C, ` +
      `${battery.state.energyWh.toFixed(2)} Wh remaining`
    );
    assert.ok(battery.state.temperatureC > 20);
    assert.ok(battery.state.energyWh < 960);
  }
  for (const connection of next.wires.filter(({ id }) => id.startsWith("cross"))) {
    assert.ok(connection.state.temperatureC > 20);
  }
});

test("one cross-wire between two batteries remains an open circuit", () => {
  const components = [
    component("battery-a", batteryDefinition, 0, 0),
    component("battery-b", batteryDefinition, 240, 0)
  ];
  const wires = [
    wire("open-cross", "battery-a", "positive", "battery-b", "negative")
  ];

  const result = evaluateCircuit(snapshot(components, wires));
  assert.ok(Math.abs(result.currents.get("battery-a")) < 1e-9);
  assert.ok(Math.abs(result.currents.get("battery-b")) < 1e-9);
  assert.equal(result.wireMetrics.get("open-cross").currentAmps, 0);
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
  assert.ok(Math.abs(result.currents.get("battery")) < 1e-9);
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
  assert.ok(Math.abs(result.currents.get("battery")) < 1e-9);
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

test("reset restores battery charge, ambient temperatures, and elapsed time", () => {
  const battery = component("battery", batteryDefinition);
  battery.state.energyWh = 180;
  battery.state.stateOfCharge = 0.15;
  battery.state.temperatureC = 72;
  const inverter = component("inverter", inverterDefinition);
  inverter.state.temperatureC = 48;
  const connection = wire(
    "positive",
    "battery",
    "positive",
    "inverter",
    "dc-positive"
  );
  connection.state = { temperatureC: 90, currentAmps: 20, heatWatts: 5 };

  const reset = resetSimulation({
    ...snapshot([battery, inverter], [connection], 15),
    elapsedMinutes: 240
  });
  const resetBattery = reset.components.find(({ id }) => id === "battery");

  assert.equal(reset.elapsedMinutes, 0);
  assert.equal(resetBattery.state.stateOfCharge, 0.8);
  assert.equal(resetBattery.state.energyWh, 960);
  assert.ok(reset.components.every(({ state }) => state.temperatureC === 15));
  assert.ok(reset.wires.every(({ state }) => state.temperatureC === 15));
  assert.ok(reset.components.every(({ state }) => state.powerWatts === 0));
  assert.equal(reset.wires[0].from.componentId, "battery");
  assert.equal(reset.wires[0].to.componentId, "inverter");
});

test("numerically calibrates bulb cooling to a 2750 C peak", (context) => {
  const calibration = findCoolingCoefficient({
    evaluatePeak: (coefficient) => {
      const candidateCatalog = structuredClone(catalog);
      candidateCatalog.simulation.coolingCoefficientPerMinute = coefficient;
      return runLightScenario(candidateCatalog).peakTemperatures.light;
    },
    targetTemperatureC: 2750,
    lowerBound: 0.01,
    upperBound: 0.05,
    toleranceC: 0.05
  });

  context.diagnostic(
    `Calibrated coefficient: ${calibration.coefficient.toFixed(8)}/min; ` +
    `bulb peak: ${calibration.peakTemperatureC.toFixed(2)} °C; ` +
    `${calibration.iterations} bisection iterations`
  );
  assert.ok(calibration.peakTemperatureC >= 2500);
  assert.ok(calibration.peakTemperatureC <= 3000);
  assert.ok(Math.abs(calibration.peakTemperatureC - 2750) <= 0.05);
  assert.ok(calibration.coefficient > 0.025 && calibration.coefficient < 0.031);
});

test("cooling calibration rejects bounds that do not bracket the target", () => {
  assert.throws(
    () => findCoolingCoefficient({
      evaluatePeak: (coefficient) => 100 - coefficient,
      targetTemperatureC: 200,
      lowerBound: 0,
      upperBound: 1
    }),
    RangeError
  );
});

test("a 100 W light runs from 80 to 20 percent with only marginal battery warming", (context) => {
  const { system, peakTemperatures } = runLightScenario();

  const battery = system.components.find(({ id }) => id === "battery");
  context.diagnostic(`100 W light runtime: ${system.elapsedMinutes} minutes`);
  for (const [id, temperatureC] of Object.entries(peakTemperatures)) {
    context.diagnostic(`${id} peak: ${temperatureC.toFixed(2)} °C`);
  }
  assert.ok(system.elapsedMinutes >= 310 && system.elapsedMinutes <= 315);
  assert.ok(peakTemperatures.battery < 21);
  assert.ok(peakTemperatures.battery > 20);
  assert.ok(peakTemperatures.inverter > peakTemperatures.battery);
  assert.ok(peakTemperatures.light >= 2500 && peakTemperatures.light <= 3000);
  assert.ok(Math.abs(peakTemperatures.light - 2750) <= 1);
  assert.equal(system.report.operatingLoadIds[0], "light");
  assert.ok(battery.state.stateOfCharge <= 0.2);
});

test("a light wired with reversed AC terminals still operates and heats", () => {
  const components = [
    component("battery", batteryDefinition, 0, 120),
    component("inverter", inverterDefinition, 240, 120),
    component("light", lightDefinition, 480, 120)
  ];
  const wires = [
    wire("dc-positive", "battery", "positive", "inverter", "dc-positive"),
    wire("dc-negative", "battery", "negative", "inverter", "dc-negative"),
    wire("ac-line", "inverter", "ac-line", "light", "ac-neutral"),
    wire("ac-neutral", "inverter", "ac-neutral", "light", "ac-line")
  ];

  const next = simulateTick(snapshot(components, wires), 1);
  const light = next.components.find(({ id }) => id === "light");

  assert.ok(Math.abs(light.state.powerWatts - 100) < 0.01);
  assert.ok(Math.abs(light.state.heatWatts - 100) < 0.01);
  assert.ok(light.state.temperatureC > 20);
  assert.deepEqual(next.report.operatingLoadIds, ["light"]);
});

test("a connected hair dryer draws 1200 W and heats", () => {
  const components = [
    component("battery", batteryDefinition, 0, 120),
    component("inverter", inverterDefinition, 240, 120),
    component("hair-dryer", hairDryerDefinition, 480, 120)
  ];
  const wires = [
    wire("dc-positive", "battery", "positive", "inverter", "dc-positive"),
    wire("dc-negative", "battery", "negative", "inverter", "dc-negative"),
    wire("ac-line", "inverter", "ac-line", "hair-dryer", "ac-line"),
    wire("ac-neutral", "inverter", "ac-neutral", "hair-dryer", "ac-neutral")
  ];

  const next = simulateTick(snapshot(components, wires), 1);
  const hairDryer = next.components.find(({ id }) => id === "hair-dryer");

  assert.ok(Math.abs(hairDryer.state.powerWatts - 1200) < 0.1);
  assert.ok(hairDryer.state.temperatureC > 20);
  assert.deepEqual(next.report.operatingLoadIds, ["hair-dryer"]);
});

test("a connected fridge draws 400 W and heats", () => {
  const components = [
    component("battery", batteryDefinition, 0, 120),
    component("inverter", inverterDefinition, 240, 120),
    component("fridge", fridgeDefinition, 480, 120)
  ];
  const wires = [
    wire("dc-positive", "battery", "positive", "inverter", "dc-positive"),
    wire("dc-negative", "battery", "negative", "inverter", "dc-negative"),
    wire("ac-line", "inverter", "ac-line", "fridge", "ac-line"),
    wire("ac-neutral", "inverter", "ac-neutral", "fridge", "ac-neutral")
  ];

  const next = simulateTick(snapshot(components, wires), 1);
  const fridge = next.components.find(({ id }) => id === "fridge");

  assert.ok(Math.abs(fridge.state.powerWatts - 400) < 0.1);
  assert.ok(fridge.state.temperatureC > 20);
  assert.deepEqual(next.report.operatingLoadIds, ["fridge"]);
});

test("two 100 W incandescent lights in series each operate at reduced power and heat", () => {
  const components = [
    component("battery", batteryDefinition, 0, 120),
    component("inverter", inverterDefinition, 240, 120),
    component("light-a", lightDefinition, 480, 48),
    component("light-b", lightDefinition, 480, 192)
  ];
  const wires = [
    wire("dc-positive", "battery", "positive", "inverter", "dc-positive"),
    wire("dc-negative", "battery", "negative", "inverter", "dc-negative"),
    wire("series-start", "inverter", "ac-line", "light-a", "ac-line"),
    wire("series-middle", "light-a", "ac-neutral", "light-b", "ac-line"),
    wire("series-end", "light-b", "ac-neutral", "inverter", "ac-neutral")
  ];

  const next = simulateTick(snapshot(components, wires), 1);
  const firstLight = next.components.find(({ id }) => id === "light-a");
  const secondLight = next.components.find(({ id }) => id === "light-b");

  // Each rated bulb is 144 Ω. Two in series draw 120 V / 288 Ω,
  // so each dissipates I²R = 25 W.
  assert.ok(Math.abs(firstLight.state.powerWatts - 25) < 0.01);
  assert.ok(Math.abs(secondLight.state.powerWatts - 25) < 0.01);
  assert.ok(firstLight.state.temperatureC > 20);
  assert.ok(secondLight.state.temperatureC > 20);
  assert.deepEqual(
    [...next.report.operatingLoadIds].sort(),
    ["light-a", "light-b"]
  );
});

test("parallel batteries balance charge while powering a 100 W load", (context) => {
  const lowBattery = component("battery-low", batteryDefinition, 0, 48);
  lowBattery.state.energyWh = batteryDefinition.model.capacityWh * 0.2;
  lowBattery.state.stateOfCharge = 0.2;
  const highBattery = component("battery-high", batteryDefinition, 0, 192);
  highBattery.state.energyWh = batteryDefinition.model.capacityWh * 0.8;
  highBattery.state.stateOfCharge = 0.8;

  let system = snapshot(
    [
      lowBattery,
      highBattery,
      component("inverter", inverterDefinition, 240, 120),
      component("light", lightDefinition, 480, 120)
    ],
    [
      wire("low-positive", "battery-low", "positive", "inverter", "dc-positive"),
      wire("low-negative", "battery-low", "negative", "inverter", "dc-negative"),
      wire("high-positive", "battery-high", "positive", "inverter", "dc-positive"),
      wire("high-negative", "battery-high", "negative", "inverter", "dc-negative"),
      wire("ac-line", "inverter", "ac-line", "light", "ac-line"),
      wire("ac-neutral", "inverter", "ac-neutral", "light", "ac-neutral")
    ]
  );

  for (let minute = 0; minute < 5; minute += 1) {
    system = simulateTick(system, 1);
  }

  const lowAfter = system.components.find(({ id }) => id === "battery-low");
  const highAfter = system.components.find(({ id }) => id === "battery-high");

  context.diagnostic(
    `After 5 minutes: low battery ${lowAfter.state.energyWh.toFixed(2)} Wh ` +
    `(${(lowAfter.state.stateOfCharge * 100).toFixed(2)}%), ` +
    `high battery ${highAfter.state.energyWh.toFixed(2)} Wh ` +
    `(${(highAfter.state.stateOfCharge * 100).toFixed(2)}%)`
  );
  assert.ok(
    lowAfter.state.energyWh > lowBattery.state.energyWh,
    "the low-charge battery should receive balancing energy from the high-charge battery"
  );
  assert.ok(
    highAfter.state.energyWh < highBattery.state.energyWh,
    "the high-charge battery should supply balancing current and part of the load"
  );
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
