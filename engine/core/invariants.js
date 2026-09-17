// Conservation checks that run on every step.
//
// Two independent statements: the network obeys Tellegen's theorem (the electrical powers of
// all devices sum to zero), and each device obeys its own energy balance
// (electrical + external = heat + stored). The second is the one that catches modelling
// mistakes, because a device's `heat()` is derived from its own equations rather than from its
// port currents. See engine/PHYSICS.md section 1.4.

export class ConservationError extends Error {
  constructor(violations) {
    const lines = violations.map(
      (violation) =>
        `${violation.deviceId} (${violation.kind}): ${violation.detail}, error ${violation.error.toExponential(3)} W`
    );
    super(`Conservation violated:\n  ${lines.join("\n  ")}`);
    this.name = "ConservationError";
    this.violations = violations;
  }
}

/** Electrical power absorbed by a device at the solved point, W. */
export function electricalPowerWatts(device, ctx) {
  let watts = 0;
  for (const [portName, amps] of device.portCurrents) {
    watts += ctx.voltage(portName) * amps;
  }
  return watts;
}

export function checkConservation({ devices, ctx, tolerance }) {
  const violations = [];
  let networkWatts = 0;
  let scale = tolerance.absoluteToleranceWatts;

  for (const device of devices) {
    ctx.device = device;
    const electrical = electricalPowerWatts(device, ctx);
    networkWatts += electrical;
    scale = Math.max(scale, Math.abs(electrical));

    const external = device.externalPowerWatts(ctx);
    const stored = device.storedPowerWatts(ctx);
    const heat = device.heat(ctx);
    const heatWatts = Object.values(heat).reduce((total, watts) => total + watts, 0);
    const error = electrical + external - heatWatts - stored;
    const allowed = Math.max(
      tolerance.absoluteToleranceWatts,
      tolerance.relativeTolerance *
        Math.max(Math.abs(electrical), Math.abs(external), Math.abs(heatWatts), Math.abs(stored))
    );
    if (Math.abs(error) > allowed) {
      violations.push({
        deviceId: device.id,
        kind: device.kind,
        error,
        detail: `electrical ${electrical.toFixed(6)} W + external ${external.toFixed(6)} W != heat ${heatWatts.toFixed(6)} W + stored ${stored.toFixed(6)} W`
      });
    }
  }
  ctx.device = null;

  const networkAllowed = Math.max(
    tolerance.absoluteToleranceWatts,
    tolerance.relativeTolerance * scale
  );
  if (Math.abs(networkWatts) > networkAllowed) {
    violations.push({
      deviceId: "network",
      kind: "network",
      error: networkWatts,
      detail: `sum of device electrical powers should be zero (Tellegen), scale ${scale.toFixed(3)} W`
    });
  }
  return violations;
}

/** Charge balance for every battery over one step. */
export function checkChargeConservation({ devices, before, dt, tolerance }) {
  const violations = [];
  for (const device of devices) {
    if (device.kind !== "battery") continue;
    const previous = before.get(device.id);
    if (!previous) continue;
    const capacityCoulombs = previous.capacityAh * 3600;
    const expected = previous.effectiveAmps * dt;
    const actual = (device.state.stateOfCharge - previous.stateOfCharge) * capacityCoulombs;
    const allowed = Math.max(1e-6, tolerance.relativeTolerance * capacityCoulombs);
    if (Math.abs(actual - expected) > allowed && previous.stateOfCharge > 0 && previous.stateOfCharge < 1) {
      violations.push({
        deviceId: device.id,
        kind: "battery",
        error: actual - expected,
        detail: `charge moved ${actual.toFixed(6)} C, coulomb count says ${expected.toFixed(6)} C`
      });
    }
  }
  return violations;
}

export function assertConservation(violations) {
  if (violations.length) throw new ConservationError(violations);
}
