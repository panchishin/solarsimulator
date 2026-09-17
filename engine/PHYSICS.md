# Physics specification

Every equation the engine solves, and where it comes from. Symbols: `V` volt, `I` ampere,
`R` ohm, `G` siemens, `T` temperature (°C unless the symbol ends in `K`), `P` watt.

Reference keys (`ref:...`) resolve in `catalog/catalog.v3.json` → `references`, and are listed
with full titles in `validation/REFERENCES.md`.

## 1. Network

### 1.1 Nodal formulation

Unknowns are net voltages. Each galvanic island has one reference net held at 0 V. Devices
contribute port currents `i_k(V)`; the residual at node `a` is

```
F_a(V) = Σ_devices Σ_ports_at_a  i(V)          (KCL)
```

Newton–Raphson: `J Δ = −F`, `J = ∂F/∂V`. Devices declare each contribution as a current
`i` from node `a` to node `b` together with its derivatives `∂i/∂V_n`, so the same declaration
produces both `F` and `J`. A two-terminal conductance is the special case
`i = g·(V_a − V_b)`.

Convergence is both tests together, KCL and a settled solution:

```
|F_a| ≤ iAbsTol            for every node a
|Δ_a| ≤ vAbsTol + vRelTol·|V_a|   for every node a
```

The voltage test is per node, as in SPICE, because a node's own voltage sets its tolerance.
Scaling every node's step by the largest voltage anywhere in the circuit makes the test
unreachable for a high-impedance node sitting beside a 48 V bus.

A damped line search on `‖F‖∞` accepts the largest `α ∈ {1, ½, ¼, …}` that reduces the
residual; this is the standard damped-Newton safeguard for circuit solvers
(`ref:vlach-singhal`). Three refinements, each for a failure this engine actually produces:

- **Trust region.** `‖Δ‖∞` is capped at `maxVoltageStepVolts` by scaling the whole vector.
  A linearisation taken where a nonlinear branch is nearly off asks for a step of hundreds of
  volts, and the exponentials on the far side swamp the matrix. Scaling the vector rather than
  clamping each component preserves the Newton direction, which the line search needs.
- **Full-step fallback.** If no `α` improves the residual, the full step is taken anyway when
  it is less than 10× worse. One iteration before a nonlinear element snaps into place the
  residual is expected to rise before it falls quadratically, and backtracking to a
  two-thousandth of the step is paralysis rather than safety.
- **Stagnation.** If KCL holds for `stagnantIterationLimit` consecutive iterations while the
  voltage test still fails, the solution is accepted and flagged. A dark array's internal
  junctions run at 1e-9 S in the same matrix as a battery at 0.015 Ω; rounding in the stiff
  equations shows up on the weak nodes as steps no number of iterations will shrink.

`gminSiemens` connects every node to its island reference. It keeps the matrix non-singular
when a branch opens and represents real insulation leakage (`ref:vlach-singhal`).

### 1.5 What the solver requires of a device characteristic

`i(V)` must be continuous, and its stamped derivative must be the derivative of the current it
stamps. Both are load-bearing, and violating either produces a specific, diagnosable failure:

- A **discontinuity** defeats the line search, which compares residuals at trial voltages. A
  jump of a few millivolts that moves the residual by two orders of magnitude means no `α` is
  acceptable and the solve stalls where it stands. This is why the engine does not use SPICE's
  junction limiting, whose `|ΔV| > 2 V_T` test is itself discontinuous.
- An **inconsistent derivative** makes the Newton direction point somewhere other than downhill
  on the residual, and the iteration stalls at a shallow minimum that is not a solution.
- A **vanishing derivative** over the region the answer lies in gives the iteration nothing to
  follow: it crawls by microvolts. A regulator whose gain goes to zero at the edge of its own
  band does this.

Hardware whose behaviour is a hard corner therefore gets that corner rounded over a *sourced*
physical width, not an arbitrary epsilon. `engine/core/units.js` provides
`softCorner(x, width)` (a `max(x, 0)` with a centred quadratic corner, both tails exact),
`softMin(a, b, width)` for "whichever control loop binds first", `ramp(x)` for a saturating
linear taper, and `limitedExponential` for diode exponentials, which continues linearly past
its limit instead of overflowing.

