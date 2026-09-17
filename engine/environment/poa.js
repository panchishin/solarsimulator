// Horizontal irradiance transposed onto a tilted plane.
//
// Sky diffuse uses Hay & Davies (1980): the diffuse light is split between a circumsolar part
// that follows the beam's geometry and an isotropic part that follows the sky view factor.
// Ground reflection is the isotropic single-bounce term. Both as given in Duffie & Beckman,
// Solar Engineering of Thermal Processes, ch. 2.

import { degToRad, radToDeg, clamp } from "../core/units.js";

// Below this elevation the geometric factor Rb = cos(theta)/cos(z) blows up on a division by
// a near-zero cosine, so the circumsolar term is dropped rather than allowed to dominate.
const MIN_ELEVATION_FOR_RB_DEG = 5;

/**
 * Plane-of-array irradiance, W/m^2, for a surface at `tiltDeg` from horizontal facing
 * `surfaceAzimuthDeg` (clockwise from true north, so 180 is due south).
 * `extraterrestrialNormalWPerM2` is SOLAR_CONSTANT * eccentricityCorrection.
 */
export function planeOfArrayIrradiance({
  directNormalWPerM2,
  diffuseHorizontalWPerM2,
  globalHorizontalWPerM2,
  zenithDeg,
  azimuthDeg,
  tiltDeg,
  surfaceAzimuthDeg,
  groundAlbedo,
  extraterrestrialNormalWPerM2
}) {
  const zenithRad = degToRad(zenithDeg);
  const tiltRad = degToRad(tiltDeg);
  const cosZenith = Math.cos(zenithRad);

  const cosIncidence = clamp(
    cosZenith * Math.cos(tiltRad) +
      Math.sin(zenithRad) * Math.sin(tiltRad) * Math.cos(degToRad(azimuthDeg - surfaceAzimuthDeg)),
    0,
    1
  );
  const beamWPerM2 = Math.max(directNormalWPerM2 * cosIncidence, 0);

  // Anisotropy index: how much of the extraterrestrial beam survived to the ground. A clear
  // sky pushes the diffuse weight towards the circumsolar term, an overcast one towards
  // isotropic.
  const anisotropyIndex =
    extraterrestrialNormalWPerM2 > 0
      ? clamp(directNormalWPerM2 / extraterrestrialNormalWPerM2, 0, 1)
      : 0;
  const sunHighEnough = 90 - zenithDeg > MIN_ELEVATION_FOR_RB_DEG && cosZenith > 0;
  const geometricFactor = sunHighEnough ? cosIncidence / cosZenith : 0;

  const skyDiffuseWPerM2 = Math.max(
    diffuseHorizontalWPerM2 *
      (anisotropyIndex * geometricFactor +
        (1 - anisotropyIndex) * ((1 + Math.cos(tiltRad)) / 2)),
    0
  );
  const groundReflectedWPerM2 = Math.max(
    globalHorizontalWPerM2 * groundAlbedo * ((1 - Math.cos(tiltRad)) / 2),
    0
  );

  return {
    planeOfArrayWPerM2: beamWPerM2 + skyDiffuseWPerM2 + groundReflectedWPerM2,
    beamWPerM2,
    skyDiffuseWPerM2,
    groundReflectedWPerM2,
    incidenceAngleDeg: radToDeg(Math.acos(cosIncidence))
  };
}

export { MIN_ELEVATION_FOR_RB_DEG };
