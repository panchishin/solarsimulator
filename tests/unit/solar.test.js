// Phase 4: the sky drives the array.
//
// Nothing here asserts a capacity factor or a derate factor. The array's output is the solution
// of its own I-V curve at the irradiance and cell temperature the environment produces, and these
// tests check that against published figures for the same site.

import test from "node:test";
import assert from "node:assert/strict";
import { catalog, closeTo, layoutBuilder, siteEnvironment } from "../helpers/fixtures.js";

const FAT = "wire-cu-4-0awg-thhn";
const PV_WIRE = "wire-cu-10awg-thhn";
const PANEL = "pv-mono-300w";

/**
 * Two 300 W panels in series into an MPPT and a 48 V pack that starts nearly empty. The pack is
 * indoors, as it is in any real installation, so these tests see the array's behaviour rather than
 * the BMS refusing to charge cold cells; that lockout has a test of its own.
 */
function array({ environment, panels = [{}, {}], packIndoors = true }) {
  const builder = layoutBuilder()
    .place("mppt", "controller-mppt-50a", 14, 0)
    .place("bat", "battery-lifepo4-48v-100ah", 26, 0, { indoors: packIndoors })
    .wire("mppt", "battery-positive", "bat", "positive", FAT)
    .wire("mppt", "battery-negative", "bat", "negative", FAT);
  panels.forEach((extra, index) => builder.place(`pv${index + 1}`, PANEL, 0, index * 8, extra));
  for (let index = 0; index + 1 < panels.length; index += 1) {
    builder.wire(`pv${index + 1}`, "negative", `pv${index + 2}`, "positive", PV_WIRE);
  }
  builder
    .wire("pv1", "positive", "mppt", "pv-positive", PV_WIRE)
    .wire(`pv${panels.length}`, "negative", "mppt", "pv-negative", PV_WIRE);
  const world = builder.world({ environment });
  world.device("bat").state.stateOfCharge = 0.2;
  return world;
}

/** Run a whole day a minute at a time, integrating what the array made. */
function runDay(world, panelCount = 2) {
  let arrayWh = 0;
  let deliveredWh = 0;
  let peakWatts = 0;
  let peakCellC = -Infinity;
  for (let minute = 0; minute < 1440; minute += 1) {
    world.advanceMinutes(1);
    let watts = 0;
    for (let index = 1; index <= panelCount; index += 1) {
      watts += world.measure(`pv${index}`).powerWatts;
    }
    arrayWh += watts / 60;
    deliveredWh += Math.max(world.measure("mppt").powerWatts, 0) / 60;
    peakWatts = Math.max(peakWatts, watts);
    peakCellC = Math.max(peakCellC, world.measure("pv1").cellTemperatureC);
  }
  return { arrayWh, deliveredWh, peakWatts, peakCellC };
}

const NAMEPLATE_W = 600;

test("a clear June day in Denver yields what PVWatts reports for the same site", () => {
  const world = array({ environment: siteEnvironment("2024-06-21") });
  const day = runDay(world);
  const specificYield = day.arrayWh / NAMEPLATE_W;
  console.log(
    `June 21: array ${(day.arrayWh / 1000).toFixed(3)} kWh, delivered ${(day.deliveredWh / 1000).toFixed(3)} kWh, ` +
      `peak ${day.peakWatts.toFixed(0)} W, peak cell ${day.peakCellC.toFixed(0)} C, ` +
      `${specificYield.toFixed(2)} kWh/kWdc DC`
  );

  // PVWatts reports 1650 kWh/kWdc/yr for this site after 14 % system losses, so 4.52 kWh/kWdc on
  // an average day and roughly 5.5 on a June day. This figure is DC at the array, before those
  // losses, so it should land above the AC figure and below the June clear-sky ceiling.
  assert.ok(specificYield > 5.5, `${specificYield} kWh/kWdc is too low for June in Denver`);
  assert.ok(specificYield < 8, `${specificYield} kWh/kWdc is above the clear-sky ceiling`);

  // The array cannot beat its own aperture: POA energy times STC efficiency is the ceiling, and
  // the shortfall is the temperature coefficient doing its job.
  const optical = catalog.component(PANEL).model.optical;
  const stcEfficiency = 300 / (1000 * optical.areaM2);
  const environment = siteEnvironment("2024-06-21");
  let poaWhPerM2 = 0;
  for (let minute = 0; minute < 1440; minute += 1) {
    poaWhPerM2 += environment.at(minute * 60).planeOfArrayWPerM2 / 60;
  }
  const ceilingWh = poaWhPerM2 * optical.areaM2 * 2 * stcEfficiency;
  console.log(
    `POA ${(poaWhPerM2 / 1000).toFixed(3)} kWh/m2, STC-efficiency ceiling ${(ceilingWh / 1000).toFixed(3)} kWh, ` +
      `array reached ${((100 * day.arrayWh) / ceilingWh).toFixed(1)} %`
  );
  assert.ok(day.arrayWh < ceilingWh, "the array produced more than its aperture allows");
  assert.ok(day.arrayWh > 0.9 * ceilingWh, "a clear day should be close to the ceiling");

  // Peak power is below nameplate because a 42 C cell is not a 25 C cell.
  assert.ok(day.peakCellC > 35, `cell only reached ${day.peakCellC} C`);
  assert.ok(day.peakWatts < NAMEPLATE_W, `${day.peakWatts} W is at or above nameplate`);
  assert.equal(world.violations.length, 0);
});

