// Solar geometry against the closed-form results the textbook publishes.
//
// The engine computes position from the full NOAA/Meeus equations, declination, equation of time
// and all, and finds sunrise and sunset from the hour angle at zero elevation. Duffie & Beckman
// give the two results those must reproduce at solar noon:
//
//   altitude at solar noon  = 90 - |latitude - declination|      (eq. 1.6.6 at omega = 0)
//   sunset hour angle       = acos(-tan(latitude) tan(declination))   (eq. 1.6.10)
//
// so day length is 2/15 of that angle in hours. Neither identity is in the code.

import { catalog, compare, siteEnvironment } from "../harness.js";

const SOLSTICE_DECLINATION = 23.44;

/** Peak solar elevation on a local day, sampled every minute, and the day's length. */
function daySummary(localDate) {
  const environment = siteEnvironment(localDate);
  let peakElevation = -Infinity;
  for (let minute = 0; minute < 1440; minute += 1) {
    peakElevation = Math.max(peakElevation, environment.at(minute * 60).solarElevationDeg);
  }
  const daylight = environment.daylight(12 * 3600);
  return { peakElevation, daylightHours: daylight.sunsetHour - daylight.sunriseHour };
}

const noonAltitude = (latitude, declination) => 90 - Math.abs(latitude - declination);
const dayLength = (latitude, declination) => {
  const radians = Math.PI / 180;
  const hourAngle = Math.acos(-Math.tan(latitude * radians) * Math.tan(declination * radians));
  return (2 * hourAngle) / radians / 15;
};

export default {
  id: "solar-geometry",
  title: "solar altitude and day length at Denver",
  reference: ["duffie-beckman", "noaa-solar"],
  claim:
    "The declination is taken as +/-23.44 degrees at the solstices and 0 at the equinox, which " +
    "is where the closed form applies. Day length comes out about 9 minutes longer every time, " +
    "because the closed form puts sunrise at a 90 degree zenith while the model uses 90.833 " +
    "degrees: the sun's upper limb clears the horizon before its centre does, and refraction " +
    "lifts it further (ref:noaa-solar).",
  run() {
    const latitude = catalog.simulation.site.latitudeDeg;
    const days = [
      { date: "2024-06-21", declination: SOLSTICE_DECLINATION, label: "June solstice" },
      { date: "2024-12-21", declination: -SOLSTICE_DECLINATION, label: "December solstice" },
      { date: "2024-03-20", declination: 0, label: "March equinox" }
    ];
    const rows = [];
    for (const day of days) {
      const summary = daySummary(day.date);
      rows.push(
        compare(
          `${day.label} noon altitude`,
          "deg",
          noonAltitude(latitude, day.declination),
          summary.peakElevation,
          0.01
        ),
        compare(
          `${day.label} day length`,
          "h",
          dayLength(latitude, day.declination),
          summary.daylightHours,
          0.02
        )
      );
    }
    return rows;
  }
};
