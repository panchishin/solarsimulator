// Material property helpers. Every number comes from `catalog.materials`.

export { resistivityAt, airProperties } from "../core/catalog.js";

export const heatCapacityJPerK = (material, massKg) => massKg * material.specificHeatJPerKgC;

export const emissivity = (material) => material.emissivity ?? 0.9;

/** Temperature at which the material starts to burn, or null if it cannot ignite. */
export const ignitionTemperatureC = (material) => material.ignitionTemperatureC ?? null;

/** Temperature at which the material loses mechanical integrity. */
export function failureTemperatureC(material) {
  return (
    material.meltingPointC ??
    material.softeningTemperatureC ??
    material.ignitionTemperatureC ??
    null
  );
}

export const heatOfCombustionJPerKg = (material) => material.heatOfCombustionJPerKg ?? 0;

/**
 * Arrhenius self-heating power of a decomposing cell, W. Zero below the onset temperature,
 * which is where the reaction rate first matters at all (engine/PHYSICS.md section 10).
 */
export function runawayPowerWatts(material, temperatureC, massKg, gasConstant) {
  const onset = material.runawayOnsetTemperatureC;
  if (onset === undefined || temperatureC < onset - 40) return 0;
  const temperatureK = temperatureC + 273.15;
  const rate =
    material.runawayPreExponentialPerS *
    Math.exp(-material.runawayActivationEnergyJPerMol / (gasConstant * temperatureK));
  return massKg * material.runawayHeatJPerKg * rate;
}
