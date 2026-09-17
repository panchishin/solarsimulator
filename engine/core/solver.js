// Modified nodal analysis with damped Newton-Raphson, wrapped in a mode reconciliation loop.
//
// A device declares each of its contributions once, as a current from one of its ports to
// another together with the derivatives of that current with respect to any node voltage. The
// same declaration produces the KCL residual, the Jacobian and the port currents, so there is
// no second code path that can disagree with the first. See engine/PHYSICS.md section 1.

import { SparseSystem, infinityNorm } from "./linalg.js";

export class ConvergenceError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ConvergenceError";
    Object.assign(this, detail);
  }
}

/**
 * The object devices receive in `stamp`, `limits`, `heat`, `advance` and `events`.
 * Port names are resolved against the device being stamped, so a device never sees a node
 * index or knows anything about the rest of the network.
 */
export class SolveContext {
  constructor({ nodeCount, settings, world }) {
    this.nodeCount = nodeCount;
    this.settings = settings;
    this.world = world;
    this.voltages = new Float64Array(nodeCount);
    this.residual = new Float64Array(nodeCount);
    this.system = new SparseSystem(nodeCount);
    this.device = null;
    this.buildJacobian = true;
    this.recordCurrents = false;
    this.resolveRequested = false;
    this.timeSeconds = 0;
    this.dt = 0;
    this.environment = null;
    this.ambientC = 20;
  }

  /**
   * Called by a device from `limits` when it has changed control state that `stamp` depends on.
   * Without it the solver would go on to record currents from a state it never solved.
   */
  requestResolve() {
    this.resolveRequested = true;
  }

  /** Solver index of one of the current device's ports; -1 means the reference node. */
  node(portName) {
    const index = this.device.nodes.get(portName);
    if (index === undefined) {
      throw new RangeError(`Device ${this.device.id} has no port "${portName}"`);
    }
    return index;
  }

  nodeVoltage(index) {
    return index < 0 ? 0 : this.voltages[index];
  }

  voltage(portName) {
    return this.nodeVoltage(this.node(portName));
  }

  across(fromPort, toPort) {
    return this.voltage(fromPort) - this.voltage(toPort);
  }

  /** Temperature of one of the current device's thermal nodes, degC. */
  temperature(nodeName) {
    return this.device.thermal.temperature(nodeName);
  }

  /**
   * A current `amps` flowing out of the network at `fromPort` and into it at `toPort`,
   * with `derivatives` as `[[portName, dAmps/dVoltage], ...]`.
   */
  current(fromPort, toPort, amps, derivatives = []) {
    const from = this.node(fromPort);
    const to = this.node(toPort);
    if (from >= 0) this.residual[from] += amps;
    if (to >= 0) this.residual[to] -= amps;
    if (this.recordCurrents) {
      const currents = this.device.portCurrents;
      currents.set(fromPort, (currents.get(fromPort) ?? 0) + amps);
      currents.set(toPort, (currents.get(toPort) ?? 0) - amps);
    }
    if (!this.buildJacobian) return;

    let equivalent = amps;
    for (const [portName, slope] of derivatives) {
      if (slope === 0) continue;
      const column = this.node(portName);
      this.system.add(from, column, slope);
      this.system.add(to, column, -slope);
      equivalent -= slope * this.nodeVoltage(column);
    }
    this.system.addRhs(from, -equivalent);
    this.system.addRhs(to, equivalent);
  }

  /** A two-terminal conductance `g` between two ports of the current device. */
  conductance(fromPort, toPort, g) {
    const drop = this.across(fromPort, toPort);
    this.current(fromPort, toPort, g * drop, [
      [fromPort, g],
      [toPort, -g]
    ]);
  }

  /**
   * A Thevenin source: `openCircuitVolts` behind `resistanceOhms`, oriented so that a
   * positive open-circuit voltage pushes current out of `fromPort`.
   */
  thevenin(fromPort, toPort, openCircuitVolts, resistanceOhms) {
    const g = 1 / Math.max(resistanceOhms, 1e-12);
    const drop = this.across(fromPort, toPort);
    this.current(fromPort, toPort, g * (drop - openCircuitVolts), [
      [fromPort, g],
      [toPort, -g]
    ]);
  }
}

const modeSignature = (devices) => devices.map((device) => device.mode).join("|");

export class Solver {
  constructor({ devices, netlist, settings, world }) {
    this.devices = devices;
    this.netlist = netlist;
    this.settings = settings;
    this.context = new SolveContext({ nodeCount: netlist.nodeCount, settings, world });
    this.referenceOf = new Int32Array(netlist.nodeCount).fill(-1);
    for (const net of netlist.nets) {
      if (net.nodeIndex >= 0) {
        this.referenceOf[net.nodeIndex] = netlist.islands[net.island].referenceNet.nodeIndex;
      }
    }
    this.seed();
  }

