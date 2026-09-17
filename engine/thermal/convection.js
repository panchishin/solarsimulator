// Convection and radiation coefficients from the surface geometry declared in the catalog.
// There is no global cooling coefficient anywhere in the engine: a device cools at the rate
// its stated area, characteristic length and orientation imply.
//
// Correlations: Churchill & Chu (1975) for free convection, Incropera Ch. 7 for the forced
// flat plate. See engine/PHYSICS.md section 3.

import { GRAVITY, STEFAN_BOLTZMANN, toKelvin } from "../core/units.js";
import { airProperties } from "../core/catalog.js";

const CHURCHILL_CHU = {
  verticalPlate: { constant: 0.68, coefficient: 0.670, prandtlTerm: 0.492 },
  horizontalCylinder: { constant: 0.36, coefficient: 0.518, prandtlTerm: 0.559 },
  sphere: { constant: 2.0, coefficient: 0.589, prandtlTerm: 0.469 }
};

/** Rayleigh number for a surface at `surfaceC` in air at `ambientC`. */
export function rayleigh({ air, characteristicLengthM, surfaceC, ambientC }) {
  const filmK = toKelvin((surfaceC + ambientC) / 2);
  const properties = airProperties(air, filmK);
  const diffusivity = properties.kinematicViscosityM2PerS / properties.prandtl;
  const expansion = 1 / filmK;
  const value =
    (GRAVITY * expansion * Math.abs(surfaceC - ambientC) * characteristicLengthM ** 3) /
    (properties.kinematicViscosityM2PerS * diffusivity);
  return { rayleigh: value, properties };
}

/**
 * Natural convection coefficient, W/m^2K. `geometry` selects the correlation; a horizontal
 * plate uses the vertical-plate form scaled by 0.7, the standard allowance for the weaker
 * plume over an upward-facing surface.
 */
export function naturalConvectionCoefficient({
  geometry,
  air,
  characteristicLengthM,
  surfaceC,
  ambientC
}) {
  if (!(characteristicLengthM > 0)) return 0;
  const shape = CHURCHILL_CHU[geometry === "horizontalPlate" ? "verticalPlate" : geometry] ??
    CHURCHILL_CHU.verticalPlate;
  const { rayleigh: ra, properties } = rayleigh({ air, characteristicLengthM, surfaceC, ambientC });
  if (!(ra > 0)) return 0;
  const denominator = (1 + (shape.prandtlTerm / properties.prandtl) ** (9 / 16)) ** (4 / 9);
  const nusselt = shape.constant + (shape.coefficient * ra ** 0.25) / denominator;
  const coefficient = (nusselt * properties.conductivityWPerMK) / characteristicLengthM;
  return geometry === "horizontalPlate" ? 0.7 * coefficient : coefficient;
}

/** Average forced-convection coefficient over a flat plate in laminar flow, W/m^2K. */
export function forcedConvectionCoefficient({
  air,
  characteristicLengthM,
  velocityMPerS,
  surfaceC,
  ambientC
}) {
  if (!(velocityMPerS > 0) || !(characteristicLengthM > 0)) return 0;
  const filmK = toKelvin((surfaceC + ambientC) / 2);
  const properties = airProperties(air, filmK);
  const reynolds = (velocityMPerS * characteristicLengthM) / properties.kinematicViscosityM2PerS;
  const nusselt = 0.664 * Math.sqrt(reynolds) * properties.prandtl ** (1 / 3);
  return (nusselt * properties.conductivityWPerMK) / characteristicLengthM;
}

/**
 * Radiative heat flow between a surface and a background, W, and its derivative with respect
 * to the surface temperature, W/K. The derivative is what the implicit thermal step needs.
 */
export function radiation({ emissivity, areaM2, viewFactor = 1, surfaceC, backgroundC }) {
  const factor = emissivity * STEFAN_BOLTZMANN * areaM2 * viewFactor;
  const surfaceK = toKelvin(surfaceC);
  const backgroundK = toKelvin(backgroundC);
  return {
    watts: factor * (surfaceK ** 4 - backgroundK ** 4),
    slopeSurface: 4 * factor * surfaceK ** 3,
    slopeBackground: -4 * factor * backgroundK ** 3
  };
}

/**
 * Heat carried away by a device's own air stream, W/K. This is enthalpy flow, mdot*cp, not a
 * convection correlation: for a hair dryer the fan sets the cooling, not the surface.
 */
export const airStreamConductance = ({ air, massFlowKgPerS }) =>
  Math.max(massFlowKgPerS, 0) * air.specificHeatJPerKgC;

/**
 * Total conductance from a surface to ambient, W/K, and the radiative slope. Convection uses
 * whichever of forced and natural is stronger, since a fan cannot make a surface cool slower
 * than still air would.
 */
export function surfaceConductance({ surface, material, air, surfaceC, ambientC, windSpeedMPerS = 0, fanRunning = true }) {
  if (surface.geometry === "faiman") {
    // Faiman's module coefficient already lumps convection and radiation together.
    const u0 = surface.faimanU0 ?? 25;
    const u1 = surface.faimanU1 ?? 6.84;
    return { conductanceWPerK: surface.areaM2 * (u0 + u1 * windSpeedMPerS), radiationSlope: 0 };
  }
  if (surface.geometry === "airStream") {
    return {
      conductanceWPerK: airStreamConductance({ air, massFlowKgPerS: surface.airStreamMassFlowKgPerS }),
      radiationSlope: 0
    };
  }

  const naturalH = naturalConvectionCoefficient({
    geometry: surface.geometry,
    air,
    characteristicLengthM: surface.characteristicLengthM,
    surfaceC,
    ambientC
  });
  const forcedVelocity = fanRunning ? (surface.forcedAirVelocityMPerS ?? 0) : 0;
  const forcedH = forcedConvectionCoefficient({
    air,
    characteristicLengthM: surface.characteristicLengthM,
    velocityMPerS: Math.max(forcedVelocity, windSpeedMPerS),
    surfaceC,
    ambientC
  });
  const convective = Math.max(naturalH, forcedH) * surface.areaM2;
  const radiative = radiation({
    emissivity: surface.emissivity ?? material.emissivity ?? 0.9,
    areaM2: surface.areaM2,
    surfaceC,
    backgroundC: ambientC
  });
  return { conductanceWPerK: convective, radiationSlope: radiative.slopeSurface, radiationWatts: radiative.watts };
}
