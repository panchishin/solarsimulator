// The environment provider the world consumes: sun position, clear-sky irradiance attenuated by
// a deterministic cloud series, ambient temperature and wind, all from the catalog's site and
// atmosphere blocks. Plane-of-array irradiance is a function the caller supplies its own
// orientation to, so two panels on different roof faces see different light.

import { solarPosition, sunriseSunsetHours } from "./sun.js";
import { clearSkyIrradiance } from "./clearSky.js";
import { planeOfArrayIrradiance } from "./poa.js";
import { createWeather } from "./weather.js";
import { SOLAR_CONSTANT } from "../core/units.js";

/**
 * US Standard Atmosphere barometric pressure at altitude, Pa. Bird's model needs the local
 * pressure, and the catalog records the site's altitude rather than duplicating a pressure that
 * has to agree with it.
 */
export function pressureAtAltitude(seaLevelPressurePa, altitudeM) {
  return seaLevelPressurePa * (1 - 2.25577e-5 * altitudeM) ** 5.25588;
}

export function createEnvironment({ catalog, startDate = new Date("2024-06-21T00:00:00Z"), site: siteOverride = {} }) {
  const site = { ...catalog.simulation.site, ...siteOverride };
  const atmosphere = catalog.simulation.atmosphere;
  const weatherSpec = catalog.simulation.weather;
  const weather = createWeather(weatherSpec);
  const pressurePa = pressureAtAltitude(atmosphere.seaLevelPressurePa, site.altitudeM);
  const startMs = startDate.getTime();
  const cache = new Map();

  function sample(timeSeconds) {
    const date = new Date(startMs + timeSeconds * 1000);
    const position = solarPosition({
      date,
      latitudeDeg: site.latitudeDeg,
      longitudeDeg: site.longitudeDeg
    });

    const clear = clearSkyIrradiance({
      zenithDeg: position.zenithDeg,
      airMass: position.airMass,
      eccentricityCorrection: position.eccentricityCorrection,
      pressurePa,
      ozoneCm: atmosphere.ozoneCm,
      precipitableWaterCm: atmosphere.precipitableWaterCm,
      aerosolOpticalDepth380: atmosphere.aerosolOpticalDepth380,
      aerosolOpticalDepth500: atmosphere.aerosolOpticalDepth500,
      forwardScatteringFraction: atmosphere.forwardScatteringFraction,
      aerosolAbsorptionFactor: atmosphere.aerosolAbsorptionFactor,
      groundAlbedo: site.groundAlbedo
    });

    // Cloud cover cuts the beam hard and the diffuse barely at all, which is why a cloudy day
    // still lights a panel but a shaded array loses most of its output.
    const hoursSinceEpoch = timeSeconds / 3600;
    const clearness = weather.clearnessAt(hoursSinceEpoch);
    const beamFraction = clearness ** 2;
    const directNormalWPerM2 = clear.directNormalWPerM2 * beamFraction;
    const globalHorizontalWPerM2 = clear.globalHorizontalWPerM2 * clearness;
    const diffuseHorizontalWPerM2 = Math.max(
      globalHorizontalWPerM2 - directNormalWPerM2 * Math.cos((position.zenithDeg * Math.PI) / 180),
      0
    );

    const localHour =
      (((date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600 + site.timeZoneHours) %
        24) +
        24) %
      24;
    const extraterrestrialNormalWPerM2 = SOLAR_CONSTANT * position.eccentricityCorrection;
    // Local day of year, so the annual temperature cycle lines up with the local calendar rather
    // than with UTC.
    const localDate = new Date(date.getTime() + site.timeZoneHours * 3600 * 1000);
    const dayOfYear =
      (localDate.getTime() - Date.UTC(localDate.getUTCFullYear(), 0, 1)) / 86400000 + 1;

    const entry = {
      date,
      timeSeconds,
      localHour,
      dayOfYear,
      ambientTemperatureC: weather.ambientTemperatureC(localHour, dayOfYear),
      windSpeedMPerS: weather.windSpeedMPerS,
      clearness,
      solarElevationDeg: position.elevationDeg,
      solarAzimuthDeg: position.azimuthDeg,
      zenithDeg: position.zenithDeg,
      airMass: position.airMass,
      extraterrestrialNormalWPerM2,
      directNormalWPerM2,
      diffuseHorizontalWPerM2,
      globalHorizontalWPerM2,
      clearSky: clear,
      planeOfArray({ tiltDeg = site.arrayTiltDeg, surfaceAzimuthDeg = site.arrayAzimuthDeg } = {}) {
        return planeOfArrayIrradiance({
          directNormalWPerM2,
          diffuseHorizontalWPerM2,
          globalHorizontalWPerM2,
          zenithDeg: position.zenithDeg,
          azimuthDeg: position.azimuthDeg,
          tiltDeg,
          surfaceAzimuthDeg,
          groundAlbedo: site.groundAlbedo,
          extraterrestrialNormalWPerM2
        });
      }
    };
    // Filled in for consumers that only want the site default orientation.
    entry.planeOfArrayWPerM2 = entry.planeOfArray().planeOfArrayWPerM2;
    return entry;
  }

  return {
    site,
    atmosphere,
    pressurePa,
    startDate,
    weather,
    at(timeSeconds) {
      // The integrator re-solves the same instant many times per step (line search, mode
      // reconciliation, event bisection), so the sky is computed once per millisecond of
      // simulated time.
      const key = Math.round(timeSeconds * 1000);
      let entry = cache.get(key);
      if (entry === undefined) {
        entry = sample(timeSeconds);
        if (cache.size > 4096) cache.clear();
        cache.set(key, entry);
      }
      return entry;
    },
    daylight(timeSeconds = 0) {
      return sunriseSunsetHours({
        date: new Date(startMs + timeSeconds * 1000),
        latitudeDeg: site.latitudeDeg,
        longitudeDeg: site.longitudeDeg,
        timeZoneHours: site.timeZoneHours
      });
    }
  };
}