test("a tilted array in December out-yields the horizontal sky it sits under", () => {
  // The whole point of a 40 degree tilt at 40 degrees latitude: in December the sun is low, so
  // the plane of array collects far more than a horizontal surface, and the two days are much
  // closer in POA than they are in GHI.
  const environment = siteEnvironment("2024-12-21");
  let poa = 0;
  let ghi = 0;
  for (let minute = 0; minute < 1440; minute += 1) {
    const sample = environment.at(minute * 60);
    poa += sample.planeOfArrayWPerM2 / 60;
    ghi += sample.globalHorizontalWPerM2 / 60;
  }
  console.log(`December 21: POA ${(poa / 1000).toFixed(3)} kWh/m2, GHI ${(ghi / 1000).toFixed(3)} kWh/m2`);
  assert.ok(poa / ghi > 1.7, `tilt gain was only ${(poa / ghi).toFixed(2)}`);

  const world = array({ environment: siteEnvironment("2024-12-21") });
  const day = runDay(world);
  const specificYield = day.arrayWh / NAMEPLATE_W;
  console.log(
    `December 21: array ${(day.arrayWh / 1000).toFixed(3)} kWh (${specificYield.toFixed(2)} kWh/kWdc), ` +
      `peak ${day.peakWatts.toFixed(0)} W, peak cell ${day.peakCellC.toFixed(0)} C`
  );
  // Fewer hours of sun, but colder cells: the day is worse than June by much less than the
  // difference in daylight hours suggests.
  assert.ok(specificYield > 4, `${specificYield} kWh/kWdc is too low`);
  assert.ok(day.peakCellC < 35, `December cells reached ${day.peakCellC} C`);
  // Colder cells make more power per unit of light, so a December noon out-peaks a June noon even
  // though the day is a third shorter.
  assert.ok(day.peakWatts > 540, `December peaked at only ${day.peakWatts.toFixed(0)} W`);
  assert.equal(world.violations.length, 0);
});

