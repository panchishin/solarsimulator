# References

Every number the engine uses carries a `source` string, and every `ref:<key>` in
`catalog/catalog.v3.json` resolves against the catalog's `references` block or loading fails
(`engine/core/catalog.js`). This file is the map of that evidence base: what each of the 48
reference keys is, what it supplies, and how it is checked.

A reference can play three roles, and the difference decides whether it is worth a validation
case.

- **input.** The reference supplies numbers the model consumes: a datasheet rating, a table
  entry, a material property. Reading such a number back out of the model is bookkeeping. It
  confirms the catalog was transcribed and the units line up, and nothing more.
- **method.** The reference supplies an equation or an algorithm the engine implements. The test
  of a method is whether the code is the equation, which unit tests and internal consistency
  checks can establish, and whether the equation reproduces figures it was not given.
- **check.** The reference publishes a figure the model is never handed. Comparing against it is
  a real test, because nothing in the catalog can be adjusted to make it come out right without
  breaking something else. Only this third kind earns a case under `validation/cases/`.

Many keys play two roles at once. A datasheet is an input for the four numbers the model is given
and a check for the fifth it is not: `canadian-solar-cs6k-300ms` supplies Isc, Voc, Vmp and Imp,
and its fill factor and power temperature coefficient are then checks.

Case ids below are the `id` fields of `validation/cases/*.js`, printed by `validation/run.js`.
Test names are in `tests/unit/*.test.js`. `tests/simulation.test.js` belongs to the older
`js/simulation.js` code and exercises none of this.

## Conductors and the NEC

| key | role | supplies | exercised by |
|---|---|---|---|
| `nec-ch9-t8` | input, check | conductor cross-sectional areas and diameters for 14 AWG through 4/0 | case `conductor-resistance` |
| `nec-310-17` | check | free-air ampacity per gauge, 60 C and 75 C columns | case `conductor-ampacity`, `thermal.test.js` |
| `nec-ch9-t5` | input | THHN/THWN-2 insulation outer diameters and the 90 C rating | not directly compared |

`nec-ch9-t8` is both roles at once. The engine takes only the area column; resistance is computed
from copper's resistivity and temperature coefficient, so the table's own resistance column is an
independent comparison. Case `conductor-resistance` runs it at 75 C over six gauges and lands
about 2 % low, which is the stranding allowance the table carries and the model does not.

`nec-310-17` is the strongest check in the repo. The table states the current at which a single
insulated conductor in free air reaches its insulation rating in a 30 C ambient, which is a
thermal statement. The engine never reads the ampacity: it is given the current and the geometry,
makes I squared R, and sheds it by convection and radiation. Case `conductor-ampacity` compares
the solved rise against the table's 30 K and 45 K over twelve entries. `thermal.test.js` repeats
the check for four gauges and adds the monotonic cases: five times rating runs far over the
rating, a thicker conductor at the same current runs cooler, and the insulation is always cooler
than the conductor under it.

`nec-ch9-t5` feeds insulation mass per unit length, which sets the wire's thermal capacitance and
its outer surface area. No published figure is compared against it. It is exercised indirectly:
the `conductor-ampacity` result depends on the outer diameter, so a wrong diameter would show up
there.

The raceway ampacity column of Table 310.16 is deliberately absent. The thermal model solves one
conductor in still air, which is Table 310.17's geometry, not a bundle in a conduit, so the
raceway figures could neither be used nor compared against; carrying them only implied a
capability the engine does not have.

## Materials and heat transfer

| key | role | supplies | exercised by |
|---|---|---|---|
| `crc-handbook` | input | copper and aluminium resistivity, temperature coefficient, density | `catalog.test.js` |
| `crc-tungsten` | method, check | tungsten resistivity power law, exponent 1.2, and the cold-to-hot ratio near 15 | case `incandescent-lamp`, `catalog.test.js` |
| `incropera` | input, method | air properties at 300 K and their exponents; flat-plate forced convection | case `conductor-ampacity`, `thermal.test.js` |
| `churchill-chu` | method | natural-convection Nusselt correlations for plate and cylinder | case `conductor-ampacity`, `thermal.test.js` |
| `si-constants` | input | Stefan-Boltzmann and Boltzmann constants, elementary charge, solar constant 1361 W/m2 | `thermal.test.js` |
| `matweb-materials` | input | density, specific heat, conductivity and emissivity of six materials | not directly compared |
| `nichrome-properties` | input | Nikrothal 80 resistivity, temperature coefficient, density, 1200 C element limit | not directly compared |