Where the hardware really is a switch rather than a rounded corner, it belongs in mode
reconciliation (§1.3) instead. One exception is a strictly one-way branch, which is stamped as
a direction-dependent conductance: continuous at the crossing, monotonic on both sides, and so
a valid Newton target from either direction (§4).

### 1.2 Galvanic islands

Nets are joined into islands only through device port groups that are galvanically connected
(`device.galvanicGroups`). An isolated inverter declares `[dc+, dc−]` and `[acL, acN]`
separately, so the AC side gets its own reference. Because solver nodes are nets, wiring a DC
terminal to an AC terminal makes them one node: current flows and damage follows. There is no
pattern match for "mixed domain".

### 1.3 Mode reconciliation

After Newton converges, each device's `limits()` returns the mode it wants at that operating
point (`ok`, `currentLimited`, `voltageLimited`, `derated`, `off`, …). If any mode changed the
network is re-solved, up to `modeIterationLimit`. Every mode boundary is a threshold with a
deadband, so a device that has just entered a mode requires the opposing threshold to be
crossed to leave it. Non-convergence is reported, never hidden.

### 1.4 Conservation (checked every step)

Per device, with `P_elec` = electrical power absorbed = `Σ_ports V_port·I_into_port`:

```
P_elec + P_external = Σ_nodes Q_node + P_stored          (1e-6 relative)
```

`P_external` is non-electrical power entering the device (absorbed sunlight for PV, chemical
release for a cell in runaway). `Q_node` is heat injected into each thermal node. `P_stored`
is the rate of change of internal energy (battery chemical energy). Across the network,
Tellegen's theorem gives `Σ_devices P_elec = 0`.

Charge: `ΔSoC · capacityAh · 3600 = ∫ η_c I dt` per battery.

## 2. Conductors

Resistance of a conductor of length `L` and area `A`:

```
R(T) = ρ_ref · L / A · (1 + α (T − T_ref))
```

Copper `ρ_ref = 1.724e−8 Ω·m` at 20 °C, `α = 0.00393 /°C` (`ref:crc-handbook`,
`ref:nec-ch9-t8`). For tungsten the linear form fails over 2500 K, so a power law is used
(`ref:crc-tungsten`):

```
R(T) = ρ_ref · L / A · (T_K / T_refK)^n,   n = 1.2
```

Insulation mass per unit length from the insulation outer diameter `D` and conductor
diameter `d`: `m' = ρ_ins · π/4 · (D² − d²)`.

## 3. Thermal network

Lumped capacitance nodes `C_i = m_i c_i`, linked by conductances. Implicit (backward) Euler:

```
(C/Δt + Σ_j G_ij) T_i^{n+1} − Σ_j G_ij T_j^{n+1} = C/Δt · T_i^n + Q_i + Σ_amb G_amb T_amb
```

solved with the same sparse LU. Backward Euler is unconditionally stable for any `Δt`
(`ref:incropera`). Temperature-dependent conductances are evaluated at `T^n`, then the solve
is repeated once at `T^{n+1}` (two Picard iterations), which keeps the nonlinear radiation
term consistent without giving up stability.

`T_amb` is per node. A node may carry an `ambientOverrideC`, used for convection, for
radiation to ambient and for its initial temperature; `engine/world.js` sets it from the
component's `indoors` flag, to `simulation.site.indoorTemperatureC`. One network still holds
the whole installation, so a pack in a heated room and the array on the roof exchange heat
with the surroundings each of them is actually in. Whether the battery is inside is the
difference between a December day that charges it and one that does not (§4).

### 3.1 Natural convection

Film temperature `T_f = (T_s + T_∞)/2`. Air properties scale from the reference values in
`materials.air` as `k ∝ T_f^0.83`, `ν ∝ T_f^1.75` (`ref:incropera`, Table A.4 trend).

```
Ra = g β (T_s − T_∞) L³ / (ν α),  β = 1/T_f,  α = ν/Pr
```

Churchill–Chu correlations (`ref:churchill-chu`):

