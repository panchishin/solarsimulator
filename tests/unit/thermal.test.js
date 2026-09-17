import test from "node:test";
import assert from "node:assert/strict";
import { catalog, layoutBuilder, staticEnvironment } from "../helpers/fixtures.js";
import { createWireDevice } from "../../engine/devices/wire.js";
import { ThermalNetwork, DeviceThermal } from "../../engine/thermal/network.js";
import { GRID_SIZE_PX } from "../../engine/core/geometry.js";
import { rayleigh, naturalConvectionCoefficient, radiation } from "../../engine/thermal/convection.js";

/**
 * A bare conductor in still air, held at a fixed current until its temperature stops moving.
 * Nothing here consults an ampacity table: the current makes I^2R, the geometry sheds it.
 */
function conductorSteadyState({ wireTypeId, amps, ambientC = 30, lengthGrid = 20 }) {
  const componentsById = new Map([
    ["a", { id: "a", componentId: "busbar-250a", x: 0, y: 0 }],
    ["b", { id: "b", componentId: "busbar-250a", x: lengthGrid * GRID_SIZE_PX, y: 0 }]
  ]);
  const device = createWireDevice({
    catalog,
    wire: {
      id: "w",
      wireTypeId,
      from: { componentId: "a", terminalId: "a" },
      to: { componentId: "b", terminalId: "a" }
    },
    componentsById,
    settings: catalog.settings
  });

  const network = new ThermalNetwork({ catalog, ambientC });
  for (const node of device.thermalNodes) {
    network.addNode({ key: `w##${node.name}`, deviceId: "w", ...node });
  }
  for (const link of device.thermalLinks) {
    network.addLink(`w##${link.from}`, `w##${link.to}`, link.conductanceWPerK);
  }
  device.thermal = new DeviceThermal({
    network,
    deviceId: "w",
    nodeNames: device.thermalNodes.map((node) => node.name),
    heatNodeName: device.heatNodeName
  });

  // R depends on temperature and temperature depends on R, so iterate the pair to a fixed point.
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const resistance = device.resistanceOhms(device.thermal.temperature("conductor"));
    device.thermal.applyHeat({ conductor: amps * amps * resistance, insulation: 0 });
    const { maxChangeC } = network.steadyState();
    if (maxChangeC < 1e-9) break;
  }
  return {
    conductorC: device.thermal.temperature("conductor"),
    insulationC: device.thermal.temperature("insulation"),
    lengthM: device.lengthM,
    resistanceOhms: device.resistanceOhms(device.thermal.temperature("conductor")),
    watts: amps * amps * device.resistanceOhms(device.thermal.temperature("conductor"))
  };
}

test("Rayleigh number and natural convection follow Churchill-Chu", () => {
  // Incropera example: a 60 mm horizontal cylinder at 100 C in 20 C air has Ra of order 1e6
  // and a coefficient of order 6-8 W/m2K.
  const air = catalog.material("air");
  const { rayleigh: ra } = rayleigh({ air, surfaceC: 100, ambientC: 20, characteristicLengthM: 0.06 });
  assert.ok(ra > 1e5 && ra < 1e7, `Ra was ${ra.toExponential(2)}`);
  const h = naturalConvectionCoefficient({
    air,
    surfaceC: 100,
    ambientC: 20,
    characteristicLengthM: 0.06,
    geometry: "horizontalCylinder"
  });
  assert.ok(h > 4 && h < 12, `h was ${h}`);
});

test("radiation matches the Stefan-Boltzmann law and its own slope", () => {
  const { watts, slopeSurface } = radiation({
    emissivity: 1,
    areaM2: 1,
    viewFactor: 1,
    surfaceC: 100,
    backgroundC: 20
  });
  const sigma = 5.670374419e-8;
  const exact = sigma * (373.15 ** 4 - 293.15 ** 4);
  assert.ok(Math.abs(watts - exact) / exact < 1e-9, `${watts} vs ${exact}`);

  // The analytic slope has to agree with a finite difference, or the thermal Newton stalls.
  const step = 1e-4;
  const up = radiation({
    emissivity: 1,
    areaM2: 1,
    viewFactor: 1,
    surfaceC: 100 + step,
    backgroundC: 20
  }).watts;
  const numeric = (up - watts) / step;
  assert.ok(Math.abs(numeric - slopeSurface) / slopeSurface < 1e-4);
});

test("a conductor at its NEC free-air ampacity lands near its rated temperature", () => {
  // NEC Table 310.17 gives the current at which a single insulated conductor in free air reaches
  // its insulation rating in a 30 C ambient. The model is given the current and the geometry,
  // never the table, so this is a real comparison.
  const rows = [
    ["wire-cu-14awg-thhn", "14", 30],
    ["wire-cu-10awg-thhn", "10", 50],
    ["wire-cu-6awg-thhn", "6", 95],
    ["wire-cu-2awg-thhn", "2", 170]
  ];
  const report = [];
  for (const [wireTypeId, gauge, ratedAmps] of rows) {
    const at = conductorSteadyState({ wireTypeId, amps: ratedAmps, ambientC: 30 });
    report.push(
      `${gauge} AWG at ${ratedAmps} A: conductor ${at.conductorC.toFixed(0)} C, insulation ${at.insulationC.toFixed(0)} C (${at.watts.toFixed(1)} W over ${at.lengthM.toFixed(1)} m)`
    );
    // The 75 C column is a 45 K rise over ambient. A lumped single-cylinder model in still air
    // should land in the same neighbourhood; well outside 40-140 C would mean the geometry or the
    // correlations are wrong.
    assert.ok(
      at.conductorC > 40 && at.conductorC < 140,
      `${gauge} AWG reached ${at.conductorC} C at its rated ${ratedAmps} A`
    );
  }
  console.log(report.join("\n"));
});