`crc-handbook` backs `materials.copper` and `materials.aluminium`. `catalog.test.js` asserts that
copper's resistance follows the stated temperature coefficient, which tests the code against the
catalog rather than against the handbook.

`crc-tungsten` is a method reference that produces a check. The linear temperature coefficient
fails above about 2500 K, so the engine uses `R(T) = R_ref (T_K/T_refK)^1.2`. `catalog.test.js`
verifies the power law over the full range. The exponent then predicts a cold-to-hot resistance
ratio of about 15, and case `incandescent-lamp` measures 15.59 against the published 15 without
that ratio ever being an input.

`churchill-chu` and `incropera` are the two method references behind the whole thermal network.
`thermal.test.js` pins the Rayleigh number and the convection coefficient of a 60 mm horizontal
cylinder to the Incropera worked example, and case `conductor-ampacity` is the outside test: the
free-air ampacity rise is what these correlations produce or fail to produce.

`si-constants` supplies exact constants, not measurements. `thermal.test.js` compares the
radiation term against a hand-written Stefan-Boltzmann evaluation and checks its analytic slope
against a finite difference, which is a code-correctness test rather than a comparison with the
world.

`matweb-materials` and `nichrome-properties` are pure inputs. No case compares a modelled bulk
temperature against a published one, so they are exercised only through everything that depends
on a heat capacity. The nichrome element resistance shows up in every test that runs
`load-dc-heater-12v-100w`, but only as the load's rated behaviour, which is an input.

## The solver

| key | role | supplies | exercised by |
|---|---|---|---|
| `vlach-singhal` | method | modified nodal analysis, damped Newton, trust region, GMIN, convergence tolerances | `solver.test.js`, `linalg.test.js`, `conservation.test.js` |

This is a method reference with no published figure to compare against, so no validation case
cites it. What stands in for one is the test suite. `linalg.test.js` checks the sparse LU against
hand-solved systems, pivoting and a 200-node ladder. `solver.test.js` checks that a battery, two
conductors and an element reproduce Ohm's law, that parallel sources share by internal
resistance, that the answer is independent of the starting guess, and that galvanic islands are
formed from device port groups rather than pattern matching. `conservation.test.js` closes the
energy and charge balance on every step to the catalog's relative tolerance and shows that the
check catches a device that invents heat or misreports a port current. The solver tolerances
themselves are an `assumption:` traced to the SPICE defaults in this reference.

## Batteries

| key | role | supplies | exercised by |
|---|---|---|---|
| `battleborn-bb10012` | input, check | pack ratings, charge and float voltages, BMS cutoffs, 0 C charge lockout | case `battery-discharge`, `solar.test.js` |
| `lfp-ocv-typical` | input | per-cell open-circuit voltage against depth of discharge | case `battery-discharge` |
| `lfp-internal-resistance` | input | internal resistance and its temperature and state-of-charge factors | case `battery-discharge` |
| `plett-bms` | method | coulomb counting with coulombic efficiency, OCV plus I R terminal model | case `battery-discharge`, `conservation.test.js` |
| `lfp-cycle-life` | input | capacity fade per equivalent full cycle | not directly compared |
| `lfp-thermal-runaway` | input, method | Arrhenius self-heating, 200 C onset, 500 kJ/kg release | not directly compared |

Case `battery-discharge` is where the first four meet. The rated 100 Ah is an input, but how much
of it comes back out at C/2 is not: the terminal voltage is the OCV curve minus I R, the
resistance rises as the pack empties, the BMS opens on cell voltage, and the coulomb counter runs
at a coulombic efficiency below one. The model returns 98.5 Ah and 1223 Wh against the published
100 Ah and 1280 Wh. `conservation.test.js` accounts for the charge coulomb by coulomb against the
integral of the port current, which is the `plett-bms` bookkeeping. `solar.test.js` exercises the
0 C charge lockout and its consequence, an array with nowhere to put its energy while the pack
still runs the load.

