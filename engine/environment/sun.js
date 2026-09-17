// Where the sun is, from a date and a place on the globe.
//
// Position uses the NOAA Solar Calculator's low-precision equations (after Meeus,
// Astronomical Algorithms), good to about 0.1 degree over the years that matter here.
// Relative air mass is Kasten & Young (1989). The eccentricity correction to the
// extraterrestrial beam is Spencer (1971), as tabulated by Duffie & Beckman.
//
// Nothing about a site is baked in: latitude, longitude and time zone are arguments.

import { degToRad, radToDeg, clamp } from "../core/units.js";

/** Day of year, 1..366, for the UTC instant of `date`. */
function dayOfYearUTC(date) {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((startOfDay - startOfYear) / 86400000) + 1;
}

/** UTC minutes elapsed since midnight, fractional. */
function minutesOfDayUTC(date) {
  return (
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000
  );
}

/**
 * Fractional year gamma, radians, plus the three NOAA series that depend only on it:
 * equation of time, declination and the orbital eccentricity correction.
 */
export function solarOrbit(date) {
  const hourUTC = minutesOfDayUTC(date) / 60;
  const gamma = ((2 * Math.PI) / 365) * (dayOfYearUTC(date) - 1 + (hourUTC - 12) / 24);
  const equationOfTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const declinationRad =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const eccentricityCorrection =
    1.00011 +
    0.034221 * Math.cos(gamma) +
    0.00128 * Math.sin(gamma) +
    0.000719 * Math.cos(2 * gamma) +
    0.000077 * Math.sin(2 * gamma);
  return { gamma, equationOfTimeMinutes, declinationRad, eccentricityCorrection };
}

/**
 * Relative optical air mass at `zenithDeg`, Kasten & Young (1989). Their fit refuses to
 * behave past the horizon, so a sun below it reports Infinity rather than a small number:
 * callers must gate on elevation, not on air mass being finite.
 */
export function airMassKastenYoung(zenithDeg) {
  if (zenithDeg >= 90) return Number.POSITIVE_INFINITY;
  const cosZenith = Math.cos(degToRad(zenithDeg));
  return 1 / (cosZenith + 0.50572 * (96.07995 - zenithDeg) ** -1.6364);
}

/**
 * Sun position for the UTC instant `date` as seen from (`latitudeDeg`, `longitudeDeg`),
 * longitude positive east. Azimuth is clockwise from true north, 0..360.
 */
export function solarPosition({ date, latitudeDeg, longitudeDeg }) {
  const { equationOfTimeMinutes, declinationRad, eccentricityCorrection } = solarOrbit(date);

  // True solar time folds the longitude offset (4 minutes per degree) and the equation of
  // time into the UTC clock; the hour angle is then just its offset from local noon.
  const trueSolarTimeMinutes =
    minutesOfDayUTC(date) + 4 * longitudeDeg + equationOfTimeMinutes;
  let hourAngleDeg = trueSolarTimeMinutes / 4 - 180;
  hourAngleDeg = ((((hourAngleDeg + 180) % 360) + 360) % 360) - 180;

  const latitudeRad = degToRad(latitudeDeg);
  const hourAngleRad = degToRad(hourAngleDeg);
  const cosZenith = clamp(
    Math.sin(latitudeRad) * Math.sin(declinationRad) +
      Math.cos(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad),
    -1,
    1
  );
  const zenithRad = Math.acos(cosZenith);
  const zenithDeg = radToDeg(zenithRad);
  const elevationDeg = 90 - zenithDeg;

  // NOAA's azimuth: solve for the angle from south, then rotate to north-clockwise. The
  // sign of the hour angle decides which side of the meridian the sun is on.
  const sinZenith = Math.sin(zenithRad);
  let azimuthDeg;
  if (sinZenith < 1e-9) {
    azimuthDeg = 180;
  } else {
    const cosAzimuthFromSouth = clamp(
      (Math.sin(latitudeRad) * cosZenith - Math.sin(declinationRad)) /
        (Math.cos(latitudeRad) * sinZenith),
      -1,
      1
    );
    const fromSouth = radToDeg(Math.acos(cosAzimuthFromSouth));
    azimuthDeg = hourAngleDeg > 0 ? (540 - fromSouth) % 360 : (180 + fromSouth) % 360;
  }

  return {
    declinationDeg: radToDeg(declinationRad),
    equationOfTimeMinutes,
    hourAngleDeg,
    zenithDeg,
    elevationDeg,
    azimuthDeg,
    airMass: airMassKastenYoung(zenithDeg),
    eccentricityCorrection
  };
}

/**
 * Sunrise, sunset and solar noon in local clock hours for the calendar day of `date`
 * (taken as a UTC date) at the given site. The 90.833 degree zenith is the standard
 * allowance for refraction plus the solar disc's radius.
 *
 * Sunrise and sunset are null on polar day or polar night, where no such hour angle exists;
 * solar noon is always defined.
 */
export function sunriseSunsetHours({ date, latitudeDeg, longitudeDeg, timeZoneHours = 0 }) {
  const noonProbe = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0)
  );
  const { equationOfTimeMinutes, declinationRad } = solarOrbit(noonProbe);

  const solarNoonMinutes = 720 - 4 * longitudeDeg - equationOfTimeMinutes;
  const solarNoonHour = solarNoonMinutes / 60 + timeZoneHours;

  const latitudeRad = degToRad(latitudeDeg);
  const cosHourAngle =
    (Math.cos(degToRad(90.833)) - Math.sin(latitudeRad) * Math.sin(declinationRad)) /
    (Math.cos(latitudeRad) * Math.cos(declinationRad));
  if (!(cosHourAngle >= -1 && cosHourAngle <= 1)) {
    return { sunriseHour: null, sunsetHour: null, solarNoonHour };
  }
  const hourAngleDeg = radToDeg(Math.acos(cosHourAngle));
  return {
    sunriseHour: (solarNoonMinutes - 4 * hourAngleDeg) / 60 + timeZoneHours,
    sunsetHour: (solarNoonMinutes + 4 * hourAngleDeg) / 60 + timeZoneHours,
    solarNoonHour
  };
}
