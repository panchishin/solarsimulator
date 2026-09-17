// Battery: OCV(SoC) behind a state- and temperature-dependent internal resistance, with a BMS
// contactor that really opens the branch and a cell thermal node that can run away.
//
// Nothing is ever deleted from the network: a pack at zero charge still has an OCV curve and a
// resistance, and an open contactor is leakage conductance. See engine/PHYSICS.md section 4.

import { interpolate, GAS_CONSTANT, SECONDS_PER_HOUR, clamp } from "../core/units.js";
import { stateOfChargeFactor, temperatureFactor } from "../core/catalog.js";
import { runawayPowerWatts } from "../thermal/materials.js";
import { advanceDamage } from "../failure/tripCurves.js";
import { FailureState, isOpen, isShorted } from "../failure/machines.js";

export function createBatteryDevice({ base, catalog }) {
  const electrical = base.electrical;
  const limits = base.limitsSpec;
  const cellMaterial = catalog.material(
    base.model.thermal.nodes[base.model.thermal.heatNode ?? "cell"].material
  );

  return Object.assign(base, {
    state: {
      stateOfCharge: electrical.startingStateOfCharge,
      capacityFade: 0,
      throughputAh: 0,
      overCurrentDamage: 0,
      protectionCondition: null,
      protectionElapsedSeconds: 0,
      reconnectAtSeconds: -Infinity,
      runaway: false,
      burnedMassKg: 0,
      lastAdvanceSeconds: 0
    },
    mode: "closed",

    openCircuitVoltage(stateOfCharge = this.state.stateOfCharge) {
      return interpolate(
        electrical.openCircuitVoltageCurve,
        clamp(stateOfCharge, 0, 1),
        "stateOfCharge",
        "voltage"
      );
    },

    /**
     * Capacity that state of charge is referenced to, Ah. Rated capacity less permanent fade,
     * with no temperature term: a cold pack delivers less energy, but sitting in the cold does
     * not move any charge, so it must not move the state of charge either.
     */
    nominalCapacityAh() {
      return electrical.capacityAh * (1 - this.state.capacityFade);
    },

    /** Capacity actually deliverable at this temperature, Ah. */
    usableCapacityAh(temperatureC) {
      return (
        this.nominalCapacityAh() *
        temperatureFactor(electrical.capacityTemperatureFactors, temperatureC)
      );
    },

    /** Cells plus the BMS switch path, ohms: what a terminal-to-terminal measurement sees. */
    resistanceOhms(temperatureC) {
      return (
        electrical.internalResistanceOhms *
          temperatureFactor(electrical.resistanceTemperatureFactors, temperatureC) *
          stateOfChargeFactor(electrical.resistanceStateOfChargeFactors, this.state.stateOfCharge) +
        (electrical.contactorResistanceOhms ?? 0)
      );
    },

    seed() {
      return { positive: this.openCircuitVoltage(), negative: 0 };
    },

    stamp(ctx) {
      if (this.mode === "open" || isOpen(this)) {
        ctx.conductance("positive", "negative", ctx.settings.gminSiemens);
        return;
      }
      const resistance = isShorted(this)
        ? Math.max(this.resistanceOhms(ctx.temperature("cell")) * 0.05, 1e-4)
        : this.resistanceOhms(ctx.temperature("cell"));
      const openCircuit = this.openCircuitVoltage();
      if (this.mode !== "chargeBlocked") {
        ctx.thevenin("positive", "negative", openCircuit, resistance);
        return;
      }

      // The BMS has opened the charge MOSFET and left the discharge one closed, so the branch is
      // one-way. Current still leaves through the discharge path, which is why a frozen or a full
      // pack goes on running the loads; what tries to enter meets only the BMS's own sense and
      // balancing network.
      //
      // Stamped as a resistance that depends on the direction, rather than as a diode or as a pair
      // of solver modes. A diode is truer to the silicon but spans twenty decades of conductance
      // over half a volt, which no residual-based line search survives. A mode that opens the
      // branch cannot supply the load at all, so the guess it makes when a compressor starts leaves
      // the network with no solution to find. This characteristic is continuous at the crossing and
      // monotonic on both sides of it, which is all Newton needs: the kink in its slope is the
      // MOSFET turning off.
      const terminalVolts = ctx.across("positive", "negative");
      const conductance =
        terminalVolts >= openCircuit
          ? 1 / electrical.chargeBlockedResistanceOhms
          : 1 / resistance;
      ctx.current("positive", "negative", (terminalVolts - openCircuit) * conductance, [
        ["positive", conductance],
        ["negative", -conductance]
      ]);
    },

    /**
     * The protection condition present at this operating point, or null. Reported rather than
     * acted on: the contactor opens only after the condition has held for the BMS's response
     * time, which is what lets a fuse clear a bolted fault before the pack disconnects.
     */
    protectionCondition(ctx) {
      const cellC = ctx.temperature("cell");
      const terminalVolts = ctx.across("positive", "negative");
      if (terminalVolts >= limits.overVoltageDisconnect) return "pack over-voltage";
      if (terminalVolts <= limits.underVoltageDisconnect) return "pack under-voltage";
      if (cellC >= limits.highTemperatureDisconnectC) return "cell over-temperature";
      return null;
    },

    /**
     * True while the BMS is refusing charge but still supplying the loads. It happens for two
     * reasons, both of which open the charge MOSFET and leave the discharge one closed.
     *
     * Below freezing, lithium plates onto the anode instead of intercalating, so charging is locked
     * out rather than derated. At the top of charge the cells reach their over-voltage limit, and
     * the pack stops accepting current: without that the coulombs pushed at a full pack would go
     * nowhere, since state of charge cannot exceed one. Each has its own hysteresis, and both are
     * kept apart from the protection conditions because they block one direction only.
     */
    chargeLocked(ctx) {
      const blocked = this.mode === "chargeBlocked";
      const cellC = ctx.temperature("cell");
      const coldThreshold = blocked
        ? limits.chargeLowTemperatureReconnectC
        : limits.chargeLowTemperatureDisconnectC;
      if (cellC <= coldThreshold) return true;
      return this.state.stateOfCharge >= (blocked ? limits.chargeResumeStateOfCharge : 1);
    },

    limits(ctx) {
      if (isOpen(this)) return "open";
      const cellC = ctx.temperature("cell");
      const now = ctx.timeSeconds;

      if (this.mode !== "open") return this.chargeLocked(ctx) ? "chargeBlocked" : "closed";

      const openCircuit = this.openCircuitVoltage();
      const recovered =
        openCircuit < limits.overVoltageReconnect &&
        openCircuit > limits.underVoltageReconnect &&
        cellC < limits.highTemperatureReconnectC &&
        this.state.overCurrentDamage < 1;
      if (!(recovered && now >= this.state.reconnectAtSeconds)) return "open";
      return this.chargeLocked(ctx) ? "chargeBlocked" : "closed";
    },

    runawayWatts(ctx) {
      const node = this.thermal.node("cell");
      return runawayPowerWatts(cellMaterial, ctx.temperature("cell"), node.massKg, GAS_CONSTANT);
    },

    heat(ctx) {
      const amps = this.portCurrents.get("positive") ?? 0;
      const resistance = this.mode === "open" ? 0 : this.resistanceOhms(ctx.temperature("cell"));
      const ohmic = amps * amps * resistance;
      const chargingLoss =
        (1 - electrical.coulombicEfficiency) * Math.max(this.openCircuitVoltage() * amps, 0);
      return { cell: ohmic + chargingLoss + this.runawayWatts(ctx), case: 0 };
    },

    externalPowerWatts(ctx) {
      return this.runawayWatts(ctx);
    },

    storedPowerWatts() {
      const amps = this.portCurrents.get("positive") ?? 0;
      const chemical = this.openCircuitVoltage() * amps;
      return amps >= 0 ? electrical.coulombicEfficiency * chemical : chemical;
    },

    advance(ctx, dt) {
      const amps = this.portCurrents.get("positive") ?? 0;
      const cellC = ctx.temperature("cell");
      const capacityAh = Math.max(this.nominalCapacityAh(), 1e-9);
      const effective = amps >= 0 ? electrical.coulombicEfficiency * amps : amps;
      this.state.stateOfCharge = clamp(
        this.state.stateOfCharge + (effective * dt) / (SECONDS_PER_HOUR * capacityAh),
        0,
        1
      );

      const throughput = (Math.abs(amps) * dt) / SECONDS_PER_HOUR;
      this.state.throughputAh += throughput;
      // One equivalent full cycle is a discharge plus a recharge, so 2*capacity of throughput.
      const cycles = this.state.throughputAh / (2 * electrical.capacityAh);
      this.state.capacityFade = Math.min(cycles * (electrical.capacityFadePerEquivalentCycle ?? 0), 0.8);

      const limitAmps =
        amps > 0 ? limits.chargeCurrentLimitAmps : limits.dischargeCurrentLimitAmps;
      this.state.overCurrentDamage = advanceDamage({
        damage: this.state.overCurrentDamage,
        currentAmps: amps,
        ratedAmps: limitAmps,
        curve: limits.overCurrentTripCurve,
        holdMultiple: 1,
        thermalTimeConstantSeconds: 60,
        dt
      });
      if (cellC >= cellMaterial.runawayOnsetTemperatureC) this.state.runaway = true;

      const conducting = this.mode === "closed" || this.mode === "chargeBlocked";
      const condition = conducting ? this.protectionCondition(ctx) : null;
      if (condition) {
        this.state.protectionCondition = condition;
        this.state.protectionElapsedSeconds += dt;
      } else {
        this.state.protectionCondition = null;
        this.state.protectionElapsedSeconds = 0;
      }
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events(ctx) {
      const response = limits.protectionResponseSeconds;
      const events = [
        { id: "bms-overcurrent", value: this.state.overCurrentDamage - 1 },
        {
          id: "runaway-onset",
          value: ctx.temperature("cell") - cellMaterial.runawayOnsetTemperatureC
        }
      ];
      if (this.mode === "closed" || this.mode === "chargeBlocked") {
        const holding = this.protectionCondition(ctx) !== null;
        events.push({
          id: "bms-disconnect",
          value: holding ? this.state.protectionElapsedSeconds - response : -response
        });
      }
      return events;
    },

    onEvent(id, ctx) {
      if (id === "bms-overcurrent" || id === "bms-disconnect") {
        this.mode = "open";
        this.state.reconnectAtSeconds = ctx.timeSeconds + (limits.reconnectDelaySeconds ?? 60);
        this.state.protectionElapsedSeconds = 0;
      }
      if (id === "runaway-onset") this.state.runaway = true;
    },

    measurements(ctx) {
      const amps = this.portCurrents.get("positive") ?? 0;
      const cellC = ctx.temperature("cell");
      return {
        currentAmps: amps,
        terminalVoltage: ctx.across("positive", "negative"),
        openCircuitVoltage: this.openCircuitVoltage(),
        stateOfCharge: this.state.stateOfCharge,
        energyWh: this.state.stateOfCharge * this.usableCapacityAh(cellC) * electrical.nominalVoltage,
        capacityAh: this.usableCapacityAh(cellC),
        // State of charge is a fraction of the nominal capacity, not of the temperature-derated
        // usable capacity, so anything counting coulombs has to use this one.
        nominalCapacityAh: this.nominalCapacityAh(),
        capacityFade: this.state.capacityFade,
        powerWatts: ctx.across("positive", "negative") * amps,
        heatWatts: this.heat(ctx).cell,
        cellTemperatureC: cellC,
        caseTemperatureC: ctx.temperature("case"),
        contactorClosed: this.mode !== "open" && !isOpen(this),
        chargeAccepted: this.mode === "closed" && !isOpen(this),
        protectionCondition: this.state.protectionCondition,
        chargeLockedByCold:
          this.mode === "chargeBlocked" && cellC <= limits.chargeLowTemperatureReconnectC,
        chargeLockedByFull:
          this.mode === "chargeBlocked" &&
          this.state.stateOfCharge >= limits.chargeResumeStateOfCharge,
        runaway: this.state.runaway,
        failure: this.failure
      };
    }
  });
}
