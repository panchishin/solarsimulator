// Shared test fixtures: the real catalog, and a tiny layout builder.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Catalog } from "../../engine/core/catalog.js";
import { GRID_SIZE_PX } from "../../engine/core/geometry.js";
import { World, createStaticEnvironment } from "../../engine/world.js";
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
