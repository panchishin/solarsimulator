// The per-device failure state machine.
//
// Every state changes an electrical parameter, so a failure is not a label: `tripped` and
// `consumed` open the branch, `damaged` opens or shorts it according to the device's physics,
// and `burning` injects heat that the thermal network carries to neighbours. See
// engine/PHYSICS.md section 10.

export const FailureState = {
  ok: "ok",
  derated: "derated",
  tripped: "tripped",
  damaged: "damaged",
  burning: "burning",
  consumed: "consumed"
};

const OPEN_STATES = new Set([FailureState.tripped, FailureState.consumed]);

/** True when the device's branch must be treated as open (leakage conductance only). */
export function isOpen(device) {
  if (OPEN_STATES.has(device.failure)) return true;
  if (device.failure === FailureState.damaged) return device.damageMode !== "short";
  return false;
}

/** True when the device has failed into a low-resistance path. */
export const isShorted = (device) =>
  device.failure === FailureState.damaged && device.damageMode === "short";

export const isBurning = (device) => device.failure === FailureState.burning;

export function transition(device, next, reason) {
  if (device.failure === next) return false;
  device.failure = next;
  device.failureHistory.push({
    state: next,
    reason,
    atSeconds: device.state.lastAdvanceSeconds ?? 0
  });
  return true;
}

/** The device's hottest thermal node. */
export function hottestNode(device) {
  return device.thermal.nodeNames
    .map((name) => device.thermal.node(name))
    .reduce((hottest, node) => (node.temperatureC > hottest.temperatureC ? node : hottest));
}

/**
 * Mass lost by a burning device over `dt`. Ignition, damage and burn-through are event
 * functions handled by the integrator, so they land on the crossing rather than at the end of
 * whatever step happened to contain it.
 */
export function accumulateBurn(device, dt, fire) {
  if (!isBurning(device)) return;
  const surface = hottestNode(device).surface?.areaM2 ?? 0.01;
  device.state.burnedMassKg =
    (device.state.burnedMassKg ?? 0) + fire.massLossRateKgPerM2S * surface * dt;
}

/** Heat released by a burning device, W, split into the part radiated to neighbours. */
export function burnHeatWatts(device, fire) {
  if (!isBurning(device)) return { totalWatts: 0, radiatedWatts: 0 };
  const node = device.thermal.node(device.thermal.heatNodeName);
  const surface = node.surface?.areaM2 ?? 0.01;
  const heatOfCombustion = node.material.heatOfCombustionJPerKg ?? 0;
  const totalWatts = fire.massLossRateKgPerM2S * surface * heatOfCombustion;
  return { totalWatts, radiatedWatts: totalWatts * fire.radiativeFraction };
}
