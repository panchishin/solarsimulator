// Shared test fixtures: the real catalog, and a tiny layout builder.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Catalog } from "../../engine/core/catalog.js";
import { GRID_SIZE_PX } from "../../engine/core/geometry.js";
import { World, createStaticEnvironment } from "../../engine/world.js";

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
    place(id, componentId, gridX = 0, gridY = 0, rotation = 0) {
      components.push({
        id,
        componentId,
        x: gridX * GRID_SIZE_PX,
        y: gridY * GRID_SIZE_PX,
        rotation
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

/** Assert `actual` is within `tolerance` (relative) of `expected`. */
export function closeTo(actual, expected, tolerance, message = "") {
  const allowed = Math.abs(expected) * tolerance + 1e-12;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > allowed) {
    throw new Error(
      `${message}expected ${expected} +/- ${(tolerance * 100).toFixed(3)} %, got ${actual}`
    );
  }
}