`lfp-cycle-life` is unchecked. The fade rate is a `derived:` value (20 % loss over 3000 equivalent
full cycles) and no case or test runs a pack long enough to observe it.

`lfp-thermal-runaway` supplies the onset temperature and heat release for the Arrhenius
self-heating term, and its own note is explicit that the pre-exponential factor is an
order-of-magnitude fit to the reported self-heating rate. Nothing in `tests/unit/` or
`validation/cases/` drives a cell into runaway, so neither the onset nor the release is compared.

## Photovoltaics

| key | role | supplies | exercised by |
|---|---|---|---|
| `canadian-solar-cs6k-300ms` | input, check | 300 W module STC point, coefficients, NOCT 43 C, geometry, three bypass diodes | cases `panel-stc`, `panel-temperature` |
| `renogy-100d` | input, check | 100 W module STC point, 36 cells, geometry, NOCT 47 C | cases `panel-stc`, `panel-temperature` |
| `desoto-2006` | method | five-parameter single-diode model, I0 and Iph temperature dependence, 1.121 eV band gap | cases `panel-stc`, `panel-temperature` |
| `villalva-2009` | method | iterative extraction of Rs and Rsh from the datasheet STC point | case `panel-stc` |
| `faiman-2008` | method | T_cell = T_amb + G / (U0 + U1 wind) | case `panel-temperature` |
| `koehl-2011` | input | U0 = 25.0 W/m2K, U1 = 6.84 W/m3sK for a glass/backsheet module on an open rack | case `panel-temperature` |

The two datasheets supply four numbers each (Isc, Voc, Vmp, Imp) plus the Isc and Voc temperature
coefficients. Case `panel-stc` sweeps the extracted curve back at STC: Isc, Voc and Pmp are exact
by construction, Vmp and Imp land within 0.8 %, and the fill factor, which is not one of the four
inputs, reproduces to four figures. Case `panel-temperature` takes the two genuine checks. dPmp/dT
is measured between 25 C and 75 C cell and compared with the datasheet coefficient the model was
never given (-0.364 against -0.390 %/C for the larger module, -0.366 against -0.400 for the
smaller). NOCT is the same kind of check on the thermal side, because the module's cooling comes
from the Faiman coefficients rather than from its own NOCT rating.

`villalva-2009` is only exercised through `panel-stc`, which is the point: the extraction is
correct if and only if the resulting curve reproduces the module it was extracted from. The diode
ideality factor is the one electrical input that is an `estimate:`, bounded by this reference's
recommended 1.0 to 1.5.

`faiman-2008` supplies the form and `koehl-2011` the coefficients, so NOCT tests the two together.
Both modules use the same coefficients, which is why the model cannot tell their NOCT ratings
apart. Bypass-diode behaviour under shade is exercised by `solar.test.js`, but against no
published figure: the diode saturation current and ideality are `estimate:` values.

## The solar resource and weather

| key | role | supplies | exercised by |
|---|---|---|---|
| `noaa-solar` | method | declination, equation of time, hour angle, elevation, azimuth | case `solar-geometry` |
| `duffie-beckman` | method, check | Hay-Davies transposition, eccentricity correction, closed-form noon altitude and sunset hour angle | cases `solar-geometry`, `daily-yield` |
| `bird-hulstrom-1981` | method, input | clear-sky DNI, DHI and GHI, and the atmosphere parameters it takes | case `daily-yield` |
| `nrel-nsrdb-denver` | check | annual mean GHI near 5.3 kWh/m2/day at Denver | case `daily-yield` |
| `nrel-denver-yield` | input, check | site latitude, longitude, tilt and azimuth; annual yield near 1650 kWh/kWdc | case `daily-yield`, `solar.test.js` |
| `pvwatts-v5` | input, check | system-loss breakdown, inverter model shape, cloud-series shape | case `daily-yield` |
| `noaa-denver-normals` | input | annual mean 11.6 C, 12.0 C half-amplitude, 15 C diurnal range | not directly compared |