- vertical plate: `Nu = 0.68 + 0.670 Ra^{1/4} / [1 + (0.492/Pr)^{9/16}]^{4/9}`  (Ra < 1e9)
- horizontal cylinder: `Nu = 0.36 + 0.518 Ra^{1/4} / [1 + (0.559/Pr)^{9/16}]^{4/9}`
- horizontal plate uses the vertical-plate form with `L = A/P` and a 0.7 factor
  (`estimate:` documented in the catalog)

`h = Nu · k / L`, and the ambient conductance is `G = h·A`.

### 3.2 Forced convection

Fan-cooled surfaces use the laminar flat-plate average correlation
`Nu = 0.664 Re^{1/2} Pr^{1/3}`, `Re = u L / ν` (`ref:incropera`). The engine takes the larger
of forced and natural `h`.

### 3.3 Radiation

```
Q = ε σ A (T_s^4 − T_∞^4) → G_r = ε σ A (T_s² + T_∞²)(T_s + T_∞)
```

`σ = 5.670374419e−8 W/m²K⁴` (`ref:si-constants`). The bracket is evaluated at the previous
temperature, which is exact at convergence of the two Picard iterations. Internal radiative
links (filament → envelope) use `ε A F_view`, and the fraction `1 − transmittance` of the
radiation leaving the filament is absorbed by the envelope while the rest leaves the device
(glass is transparent in the visible, opaque in the far IR: `ref:ge-lamp-handbook`).

## 4. Battery

Terminal voltage, sign convention "current into the positive terminal is charging":

```
V_t = OCV(SoC) + I · R_int(SoC, T)
R_int = R_ref · f_T(T) · f_SoC(SoC)
```

`OCV(SoC)` is the catalog curve, linearly interpolated. Coulomb counting with coulombic
efficiency `η_c` on charge only (`ref:plett-bms`):

```
d(SoC)/dt = (I ≥ 0 ? η_c I : I) / (3600 · Q_Ah · f_capacity(T))
```

Power split: `P_elec = V_t I = OCV·I + I²R`. Heat is `I²R + (1 − η_c)·max(OCV·I, 0)`; stored
power is the remainder, so §1.4 closes exactly.