  /** Ask each device for an opening guess so Newton starts near a physical operating point. */
  seed() {
    const context = this.context;
    for (const device of this.devices) {
      if (typeof device.seed !== "function") continue;
      context.device = device;
      const suggestions = device.seed(context) ?? {};
      for (const [portName, volts] of Object.entries(suggestions)) {
        const index = device.nodes.get(portName);
        if (index !== undefined && index >= 0 && context.voltages[index] === 0) {
          context.voltages[index] = volts;
        }
      }
    }
    context.device = null;
  }

  /** One stamping pass. Returns the residual infinity norm. */
  build({ jacobian }) {
    const context = this.context;
    context.buildJacobian = jacobian;
    context.residual.fill(0);
    if (jacobian) context.system.clear();
    if (context.recordCurrents) {
      for (const device of this.devices) device.portCurrents.clear();
    }

    for (const device of this.devices) {
      context.device = device;
      device.stamp(context);
    }
    context.device = null;

    // Node-to-reference leakage: keeps the matrix non-singular when a branch opens, and is a
    // real (if tiny) insulation conductance rather than a numerical fiction.
    const gmin = this.settings.gminSiemens;
    for (let index = 0; index < context.nodeCount; index += 1) {
      const reference = this.referenceOf[index];
      const drop = context.voltages[index] - (reference < 0 ? 0 : context.voltages[reference]);
      context.residual[index] += gmin * drop;
      if (!jacobian) continue;
      context.system.add(index, index, gmin);
      if (reference >= 0) context.system.add(index, reference, -gmin);
    }
    return infinityNorm(context.residual);
  }

  residualNormAt(voltages) {
    const context = this.context;
    const saved = context.voltages;
    context.voltages = voltages;
    const norm = this.build({ jacobian: false });
    context.voltages = saved;
    return norm;
  }

  /** Damped Newton at fixed device modes. */
  newton() {
    const context = this.context;
    const {
      maxNewtonIterations,
      lineSearchSteps,
      voltageAbsToleranceVolts,
      voltageRelTolerance,
      currentAbsToleranceAmps: currentTolerance,
      stagnantIterationLimit,
      maxVoltageStepVolts
    } = this.settings;

    let residualNorm = Number.POSITIVE_INFINITY;
    let stagnantIterations = 0;
    for (let iteration = 1; iteration <= maxNewtonIterations; iteration += 1) {
      residualNorm = this.build({ jacobian: true });
      const solution = context.system.solve();

      const step = new Float64Array(context.nodeCount);
      for (let index = 0; index < context.nodeCount; index += 1) {
        step[index] = solution[index] - context.voltages[index];
      }

      // Trust region. An early step computed from a linearisation that is wrong by orders of
      // magnitude can otherwise throw a node hundreds of volts past every junction in the
      // circuit, and the exponentials there swamp the matrix.
      // Scaling the whole vector rather than clamping each component keeps the Newton direction,
      // which the line search below relies on.
      const rawStepNorm = infinityNorm(step);
      if (rawStepNorm > maxVoltageStepVolts) {
        const shrink = maxVoltageStepVolts / rawStepNorm;
        for (let index = 0; index < context.nodeCount; index += 1) step[index] *= shrink;
      }

      let alpha = 1;
      let accepted = null;
      let acceptedNorm = residualNorm;
      let fullStep = null;
      let fullStepNorm = 0;
      const trial = new Float64Array(context.nodeCount);
      for (let attempt = 0; attempt < lineSearchSteps; attempt += 1) {
        for (let index = 0; index < context.nodeCount; index += 1) {
          trial[index] = context.voltages[index] + alpha * step[index];
        }
        const trialNorm = this.residualNormAt(trial);
        if (attempt === 0) {
          fullStep = Float64Array.from(trial);
          fullStepNorm = trialNorm;
        }
        // Damping exists to stop divergence. Once the trial residual is at the noise floor there
        // is nothing left to diverge from, and halving the step would only make the iteration
        // crawl towards a voltage tolerance it can never reach.
        if (trialNorm < residualNorm || trialNorm <= currentTolerance) {
          accepted = Float64Array.from(trial);
          acceptedNorm = trialNorm;
          break;
        }
        alpha /= 2;
      }
      if (accepted === null) {
        // No damped step improved anything. One iteration before a nonlinear element snaps into
        // place that is normal: the residual rises, then falls quadratically, and backtracking to a
        // two-thousandth of the step is paralysis rather than safety. Take the full step when it is
        // only modestly worse, and keep the most damped one when it is catastrophically worse,
        // which is the case damping exists for.
        const tolerable = fullStepNorm <= residualNorm * 10;
        if (tolerable) {
          accepted = fullStep;
          acceptedNorm = fullStepNorm;
          alpha = 1;
        } else {
          for (let index = 0; index < context.nodeCount; index += 1) {
            trial[index] = context.voltages[index] + alpha * step[index];
          }
          accepted = Float64Array.from(trial);
          acceptedNorm = this.residualNormAt(accepted);
        }
      }

      context.voltages = accepted;

      // KCL is the physical statement of convergence: every node's current sums to within
      // currentAbsToleranceAmps.
      const kirchhoffSatisfied = acceptedNorm <= currentTolerance;

      // The voltage test is per node, the way SPICE does it, because a node's own voltage sets
      // its tolerance. Scaling every node's step by the largest voltage in the circuit makes the
      // test impossible for a high-impedance node.
      let settled = kirchhoffSatisfied;
      if (settled) {
        for (let index = 0; index < context.nodeCount; index += 1) {
          const delta = Math.abs(alpha * step[index]);
          const scale =
            voltageAbsToleranceVolts + voltageRelTolerance * Math.abs(context.voltages[index]);
          if (delta > scale) {
            settled = false;
            break;
          }
        }
      }
      if (settled) return { iterations: iteration, residualNorm: acceptedNorm };

      // A dark solar array's internal junctions have conductances near 1e-9 S while the same
      // matrix carries a 52 V battery through 0.015 ohm. Rounding in the stiff equation then
      // shows up on the weak nodes as steps far larger than any voltage tolerance, and no number
      // of iterations will shrink them. KCL holding for several iterations in a row while the
      // voltages jitter is convergence to the precision this matrix has, so it is accepted and
      // reported rather than thrown.
      stagnantIterations = kirchhoffSatisfied ? stagnantIterations + 1 : 0;
      if (stagnantIterations >= stagnantIterationLimit) {
        return { iterations: iteration, residualNorm: acceptedNorm, stagnant: true };
      }
      residualNorm = acceptedNorm;
    }
    throw new ConvergenceError("Newton did not converge", {
      residualNorm,
      iterations: maxNewtonIterations
    });
  }