`solar-geometry` is the cleanest case in the repo. The engine runs the full NOAA/Meeus equations;
Duffie and Beckman publish two closed forms (noon altitude 90 minus the latitude-declination
difference, and the sunset hour angle) that neither appears in the code nor could be fitted. Noon
altitude matches to 0.1 % at both solstices and the equinox. Day length is consistently about
nine minutes long, which is the model putting sunrise at a 90.833 degree zenith for the sun's
upper limb and refraction while the closed form uses 90.

`daily-yield` carries the rest. Global horizontal irradiance is the honest test of sun position,
clear sky and cloud series together, because no array orientation enters it: 5.34 against the
published 5.3 kWh/m2/day. The array yield and the tilt gain are the two comparisons that expose
the model's weather. `solar.test.js` adds bracketing checks on a June and a December day at the
same site, including the aperture ceiling (POA energy times STC efficiency) that the array must
stay under.

`noaa-denver-normals` sets the ambient temperature cycle. No case compares a modelled ambient
against a station normal, so the cycle is only checked indirectly: `thermal.test.js` confirms the
ambient comes from the environment rather than a constant, and the December cases in
`solar.test.js` depend on the annual term being there at all.

## Power electronics

| key | role | supplies | exercised by |
|---|---|---|---|
| `victron-phoenix-1200` | input, check | 12 V 1000 W inverter ratings, efficiency curve, overload curve, DC trip thresholds | `inverter.test.js`, case `incandescent-lamp` |
| `victron-mppt-100-50` | input | 50 A MPPT ratings, efficiency curve, LiFePO4 stage profile, self-consumption | case `daily-yield`, `solar.test.js` |
| `esram-chapman` | method | perturb-and-observe step size and dwell | case `daily-yield`, `solar.test.js` |
| `victron-multiplus` | input | 48 V 2400 W inverter ratings and curves | not directly compared |

`victron-phoenix-1200` is the one power-electronics reference with real comparisons behind it.
`inverter.test.js` shows the no-load draw and open-circuit output coming from the datasheet rather
than a constant, terminal efficiency staying under the conversion curve at four real appliance
loads, half-load efficiency matching the published point once the idle draw and the output
impedance loss are accounted for, an overload tripping on the datasheet curve and then hiccuping
against its own lockout, a derated rating at a 60 C heatsink, an undersized DC cable tripping
under-voltage before anything is delivered, and reverse polarity being cleared by the BMS rather
than by the fuse. Case `incandescent-lamp` uses the same inverter as the supply, so its output
regulation is part of that result.

`victron-mppt-100-50` is exercised heavily and compared never. Every case and test that runs an
array runs this controller, but no published controller figure (98 % peak efficiency, the stage
voltages, the 10 mA self-consumption) is compared against a modelled one. `esram-chapman` is in
the same position: the tracker demonstrably tracks, since `daily-yield` would not reach the
published GHI-driven yield otherwise, but no tracking-efficiency figure is checked.

`victron-multiplus` backs `inverter-48v-2400w`, which appears in no test and no case.

## Protection devices

| key | role | supplies | exercised by |
|---|---|---|---|
| `atc-fuse-curve` | input | ATC blade fuse time-current points, hold multiple, cold resistance | `protection.test.js` |
| `anl-fuse-curve` | input | ANL fuse time-current points and hold multiple | `protection.test.js`, `inverter.test.js` |
| `bluesea-187` | input | thermal DC breaker time-current curve and reset behaviour | `protection.test.js` |
| `bluesea-9001` | input | 300 A switch make-and-break rating, contact resistance, busbar rating | `solver.test.js`, `protection.test.js` |
| `ul489` | input | must-hold at 100 %, must-trip within an hour at 135 %, thermal band, magnetic region | not directly compared |

These are inputs, and the tests around them are consistency tests rather than validation. The
damage integral `dD/dt = 1/t_trip(I/I_rated)` reproduces every digitised point by construction, so
`protection.test.js` asking whether the trip time agrees with the curve is asking whether the
integral over a changing fault current lands within a factor of a few of the constant-current
reading, which it does. What the tests do establish is behaviour that no single number encodes: a
dead short blows its own fuse and leaves the rest of the system running, a bolted short is a race
between the BMS and the protection device won by whichever integral fills first, a breaker can be
reset and a fuse cannot, and a fuse below its hold current never accumulates damage.

