// Shared test fixtures: the real catalog, and a tiny layout builder.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Catalog } from "../../engine/core/catalog.js";
import { GRID_SIZE_PX } from "../../engine/core/geometry.js";
import { World, createStaticEnvironment } from "../../engine/world.js";
import { createWireDevice } from "../../engine/devices/wire.js";
import { ThermalNetwork, DeviceThermal } from "../../engine/thermal/network.js";
import { createEnvironment } from "../../engine/environment/site.js";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

export const catalogJson = JSON.parse(
  readFileSync(join(repoRoot, "catalog", "catalog.v3.json"), "utf8")
);

export const catalog = new Catalog(catalogJson);

/**
 * Build a layout from a compact description.
 *
 * `place("bat", "battery-lifepo4-12v-100ah", 0, 0)` puts a component at grid (0, 0);
 * `wire("bat", "positive", "load", "positive", "wire-cu-10awg-thhn")` runs a conductor;
 * `join(...)` makes an ideal connection with no conductor, for isolating one device.
 */
export function layoutBuilder() {
  const components = [];
  const wires = [];
  const joins = [];
  let counter = 0;

  const api = {
    /**
     * `extra` becomes part of the layout component, which is what a device sees as
     * `this.instance`: per-panel `tiltDeg`/`surfaceAzimuthDeg`, `state.shading`, and so on.
     */
    place(id, componentId, gridX = 0, gridY = 0, extra = {}) {
      components.push({
        id,
        componentId,
        x: gridX * GRID_SIZE_PX,
        y: gridY * GRID_SIZE_PX,
        rotation: 0,
        ...extra
      });
      return api;
    },
    wire(fromId, fromTerminal, toId, toTerminal, wireTypeId = "wire-cu-2awg-thhn", id = null) {
      wires.push({
        id: id ?? `w${counter++}`,
        wireTypeId,
        from: { componentId: fromId, terminalId: fromTerminal },
        to: { componentId: toId, terminalId: toTerminal }
      });
      return api;
    },
    join(fromId, fromTerminal, toId, toTerminal) {
      joins.push([
        { componentId: fromId, terminalId: fromTerminal },
        { componentId: toId, terminalId: toTerminal }
      ]);
      return api;
    },
    layout() {
      return { components, wires, joins };
    },
    world(options = {}) {
      return new World({ catalog, layout: api.layout(), ...options });
    }
  };
  return api;
}

export const staticEnvironment = (ambientTemperatureC = 20, windSpeedMPerS = 0, planeOfArrayWPerM2 = 0) =>
  createStaticEnvironment({ ambientTemperatureC, windSpeedMPerS, planeOfArrayWPerM2 });

/**
 * The catalog's site (Denver) on a given local date, starting at local midnight so that a
 * 24 hour run is one calendar day.
 */
export function siteEnvironment(localDate = "2024-06-21", site = {}) {
  const timeZoneHours = { ...catalog.simulation.site, ...site }.timeZoneHours;
  const offset = `${timeZoneHours <= 0 ? "-" : "+"}${String(Math.abs(timeZoneHours)).padStart(2, "0")}:00`;
  return createEnvironment({
    catalog,
    startDate: new Date(`${localDate}T00:00:00${offset}`),
    site
  });
}

/** Assert `actual` is within `tolerance` (relative) of `expected`. */
export function closeTo(actual, expected, tolerance, message = "") {
  const allowed = Math.abs(expected) * tolerance + 1e-12;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > allowed) {
    throw new Error(
      `${message}expected ${expected} +/- ${(tolerance * 100).toFixed(3)} %, got ${actual}`
    );
  }
}

/**
 * A bare conductor in still air, held at a fixed current until its temperature stops moving.
 * Nothing here consults an ampacity table: the current makes I^2R, the geometry sheds it.
 */
export function conductorSteadyState({ wireTypeId, amps, ambientC = 30, lengthGrid = 20 }) {
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