BMS: a series contactor opens on over-voltage, under-voltage, over-current (with the
catalog's inverse-time allowance), or over-temperature, and closes again only after the
opposing hysteresis threshold is met. Open means the branch conductance becomes
`gminSiemens`, so the battery genuinely disappears from the circuit instead of being deleted
from the netlist. The condition has to hold for `protectionResponseSeconds` before the
contactor moves, which is what lets a fuse clear a bolted fault before the pack disconnects.

### 4.1 One-way charge path

A BMS puts back-to-back MOSFETs between the cells and the terminals so it can open each
direction independently. With the charge FET off the pack still supplies loads through the
discharge FET, so the branch is one-way rather than open:

```
G = 1/R_int          V_t < OCV      (discharging, normal Thevenin)
G = 1/R_blocked      V_t ≥ OCV      (BMS sense and balancing network only)
I = (V_t − OCV)·G
```

`I` is continuous at `V_t = OCV`, where it is zero, and monotonic either side, so Newton
converges to it from either direction (§1.5). `R_blocked` is the BMS's own voltage-sense and
cell-balancing path, milliamps at pack voltage.

Two conditions open the charge FET, each with its own hysteresis:

- **Cold.** Below `chargeLowTemperatureDisconnectC` lithium plates onto the anode instead of
  intercalating, so charging is locked out rather than derated (`ref:battleborn-bb10012`), and
  resumes above `chargeLowTemperatureReconnectC`.
- **Full.** At `SoC = 1` the cells are at their over-voltage limit and the pack stops
  accepting current, resuming below `chargeResumeStateOfCharge`. Without this the coulombs a
  controller pushes at a full pack would vanish, since `SoC` cannot exceed one — a silent leak
  rather than an electrical consequence.

Either way the pack goes on running the loads, so the consequence of a frozen pack is not a
dead system: it is an array with nowhere to put its energy.

Capacity fade: `Q_Ah` is multiplied by `1 − fade`, with `fade` accumulated per equivalent full
cycle at the catalog's rate (`ref:lfp-cycle-life`).

## 5. Photovoltaics

### 5.1 Single-diode model

Per substring of `Ns_sub` cells (`ref:desoto-2006`):

```
I = I_ph − I_0 (exp((V + I R_s)/a) − 1) − (V + I R_s)/R_sh
a = n Ns_sub k T_K / q
```

Solved inside the network Newton, not separately: the substring is stamped as a nonlinear
current with `∂I/∂V` from implicit differentiation, and the module exposes internal nodes for
the substring boundaries so a bypass diode can be placed across each one.

Bypass diode: `I_d = I_sat (exp(−V_sub/(n_d V_t)) − 1)`, conducting when the substring is
reverse-biased by shade.

### 5.2 Parameter extraction

`I_ph`, `I_0`, `R_s`, `R_sh` are derived at load time from the datasheet STC point
(Isc, Voc, Vmp, Imp) by the Villalva iteration (`ref:villalva-2009`): `R_s` is stepped from 0
while `R_sh` is chosen so the model's maximum power equals the datasheet `Pmp`, terminating
when the model's MPP matches the datasheet MPP. Only the diode ideality factor `n` is a
catalog input. Nothing is fitted to a simulation result.

### 5.3 Irradiance and temperature dependence

```
I_ph(G, T) = G/G_stc · (I_sc + α_Isc (T − 25))
I_0(T)     = I_0,stc · (T_K/298.15)³ · exp(q E_g/(n k) (1/298.15 − 1/T_K))
```

`E_g = 1.121 eV` for silicon (`ref:desoto-2006`).

Cell temperature, Faiman module-temperature model (`ref:faiman-2008`, coefficients per
`ref:koehl-2011`):

```
T_cell = T_amb + G_poa / (U0 + U1 · u_wind)
```

Absorbed optical power for the conservation check is `G_poa · A · absorptance`; heat is that
minus the electrical power leaving the module.

## 6. Charge controller

### 6.1 Sense dividers

Both ports carry a resistive voltage divider in every mode, including off: a controller has to
measure array and pack voltage to do anything at all, and `inputBleedResistanceOhms` /
`outputBleedResistanceOhms` are those dividers. They are also what keeps the two nodes defined.
Without the input divider a dark array feeding a tracker that has not yet chosen a reference is
a pure open circuit; without the output one, a pack that has stopped accepting charge (§4.1)
leaves the output rail floating between two elements that both carry no current.

### 6.2 Three simultaneous loops

An MPPT runs three control loops at once, and the hardware obeys whichever binds. All three are
stamped together and combined with `softMin`, rather than selected by a mode, because a mode
switch between two branches that each look right to the linearisation makes the iteration
oscillate.

**Input (maximum-power) loop.** Draw current in proportion to how far the array sits above the
tracking reference, over the regulation band `V_band = inputRegulationBandVolts`:

```
I_in = softCorner(V_in − V_ref, V_band) / R_ctrl
```

Between steps, perturb-and-observe moves `V_ref` by `±ΔV` in the direction that increased
`P_in`, which tracks the actual I–V curve rather than assuming a fixed `Vmp`
(`ref:esram-chapman`). Before the first perturbation there is no reference: the controller is
measuring open-circuit voltage, so `V_ref = +∞` and the loop draws nothing. That is different
from `V_ref = V_in`, which would sit exactly on the corner.

**Current loop.** A flat ceiling `I_max(T_heatsink)` competing with what the array can supply:

```
I_avail = (η(P_in) P_in − P_idle) / V_out
I = softMin(I_avail, I_max, w),   w = max(|I_avail|, |I_max|, I_floor)·loopCurrentBandFraction
```

The handover band is a *fraction* of the currents being compared, so the same rounding works at
a milliamp after sunset and at the 50 A rating. A fixed band wide enough for 50 A swallows the
whole operating range at dusk.

**Stage loop.** A controller holds a stage voltage by backing its duty cycle off as the target
approaches, so the delivered current is tapered to zero across the regulation window rather
than derived from a headroom voltage:

```
I_out = I · ramp((V_target − V_out) / outputRegulationBandVolts)
```

Expressing a stiff regulator as a current through a small resistance gives a linearisation
valid over a fraction of a millivolt, and Newton then cannot move at all. The taper's derivative
is bounded by `I/window` and valid across the whole window. The ramp is linear rather than an
S-curve because a smoothstep's slope vanishes at both ends of the transition, which is where the
operating point sits (§1.5).

`∂I_out/∂V_in` and `∂I_out/∂V_out` are both supplied to the Jacobian, including the negative
incremental conductance a constant-power output really presents, which is what makes DC sag on
either side propagate to the other.

Stages: `bulk` (current limit `I_max`), `absorb` (regulate `V_out` to `absorbVoltage` until
current falls below `tailCurrentFraction` or `absorbHoldSeconds` elapses), `float` (regulate to
`floatVoltage`). Input over-voltage above `maxInputVoltage` disconnects; heatsink temperature
above the derate threshold scales `I_max` linearly to zero at shutdown. Which loop is binding is
reported rather than assumed, and the tracker perturbs only while the maximum-power loop binds:
hill-climbing against a controller that is voltage-limited measures the pack, not the array.

Because perturb-and-observe acts once per call, the device caps the integrator's step at
`tracking.maxIntegrationStepSeconds` (§12); a longer step would quietly make the tracker slower
than the hardware it stands for.

PWM: a duty-cycled switch between array and battery, average conductance `d/R_on`, `d`
adjusted by the same stage machine. No boost/buck action, so the array runs at battery
voltage — the reason a PWM controller loses energy on a 36-cell panel is emergent.

## 7. Inverter

DC input current for AC output power `P_ac`:

```
P_dc = P_idle + P_ac / η(f, T),   f = P_ac / P_rated
I_dc = P_dc / V_dc
```

`η(f)` is interpolated from the datasheet efficiency curve and shifted by
`efficiencyTempCoefficientPerC`. AC side is a Thevenin source: regulated `V_set` behind
`outputResistanceOhms`, so voltage sags with load and with DC-side collapse
(`V_set` scales with the available DC power when the DC bus cannot support the demand).

Protection:

- `maxOutputWatts` is enforced by an inverse-time accumulator on the same log-log curve
  machinery as breakers (`ref:victron-multiplus`).
- Under/over DC voltage trip at the catalog thresholds and restart only after the restart
  threshold is recrossed.
- Heatsink temperature above `derateStartC` scales `P_rated` linearly to zero at
  `derateEndC`; above `shutdownC` the inverter turns off.
- Reverse DC polarity puts the H-bridge body diodes across the input: a diode branch
  conducting for `V_dc < 0` with the catalog's series resistance. The resulting fault current
  is what blows an upstream fuse.

## 8. Loads

| behaviour | model |
|---|---|
| `constantPower` | `G = P/V²` recomputed each iteration, so `I = P/V` at the answer; below `minOperatingVoltage` the load drops out |
| `constantResistance` | `R = V_rated²/P_rated`, optional material temperature coefficient |
| `incandescent` | `R(T_fil) = R_ref (T_K/T_refK)^1.2`; filament and envelope thermal nodes; cold-start inrush is emergent, not a multiplier |
| `compressor` | duty-cycled constant power with an inrush period of `inrushMultiple × P` for `inrushSeconds` at each start |

A regulated load draws `P/V`, which is negative incremental conductance: pull the bus down and
it draws more. That slope is only safe while something stiff holds the bus. Let the supply stop
conducting — a cold pack blocking charge, a controller tapered off at its stage voltage — and
the load's own node goes negative, at which point a Newton step climbs away from the solution
and the bus runs off to nowhere. The secant conductance `P/V²` passes the same current at the
answer and is positive everywhere, so the iteration walks down to where the supply picks up
again.

The characteristic is bounded at both ends. Below a knee the input stage cannot hold its output
and turns resistive, and above `overVoltageDamage` it is not regulating anything either, which
also removes the spurious high-voltage equilibrium that `P/V` has against a high-impedance
supply.

Under- and over-voltage damage accumulate against the catalog's `damage` thresholds; a
damaged load goes open or short according to its `damageMode`.

## 9. Protection devices

Time–current curves are catalog point lists interpolated in log-log space. Damage
accumulates as

```
dD/dt = 1 / t_trip(I/I_rated),   trip at D ≥ 1
```

which reproduces every datasheet point by construction, unlike a single `I²t` constant
(`ref:anl-fuse-curve`, `ref:ul489`). Below the lowest curve multiple, `D` decays with the
device's thermal time constant. Breakers add an instantaneous magnetic trip at
`magneticMultiple`. A tripped breaker needs a manual reset; a blown fuse is permanent.
Both set their branch conductance to `gminSiemens` when open.

## 10. Failure state machine

`ok → derated → tripped → damaged → burning → consumed`, with the transitions in
`engine/failure/machines.js`. Each state changes electrical parameters, so consequences
propagate through the solver:

- `tripped`, `consumed`: branch conductance `gminSiemens` (open).
- `damaged`: open or short per the device's `damageMode`.
- `burning`: the device's `ignitionHeatWatts` is injected into its own thermal node and
  radiated to neighbours within `flameRadiusM`, so fire spreads through the thermal network.
- `consumed`: reached when the burn integral exceeds the material's heat of combustion.

Battery runaway is separate from ignition: an Arrhenius self-heating term
`q = m H A exp(−E_a/(R T_K))` (`ref:lfp-thermal-runaway`) becomes self-sustaining above the
onset temperature because `dq/dT` exceeds the node's total cooling conductance. No device
type is exempt from any mechanism.

## 11. Environment

- Solar position: NOAA / Meeus low-precision algorithm — fractional year, equation of time,
  declination, hour angle, elevation and azimuth (`ref:noaa-solar`). Azimuth is measured
  clockwise from north, so a negative hour angle (morning) is east of south: getting that branch
  backwards mirrors the whole day and shows up as an east-facing roof peaking in the afternoon.
- Clear sky: Bird & Hulstrom broadband model for DNI, DHI and GHI from air mass, pressure,
  ozone, precipitable water, aerosol optical depth and ground albedo
  (`ref:bird-hulstrom-1981`).
- Transposition: Hay–Davies anisotropic sky on a tilted plane plus isotropic ground reflection
  (`ref:duffie-beckman`).
- Weather: a seeded value-noise cloud series multiplying the clear-sky beam and diffuse
  components with the documented beam/diffuse split (`ref:pvwatts-v5`). Deterministic for a
  given seed.
- Ambient temperature is an annual cycle carrying a daily one:

  ```
  T_mean(d) = T_annualMean − A_annual·cos(2π (d − d_coldest)/365)
  T(h, d)   = T_mean(d) − (ΔT_daily/2)·cos(π·φ(h))
  ```

  where `φ` runs 0 → 1 from the pre-dawn minimum to the mid-afternoon maximum and 1 → 2 back
  again, so each arc is half a cosine and the two meet with matching slope. Amplitudes come
  from station normals (`ref:noaa-denver-normals`). Without the annual term a December day runs
  at July temperatures, which is the difference between a pack that accepts charge and one that
  is locked out (§4.1).
- Equipment marked `indoors` uses `simulation.site.indoorTemperatureC` as its thermal ambient
  (§3) rather than the outdoor series.
- Extraterrestrial irradiance `1361 W/m²` with the eccentricity correction
  (`ref:si-constants`, `ref:duffie-beckman`).

## 12. Integration

The step is adaptive. After a trial step of `Δt` the controller measures the largest normalised
state change (temperature rise per step, SoC change per step, damage-integral change) and
compares it with the catalog's per-step limits: `Δt` shrinks by `stepShrink` on rejection and
grows by `stepGrow` when the step is comfortably inside the limits, bounded by
`[minStepSeconds, maxStepSeconds]`.

A device may cap the step further through `maxStepSeconds()`. Anything that acts once per call
rather than continuously — an MPPT's perturb-and-observe being the case in point — is only as
fast as the step allows, so the bound belongs with the device rather than in the global setting.

Discrete transitions are event functions `g(state)` that a device declares. A step is rejected
if any `g` changes sign, and the crossing is bisected to `eventToleranceSeconds` before the
transition is applied. That is why a bolted fault clears in milliseconds inside a simulation
that otherwise runs on minute-long steps.