test("a pack left outdoors in December will not accept charge but still runs the load", () => {
  // Lithium plates onto the anode below freezing, so the BMS opens the charge path and leaves the
  // discharge path closed. The consequence is not a dead system: it is an array with nowhere to put
  // its energy while the lights go on drawing from a pack that cannot be refilled.
  const build = (indoors) => {
    const world = layoutBuilder()
      .place("pv1", PANEL, 0, 0)
      .place("mppt", "controller-mppt-50a", 14, 0)
      .place("bat", "battery-lifepo4-12v-100ah", 26, 0, { indoors })
      .place("lights", "load-dc-led-12v-20w", 26, 10)
      .wire("pv1", "positive", "mppt", "pv-positive", PV_WIRE)
      .wire("pv1", "negative", "mppt", "pv-negative", PV_WIRE)
      .wire("mppt", "battery-positive", "bat", "positive", FAT)
      .wire("mppt", "battery-negative", "bat", "negative", FAT)
      .wire("bat", "positive", "lights", "positive", PV_WIRE)
      .wire("bat", "negative", "lights", "negative", PV_WIRE)
      .world({ environment: siteEnvironment("2024-12-21") });
    world.device("bat").state.stateOfCharge = 0.9;
    return world;
  };

  const run = (world) => {
    let chargeWh = 0;
    let loadWh = 0;
    let lockedMinutes = 0;
    let coldestCellC = Infinity;
    let disconnectedMinutes = 0;
    let firstChargeHour = null;
    for (let minute = 0; minute < 1440; minute += 1) {
      world.advanceMinutes(1);
      const pack = world.measure("bat");
      if (pack.chargeLockedByCold) lockedMinutes += 1;
      if (!pack.contactorClosed) disconnectedMinutes += 1;
      coldestCellC = Math.min(coldestCellC, pack.cellTemperatureC);
      const charging = Math.max(pack.powerWatts, 0);
      if (charging > 1 && firstChargeHour === null) firstChargeHour = minute / 60;
      chargeWh += charging / 60;
      loadWh += world.measure("lights").powerWatts / 60;
    }
    return {
      chargeWh,
      loadWh,
      lockedMinutes,
      coldestCellC,
      disconnectedMinutes,
      firstChargeHour,
      stateOfCharge: world.measure("bat").stateOfCharge
    };
  };

  const outdoorWorld = build(false);
  const indoorWorld = build(true);
  const outdoor = run(outdoorWorld);
  const indoor = run(indoorWorld);
  const report = (label, day) =>
    console.log(
      `${label} pack: coldest cell ${day.coldestCellC.toFixed(1)} C, charge locked out for ` +
        `${day.lockedMinutes} min, first accepted charge at ` +
        `${day.firstChargeHour === null ? "never" : `${day.firstChargeHour.toFixed(1)} h`}, ` +
        `took ${day.chargeWh.toFixed(0)} Wh, ran ${day.loadWh.toFixed(0)} Wh of light, ` +
        `ended at SoC ${day.stateOfCharge.toFixed(3)}`
    );
  report("outdoor", outdoor);
  report("indoor", indoor);

  // The pack freezes overnight and stays locked out through the morning. A Denver December
  // afternoon does thaw it, so the lockout is most of the day rather than all of it.
  assert.ok(outdoor.coldestCellC < 0, `outdoor cell only fell to ${outdoor.coldestCellC} C`);
  assert.ok(outdoor.lockedMinutes > 600, `only locked out for ${outdoor.lockedMinutes} min`);
  assert.ok(outdoor.firstChargeHour > 12, `took charge from ${outdoor.firstChargeHour} h`);
  assert.equal(indoor.lockedMinutes, 0, "an 18 C pack has no reason to block charge below full");
  assert.ok(indoor.firstChargeHour < 9, `the indoor pack waited until ${indoor.firstChargeHour} h`);

  // Refusing charge is not disconnecting: the discharge path stays closed and the lights stay on.
  assert.equal(outdoor.disconnectedMinutes, 0, "the cold pack opened its contactor");
  assert.ok(outdoor.loadWh > 0.9 * indoor.loadWh, "the cold pack stopped running the lights");
  assert.ok(outdoor.loadWh > 400, `the lights only ran ${outdoor.loadWh.toFixed(0)} Wh`);

  // What it costs: the indoor pack banks the morning's sun and is full by midday, while the
  // outdoor one gets only the hour or two between thawing and sunset.
  assert.ok(indoor.chargeWh > 2 * outdoor.chargeWh, "the cold pack banked as much as the warm one");
  assert.ok(indoor.stateOfCharge > outdoor.stateOfCharge + 0.1, "the indoor pack should be ahead");
  assert.ok(outdoor.stateOfCharge < 0.9, "the outdoor pack should have lost ground overnight");
  assert.equal(outdoorWorld.violations.length, 0);
  assert.equal(indoorWorld.violations.length, 0);
});

