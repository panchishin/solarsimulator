// Broadband clear-sky irradiance: Bird & Hulstrom (1981), SERI/TR-642-761.
//
// Five independent transmittances (Rayleigh, ozone, uniformly mixed gases, water vapour,
// aerosol) attenuate the extraterrestrial beam; the diffuse term collects forward-scattered
// aerosol and Rayleigh light and then bounces once between ground and sky.
//
// Every atmospheric parameter is an argument. Station pressure, ozone column, precipitable
// water and the two aerosol optical depths belong to a site in the catalog, not to this file.

import { SOLAR_CONSTANT, degToRad } from "../core/units.js";

/** Sea-level standard pressure, Pa, the reference for Bird's pressure-corrected air mass. */
const STANDARD_PRESSURE_PA = 101325;

/**
 * Direct normal, diffuse horizontal and global horizontal irradiance, W/m^2, for a cloudless
 * sky. `airMass` and `eccentricityCorrection` come from solarPosition(). All three outputs
 * are zero once the sun is below the horizon, where the model has no meaning.
 */
export function clearSkyIrradiance({
  zenithDeg,
  airMass,
  eccentricityCorrection = 1,
  pressurePa = STANDARD_PRESSURE_PA,
  ozoneCm,
  precipitableWaterCm,
  aerosolOpticalDepth380,
  aerosolOpticalDepth500,
  forwardScatteringFraction,
  aerosolAbsorptionFactor,
  groundAlbedo
}) {
  const dark = { directNormalWPerM2: 0, diffuseHorizontalWPerM2: 0, globalHorizontalWPerM2: 0 };
  if (!(zenithDeg < 90) || !Number.isFinite(airMass) || !(airMass > 0)) return dark;

  const cosZenith = Math.cos(degToRad(zenithDeg));
  if (!(cosZenith > 0)) return dark;

  const i0 = SOLAR_CONSTANT * eccentricityCorrection;
  const m = airMass;
  const mp = (m * pressurePa) / STANDARD_PRESSURE_PA;

  const tr = Math.exp(-0.0903 * mp ** 0.84 * (1 + mp - mp ** 1.01));

  const xo = ozoneCm * m;
  const to =
    1 -
    0.1611 * xo * (1 + 139.48 * xo) ** -0.3034 -
    (0.002715 * xo) / (1 + 0.044 * xo + 0.0003 * xo ** 2);

  const tg = Math.exp(-0.0127 * mp ** 0.26);

  const xw = precipitableWaterCm * m;
  const tw = 1 - (2.4959 * xw) / ((1 + 79.034 * xw) ** 0.6828 + 6.385 * xw);

  // Bird's broadband aerosol depth is a fixed weighting of the 380 nm and 500 nm depths.
  const tau = 0.2758 * aerosolOpticalDepth380 + 0.35 * aerosolOpticalDepth500;
  const ta = Math.exp(-(tau ** 0.873) * (1 + tau - tau ** 0.7088) * m ** 0.9108);

  // Split the aerosol extinction into absorption (Taa) and scattering (Tas): only the
  // scattered part can end up in the diffuse component.
  const taa = 1 - aerosolAbsorptionFactor * (1 - m + m ** 1.06) * (1 - ta);
  const tas = ta / taa;

  // 0.9662 removes the part of the solar spectrum outside the model's broadband window.
  const directNormal = 0.9662 * i0 * tr * to * tg * tw * ta;

  const scatteredDiffuse =
    (i0 *
      cosZenith *
      0.79 *
      to *
      tg *
      tw *
      taa *
      (forwardScatteringFraction * (1 - tas) + 0.5 * (1 - tr))) /
    (1 - m + m ** 1.02);

  const skyAlbedo = 0.0685 + (1 - forwardScatteringFraction) * (1 - tas);
  const global =
    (directNormal * cosZenith + scatteredDiffuse) / (1 - groundAlbedo * skyAlbedo);

  const globalHorizontalWPerM2 = Math.max(global, 0);
  const directNormalWPerM2 = Math.max(directNormal, 0);
  return {
    directNormalWPerM2,
    diffuseHorizontalWPerM2: Math.max(globalHorizontalWPerM2 - directNormalWPerM2 * cosZenith, 0),
    globalHorizontalWPerM2
  };
}

export { STANDARD_PRESSURE_PA };
