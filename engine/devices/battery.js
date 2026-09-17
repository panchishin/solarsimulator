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

    usableCapacityAh(temperatureC) {
      return (
        electrical.capacityAh *
        (1 - this.state.capacityFade) *
        temperatureFactor(electrical.capacityTemperatureFactors, temperatureC)
      );
    },

    resistanceOhms(temperatureC) {
      const contactor = electrical.contactorResistanceOhms ?? 0;
      return (
        electrical.internalResistanceOhms *
          temperatureFactor(electrical.resistanceTemperatureFactors, temperatureC) *
          stateOfChargeFactor(electrical.resistanceStateOfChargeFactors, this.state.stateOfCharge) +
        contactor
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
      ctx.thevenin("positive", "negative", this.openCircuitVoltage(), resistance);
    },

    limits(ctx) {
      if (isOpen(this)) return "open";
      const cellC = ctx.temperature("cell");
      const now = ctx.timeSeconds;
      const terminalVolts = ctx.across("positive", "negative");
      const amps = this.portCurrents.get("positive") ?? 0;

      if (this.mode === "closed") {
        const reasons = [
          terminalVolts >= limits.overVoltageDisconnect,
          terminalVolts <= limits.underVoltageDisconnect,
          cellC >= limits.highTemperatureDisconnectC,
          amps > 0 && cellC <= limits.chargeLowTemperatureDisconnectC,
          this.state.overCurrentDamage >= 1
        ];
        if (reasons.some(Boolean)) {
          this.state.reconnectAtSeconds = now + (limits.reconnectDelaySeconds ?? 60);
          return "open";
        }
        return "closed";
      }

      const openCircuit = this.openCircuitVoltage();
      const recovered =
        openCircuit < limits.overVoltageReconnect &&
        openCircuit > limits.underVoltageReconnect &&
        cellC < limits.highTemperatureReconnectC &&
        this.state.overCurrentDamage < 1;
      return recovered && now >= this.state.reconnectAtSeconds ? "closed" : "open";
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
      const capacityAh = Math.max(this.usableCapacityAh(cellC), 1e-9);
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
      this.state.lastAdvanceSeconds = ctx.timeSeconds;
    },

    events(ctx) {
      return [
        { id: "bms-overcurrent", value: this.state.overCurrentDamage - 1 },
        {
          id: "runaway-onset",
          value: ctx.temperature("cell") - cellMaterial.runawayOnsetTemperatureC
        }
      ];
    },

    onEvent(id) {
      if (id === "bms-overcurrent") this.mode = "open";
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
        capacityFade: this.state.capacityFade,
        powerWatts: ctx.across("positive", "negative") * amps,
        heatWatts: this.heat(ctx).cell,
        cellTemperatureC: cellC,
        caseTemperatureC: ctx.temperature("case"),
        contactorClosed: this.mode === "closed" && !isOpen(this),
        runaway: this.state.runaway,
        failure: this.failure
      };
    }
  });
}
