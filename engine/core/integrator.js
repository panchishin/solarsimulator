// Adaptive time stepping with event bisection.
//
// The step is sized by the fastest state in the system, so an overnight run takes minutes per
// step and a bolted fault takes microseconds. Discrete transitions are located by bisection
// before they are applied, which is why a fuse opens at the crossing instead of at the end of a
// coarse tick. See engine/PHYSICS.md section 12.

import { ConvergenceError } from "./solver.js";

export class Integrator {
  constructor({ world, settings }) {
    this.world = world;
    this.settings = settings;
    this.dt = settings.initialStepSeconds;
    this.rejections = 0;
    // Rejections for a failed solve, counted apart from rejections for an over-long step: one is
    // a statement about the circuit, the other about the error limits.
    this.convergenceRejections = 0;
    this.lastFailure = null;
    this.eventsApplied = [];
    // A device with an internal control loop cannot be advanced past its own dwell time without
    // slowing that loop down, so the coarsest step the world allows is the tightest device limit.
    this.deviceStepLimit = world.devices.reduce((limit, device) => {
      const declared = device.maxStepSeconds();
      return declared === null ? limit : Math.min(limit, declared);
    }, settings.maxStepSeconds);
  }

  /**
   * Advance the world by at most `horizonSeconds`, taking as many adaptive steps as needed.
   * Returns the actual time advanced and a log of what happened.
   */
  advance(horizonSeconds) {
    const settings = this.settings;
    let advanced = 0;
    const log = { steps: 0, rejected: 0, convergenceRejected: 0, events: [], bisections: 0 };

    while (advanced < horizonSeconds - 1e-12) {
      const remaining = horizonSeconds - advanced;
      let dt = Math.min(this.dt, remaining, this.deviceStepLimit);
      dt = Math.max(dt, settings.minStepSeconds);

      const snapshot = this.world.snapshot();
      let attempt = this.attempt(dt);
      let bisections = 0;

      // A sign change in any event function means the step passed through a transition. Halve
      // until the crossing is bracketed tightly, then let the world apply it.
      while (
        attempt !== null &&
        attempt.crossings.length > 0 &&
        dt > settings.eventToleranceSeconds &&
        bisections < settings.maxEventBisections
      ) {
        this.world.restore(snapshot);
        dt /= 2;
        attempt = this.attempt(dt);
        bisections += 1;
        log.bisections += 1;
      }

      // Newton failed somewhere in this step. A shorter step starts nearer the solution it has
      // to find, which is the standard remedy: reject the step, shrink and try again, and only
      // give up once the step is at the floor (ref:vlach-singhal section 7.4).
      if (attempt === null) {
        this.world.restore(snapshot);
        if (dt <= settings.minStepSeconds * 1.0001) throw this.lastFailure;
        this.dt = Math.max(dt * settings.stepShrink, settings.minStepSeconds);
        log.rejected += 1;
        log.convergenceRejected += 1;
        this.rejections += 1;
        this.convergenceRejections += 1;
        continue;
      }

      if (attempt.crossings.length > 0) {
        this.world.applyCrossings(attempt.crossings);
        for (const crossing of attempt.crossings) {
          log.events.push({ ...crossing, atSeconds: this.world.timeSeconds });
        }
      } else if (this.tooCoarse(attempt) && dt > settings.minStepSeconds * 1.0001) {
        this.world.restore(snapshot);
        this.dt = Math.max(dt * settings.stepShrink, settings.minStepSeconds);
        log.rejected += 1;
        this.rejections += 1;
        continue;
      }

      advanced += dt;
      log.steps += 1;
      this.dt = this.nextStep(dt, attempt, bisections);
    }
    return { advancedSeconds: advanced, ...log };
  }

  /** One fixed step, or null when the solve did not converge. */
  attempt(dt) {
    try {
      return this.world.stepFixed(dt);
    } catch (error) {
      if (!(error instanceof ConvergenceError)) throw error;
      this.lastFailure = error;
      return null;
    }
  }

  /** True when the step moved a state further than the error limits allow. */
  tooCoarse(attempt) {
    const settings = this.settings;
    return (
      attempt.maxTemperatureChangeC > settings.maxTemperatureRisePerStepC ||
      attempt.maxStateOfChargeChange > settings.maxStateOfChargeChangePerStep ||
      attempt.maxDamageChange > settings.maxDamageChangePerStep
    );
  }

  nextStep(dt, attempt, bisections) {
    const settings = this.settings;
    if (bisections > 0) return Math.max(dt, settings.minStepSeconds);
    const load = Math.max(
      attempt.maxTemperatureChangeC / settings.maxTemperatureRisePerStepC,
      attempt.maxStateOfChargeChange / settings.maxStateOfChargeChangePerStep,
      attempt.maxDamageChange / settings.maxDamageChangePerStep
    );
    const factor = load < 0.5 ? settings.stepGrow : load < 1 ? 1 : settings.stepShrink;
    return Math.min(Math.max(dt * factor, settings.minStepSeconds), this.deviceStepLimit);
  }
}