`ul489` backs `breaker-ac-15a` and `breaker-ac-20a`, neither of which appears in any test or case.
`bluesea-9001` backs the busbar and battery switch that most tests wire through, but neither the
300 A rating nor the contact resistance is compared against anything.

## Loads

| key | role | supplies | exercised by |
|---|---|---|---|
| `ge-lamp-handbook` | input, check | 2850 K colour temperature, cold-to-hot ratio near 15, run-up near 0.1 s, glass spectral split | case `incandescent-lamp`, `thermal.test.js` |
| `dc-immersion-heater` | input | the reference resistive DC load, a bare Nikrothal element on 12 V | used throughout, no figure compared |
| `dc-led-strip` | input | the small resistive DC load, a 12 V LED tape measured as a resistance | `solar.test.js` overnight load |
| `energystar-fridge` | input | compressor input power, run-time fraction, locked-rotor inrush multiple | not directly compared |
| `secop-bd35f` | input | 12 V DC compressor power, 10.4 V cut-out, 11.7 V restart, inrush multiple | not used by any test or case |
| `shurflo-4008` | input | 3.0 gpm at 45 psi, 7.5 A at 12 V, bypass so power is head-independent | not used by any test or case |

`ge-lamp-handbook` supplies the colour temperature and rated hot resistance, and the filament
geometry was `derived:` to satisfy both, so neither is a test. Two things were not put in. The
cold-to-hot resistance ratio comes from the tungsten power law, and the run-up time comes from the
filament's mass against its radiating area. Case `incandescent-lamp` takes the first solve 10
microseconds after switch-on for the cold resistance and then times the run-up: 15.59 against a
published 15, and 0.06 s against a published 0.1 s. `thermal.test.js` separately confirms the
filament reaches colour temperature with a cool envelope, which is the spectral split doing its
job.

`energystar-fridge` supplies `load-fridge-400w`, which several `inverter.test.js` tests use as an
AC load. The published run-time fraction and the locked-rotor inrush multiple are not compared
against anything; the load is there to be a constant-power machine on a sagging bus. The two DC
appliances, `secop-bd35f` and `shurflo-4008`, are catalogued and unexercised.

## Fire and damage

| key | role | supplies | exercised by |
|---|---|---|---|
| `pvc-ignition` | input | PVC softening 105 C, char 250 C, auto-ignition 450 C, heat of combustion 20 MJ/kg | `protection.test.js`, `wireFire.test.js` |
| `sfpe-handbook` | input | free-burning mass-loss rate 0.02 kg/m2s, radiative fraction 0.3 | `wireFire.test.js` |

`protection.test.js` runs an unprotected 14 AWG feeder at about 100 A until it ignites and burns
itself open, then confirms the electrical consequence: the branch is dead and the loads have lost
their supply. `tests/scenario/wireFire.test.js` runs the same fault as a whole-system scenario and
adds the ending: the fire consumes the only fuel it has, opens the circuit that was feeding it, and
warms a bystander 100 mm away without taking it. Neither asserts that ignition happens at a
particular temperature. The 450 C figure, the 20 MJ/kg heat of combustion and both SFPE figures are
inputs no case measures.

## What is not validated

The 48 comparisons across the eight cases are all inside tolerance. The gaps are elsewhere.

**Published figures near the edge of their band.** Six comparisons sit in the upper half of their
allowance, and each names a known modelling limit rather than noise.

| case | comparison | error | allowed |
|---|---|---|---|
| `conductor-ampacity` | 14 AWG rise at 25 A, 60 C column | 22.4 % | 25 % |
| `daily-yield` | annual DC yield at the array | 18.2 % | 20 % |
| `conductor-ampacity` | 14 AWG rise at 30 A, 75 C column | 16.4 % | 25 % |
| `daily-yield` | in-plane gain over horizontal | 11.2 % | 15 % |
| `incandescent-lamp` | run-up time | 40 % | 50 % |
| `panel-temperature` | RNG-100D NOCT cell temperature | 9.3 % | 10 % |