test("a conductor carrying five times its rating runs far above its insulation rating", () => {
  const rated = conductorSteadyState({ wireTypeId: "wire-cu-10awg-thhn", amps: 50 });
  const abused = conductorSteadyState({ wireTypeId: "wire-cu-10awg-thhn", amps: 250 });
  assert.ok(abused.conductorC > rated.conductorC + 200, `${abused.conductorC} vs ${rated.conductorC}`);
  assert.ok(abused.insulationC > 90, "insulation should be past its 90 C rating");
});

test("a thicker conductor at the same current runs cooler", () => {
  const thin = conductorSteadyState({ wireTypeId: "wire-cu-14awg-thhn", amps: 30 });
  const thick = conductorSteadyState({ wireTypeId: "wire-cu-6awg-thhn", amps: 30 });
  assert.ok(thick.conductorC < thin.conductorC - 10, `${thick.conductorC} vs ${thin.conductorC}`);
});

test("the insulation is always cooler than the conductor it covers", () => {
  const at = conductorSteadyState({ wireTypeId: "wire-cu-10awg-thhn", amps: 80 });
  assert.ok(at.insulationC < at.conductorC);
  assert.ok(at.insulationC > 30);
});

test("an incandescent lamp reaches filament colour temperature with a cool envelope", () => {
  const world = layoutBuilder()
    .place("bat", "battery-lifepo4-12v-100ah", 0, 0)
    .place("inv", "inverter-12v-1000w", 10, 0)
    .place("lamp", "load-incandescent-100w", 22, 0)
    .wire("bat", "positive", "inv", "dc-positive", "wire-cu-4-0awg-thhn")
    .wire("bat", "negative", "inv", "dc-negative", "wire-cu-4-0awg-thhn")
    .wire("inv", "ac-line", "lamp", "ac-line", "wire-cu-14awg-thhn")
    .wire("lamp", "ac-neutral", "inv", "ac-neutral", "wire-cu-14awg-thhn")
    .world({ environment: staticEnvironment(20) });

  world.advanceMinutes(30);
  const lamp = world.measure("lamp");
  console.log(
    `filament ${lamp.filamentTemperatureC.toFixed(0)} C, envelope ${lamp.envelopeTemperatureC.toFixed(0)} C, ` +
      `${lamp.powerWatts.toFixed(1)} W, R ${lamp.resistanceOhms.toFixed(1)} ohm`
  );
  // GE's lamp handbook puts a 100 W household filament near 2700 C. Nothing sets that number:
  // it is where the tungsten resistivity power law and the radiating area balance.
  assert.ok(
    lamp.filamentTemperatureC > 2400 && lamp.filamentTemperatureC < 3000,
    `filament settled at ${lamp.filamentTemperatureC} C`
  );
  assert.ok(lamp.envelopeTemperatureC < 250, `envelope reached ${lamp.envelopeTemperatureC} C`);
  assert.ok(lamp.powerWatts > 80 && lamp.powerWatts < 125, `lamp drew ${lamp.powerWatts} W`);
  // Hot resistance about 16 times the cold value, per the same handbook.
  assert.ok(lamp.resistanceOhms > 110 && lamp.resistanceOhms < 175);
});

test("the whole world shares one thermal network", () => {
  const world = layoutBuilder()
    .place("bat", "battery-lifepo4-12v-100ah", 0, 0)
    .place("heater", "load-dc-heater-12v-100w", 12, 0)
    .wire("bat", "positive", "heater", "positive", "wire-cu-14awg-thhn")
    .wire("heater", "negative", "bat", "negative", "wire-cu-14awg-thhn")
    .world({ environment: staticEnvironment(20) });
  const keys = [...world.thermalNetwork.indexByKey.keys()];
  assert.ok(keys.some((key) => key.startsWith("bat##")));
  assert.ok(keys.some((key) => key.startsWith("heater##")));
  assert.ok(keys.filter((key) => key.endsWith("##conductor")).length === 2);
});

test("ambient temperature comes from the environment, not from a constant", () => {
  const cold = layoutBuilder()
    .place("bat", "battery-lifepo4-12v-100ah", 0, 0)
    .place("heater", "load-dc-heater-12v-100w", 12, 0)
    .wire("bat", "positive", "heater", "positive", "wire-cu-14awg-thhn")
    .wire("heater", "negative", "bat", "negative", "wire-cu-14awg-thhn")
    .world({ environment: staticEnvironment(-10) });
  const hot = layoutBuilder()
    .place("bat", "battery-lifepo4-12v-100ah", 0, 0)
    .place("heater", "load-dc-heater-12v-100w", 12, 0)
    .wire("bat", "positive", "heater", "positive", "wire-cu-14awg-thhn")
    .wire("heater", "negative", "bat", "negative", "wire-cu-14awg-thhn")
    .world({ environment: staticEnvironment(45) });
  cold.advanceMinutes(5);
  hot.advanceMinutes(5);
  const coldWire = cold.devices.find((device) => device.kind === "wire").id;
  const hotWire = hot.devices.find((device) => device.kind === "wire").id;
  assert.ok(cold.measure(coldWire).conductorTemperatureC < hot.measure(hotWire).conductorTemperatureC - 40);
});
