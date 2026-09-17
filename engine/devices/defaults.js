// Default members every device gets, so the solver, integrator and conservation checks can
// call the whole interface on any device without feature tests.

export const DEVICE_DEFAULTS = {
  seed() {
    return {};
  },
  limits() {
    return this.mode;
  },
  heat() {
    return {};
  },
  /** Non-electrical power in, W (absorbed sunlight, chemical release in a runaway). */
  externalPowerWatts() {
    return 0;
  },
  /** Power going into internal storage, W (positive while charging). */
  storedPowerWatts() {
    return 0;
  },
  advance(ctx) {
    this.state.lastAdvanceSeconds = ctx.timeSeconds;
  },
  events() {
    return [];
  },
  onEvent() {},
  reset() {
    return false;
  },
  measurements() {
    return {};
  }
};