  /**
   * Solve, then let every device pick the mode it wants at that operating point, then solve
   * again until the mode vector stops changing. Repeated mode vectors mean two devices are
   * fighting; that is reported rather than looped on forever.
   */
  solve({ timeSeconds = 0, dt = 0, environment = null, ambientC = 20 } = {}) {
    const context = this.context;
    context.timeSeconds = timeSeconds;
    context.dt = dt;
    context.environment = environment;
    context.ambientC = ambientC;

    const seen = new Set([modeSignature(this.devices)]);
    let chattered = false;
    let result = null;

    for (let pass = 1; pass <= this.settings.modeIterationLimit; pass += 1) {
      context.resolveRequested = false;
      result = this.newton();
      let changed = false;
      for (const device of this.devices) {
        context.device = device;
        const desired = typeof device.limits === "function" ? device.limits(context) : device.mode;
        if (desired !== undefined && desired !== device.mode) {
          device.mode = desired;
          changed = true;
        }
      }
      context.device = null;
      if (!changed && !context.resolveRequested) {
        return this.finish({ ...result, passes: pass, chattered });
      }
      if (changed) {
        const signature = modeSignature(this.devices);
        if (seen.has(signature)) {
          chattered = true;
          result = this.newton();
          return this.finish({ ...result, passes: pass, chattered });
        }
        seen.add(signature);
      }
    }
    result = this.newton();
    return this.finish({ ...result, passes: this.settings.modeIterationLimit, chattered: true });
  }

  /**
   * Final residual-only pass that records per-device port currents.
   *
   * The residual is checked again here, because these are the currents every downstream
   * calculation uses. If a device changed its control state during mode reconciliation without
   * asking for a re-solve, the recorded currents would silently violate KCL, and every power,
   * heat and conservation figure built on them would be wrong.
   */
  finish(result) {
    const context = this.context;
    context.recordCurrents = true;
    const residualNorm = this.build({ jacobian: false });
    context.recordCurrents = false;
    const allowed = Math.max(this.settings.currentAbsToleranceAmps * 1e3, 1e-6);
    if (residualNorm > allowed) {
      let worst = 0;
      let node = -1;
      for (let index = 0; index < context.nodeCount; index += 1) {
        if (Math.abs(context.residual[index]) > worst) {
          worst = Math.abs(context.residual[index]);
          node = index;
        }
      }
      throw new ConvergenceError(
        `Recorded port currents violate KCL by ${worst.toExponential(3)} A at node ${node}`,
        { residualNorm, node, iterations: result.iterations }
      );
    }
    return { ...result, residualNorm, voltages: context.voltages };
  }
}