test("panels on different roof faces see different light from the same sky", () => {
  const environment = siteEnvironment("2024-06-21");
  const world = array({
    environment,
    panels: [
      { tiltDeg: 30, surfaceAzimuthDeg: 90 }, // east face
      { tiltDeg: 30, surfaceAzimuthDeg: 270 } // west face
    ]
  });
  // Morning: the east panel is lit, the west panel is on diffuse only.
  world.advance(9 * 3600);
  const morning = [world.measure("pv1"), world.measure("pv2")];
  console.log(
    `09:00 east ${morning[0].irradianceWPerM2.toFixed(0)} W/m2, west ${morning[1].irradianceWPerM2.toFixed(0)} W/m2`
  );
  assert.ok(morning[0].irradianceWPerM2 > morning[1].irradianceWPerM2 * 1.4);

  // Afternoon: it reverses, from the sun's position alone.
  world.advance(8 * 3600);
  const afternoon = [world.measure("pv1"), world.measure("pv2")];
  console.log(
    `17:00 east ${afternoon[0].irradianceWPerM2.toFixed(0)} W/m2, west ${afternoon[1].irradianceWPerM2.toFixed(0)} W/m2`
  );
  assert.ok(afternoon[1].irradianceWPerM2 > afternoon[0].irradianceWPerM2 * 1.4);

  // Two panels in series, unequally lit: the string current is set by the weaker one, which is
  // exactly why an east-west string is a bad idea. Nothing in the code knows that.
  assert.ok(
    Math.abs(world.measure("pv1").currentAmps - world.measure("pv2").currentAmps) < 1e-6,
    "panels in series must carry the same current"
  );
});

test("shading one substring costs far more than its share of the panel", () => {
  const environment = siteEnvironment("2024-06-21");
  const clear = array({ environment: siteEnvironment("2024-06-21") });
  clear.advance(12 * 3600);
  const unshadedWatts = clear.measure("pv1").powerWatts + clear.measure("pv2").powerWatts;

  const shaded = array({ environment });
  // One of three substrings on one of two panels: one sixth of the array's cells.
  shaded.device("pv1").state.shading = [1, 0, 0];
  shaded.advance(12 * 3600);
  const shadedWatts = shaded.measure("pv1").powerWatts + shaded.measure("pv2").powerWatts;

  const cellFractionLost = 1 / 6;
  const powerFractionLost = 1 - shadedWatts / unshadedWatts;
  console.log(
    `noon: clear ${unshadedWatts.toFixed(0)} W, one substring shaded ${shadedWatts.toFixed(0)} W ` +
      `(lost ${(100 * powerFractionLost).toFixed(1)} % of the power for ${(100 * cellFractionLost).toFixed(1)} % of the cells)`
  );
  assert.ok(
    powerFractionLost > cellFractionLost,
    `losing ${powerFractionLost} of the power is too little for a shaded substring`
  );
  // The bypass diode is what stops it costing the whole string: without one, a shaded substring
  // in series would take the string to zero.
  assert.ok(powerFractionLost < 0.6, `losing ${powerFractionLost} of the power means no bypass`);

  const substrings = shaded.measure("pv1").substringIrradiance;
  console.log(`shaded panel substring irradiance: ${substrings.map((value) => value.toFixed(0)).join(", ")} W/m2`);
  closeTo(substrings[0], 0, 1e-9, "the shaded substring gets no light: ");
});

test("a shaded substring's bypass diode carries the string current and heats up", () => {
  const world = array({ environment: siteEnvironment("2024-06-21") });
  world.device("pv1").state.shading = [1, 0, 0];
  world.advance(12 * 3600);

  // The healthy panel and the healthy substrings push current through the shaded one; its bypass
  // diode conducts, so the shaded substring's contribution is a diode drop instead of 12 V.
  const panel = world.measure("pv1");
  const healthy = world.measure("pv2");
  console.log(
    `shaded panel ${panel.voltageVolts.toFixed(2)} V at ${panel.currentAmps.toFixed(2)} A, ` +
      `healthy panel ${healthy.voltageVolts.toFixed(2)} V, bypass loss ${(panel.bypassWatts ?? 0).toFixed(2)} W`
  );
  assert.ok(panel.voltageVolts < healthy.voltageVolts, "the shaded panel must hold less voltage");
  assert.ok(panel.voltageVolts > 0.5 * healthy.voltageVolts, "two of three substrings still work");
  assert.equal(world.violations.length, 0);
});