The 14 AWG entries run hot in both columns: a 1.6 mm cylinder has a thinner boundary layer than
the Churchill-Chu correlations were fitted for, and the table's small-conductor entries carry
termination margin the model has no way to know about. The `daily-yield` array figures are one
error, not two. The model's in-plane insolation is 1.22 times its own horizontal where the
PVWatts run implies about 1.10, because the synthetic cloud series has no seasonal structure and
leaves too many clear winter days, and there is no soiling or snow model. The RNG-100D NOCT is
structural: both modules use the same Faiman coefficients, so the smaller module's published 47 C
is about 4 K above anything those coefficients can produce.

**Parameters no case or test compares.** In role order, from unchecked reference to unchecked
number.

- Whole references with no comparison behind them: `ul489`, `victron-multiplus`, `secop-bd35f`,
  `shurflo-4008`, `lfp-cycle-life`, `lfp-thermal-runaway`, `matweb-materials`,
  `nichrome-properties`, `noaa-denver-normals`, `nec-ch9-t5`, and `nec-310-16`, which is not even
  cited.
- Two whole components are `estimate:` from the top: `controller-pwm-30a` (a generic 30 A
  controller, its series drop, on-resistance, stage profile and limits) and `load-led-10w` (a
  generic 10 W retrofit lamp whose 25 % wall-plug efficiency is a representative value).
  `load-hair-dryer-1500w` is a generic 1,500 W dryer whose 70 K air-stream rise rests on an
  estimated 0.02 kg/s mass flow.
- Every enclosure geometry is an estimate, and every thermal capacitance and surface area follows
  from it: the 328 by 172 by 214 mm battery case and the 4.1 kg of it that is not cells, the rack
  pack's conductance scaled by cell count, the MPPT's 185 by 250 by 95 mm finned case whose fins
  are assumed to double the bare box area, both inverter cases and their fan behaviour, the fridge
  and pump bodies, the LED tape on its aluminium channel, the immersion heater's 1.2 W/K
  element-to-sheath contact, and the fuse, breaker, switch and busbar bodies.
- Fire spread rests on `simulation.fire`. The mass-loss rate and radiative fraction come from
  `sfpe-handbook`, but they are mid-range values for charring polymers rather than measurements of
  any of the materials in the catalog, and the 0.15 m flame radius is an estimate. No case
  compares a spread rate against anything.
- Both PV bypass diodes use an `estimate:` junction characteristic, and the diode ideality factor
  is an estimate inside the range `villalva-2009` recommends.
- The BMS `protectionResponseSeconds` is an estimate, and the 5 C charge-reconnect threshold is
  estimated hysteresis above the published 0 C lockout. Both decide who wins the race in
  `protection.test.js`, so the outcome of that race is only as good as the estimate.
- `simulation.solver`, `simulation.integrator`, `simulation.conservation` and `simulation.weather`
  are `assumption:` blocks. The tolerances are defensible (SPICE defaults, tightened) and the
  cloud series is deterministic, but neither is a measurement, and the cloud series is the
  documented cause of the `daily-yield` overshoot above.

## Provenance defects this document found

Writing the map above turned up six places where a reference's note disagreed with how the model
actually used it. All six are fixed in `catalog/catalog.v3.json`; they are recorded here because
the same mistakes are easy to make again.

1. `nec-310-16` was declared and cited by nothing: the raceway ampacity entries carried
   `ampacitySource: ref:nec-310-17`, the free-air table. Splitting the provenance per column
   exposed the deeper problem, which was that the engine read no raceway figure at all. The
   column and the reference are both gone; `ampacityFreeAirSource` remains.
2. The `crc-handbook` note claimed tungsten, which `crc-tungsten` supplies instead. A filament
   needs resistivity over a 2500 K range, not one value at room temperature.
3. The `matweb-materials` title listed 6061 aluminium and borosilicate glass, neither of which is
   a material in the catalog, and omitted the silicon PV laminate, which it does supply.
4. `materials.abs-plastic` cited `ref:pvc-ignition` for its ignition temperature and heat of
   combustion. Those are PVC measurements. The source is now an `estimate:` that says so.
5. The `nec-ch9-t8` note claimed only cross-sectional areas, and the entries it covers also carry
   conductor diameters.
6. The SFPE Handbook backed two numbers in `simulation.fire` from inside an `estimate:` string, so
   a real published source sat outside the `references` block and outside the integrity check it
   enforces. It now has a key, `sfpe-handbook`.
