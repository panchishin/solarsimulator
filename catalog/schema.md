# Catalog v3 schema

The catalog is the only place numbers live. The engine contains equations; the catalog
contains the quantities those equations consume. Nothing in `engine/` may hard-code a
device or material parameter.

## Top-level shape

```json
{
  "schemaVersion": 3,
  "references": { "<refKey>": { "title": "...", "note": "..." } },
  "simulation": { ... },
  "materials": { "<materialKey>": { ... } },
  "conductors": { "gauges": { "<awg>": { ... } } },
  "wires": [ { ... } ],
  "components": [ { ... } ]
}
```

## Provenance rule

Every numeric leaf must have a provenance. Provenance is declared with a `source` string
and **inherits down the object tree**: a `source` on an object covers every number inside
it, including nested objects and arrays, unless a nested object declares its own `source`.

A `source` value is one of:

| Form | Meaning |
|---|---|
| `ref:<refKey>` | Cited document; `<refKey>` must exist in `references`. |
| `derived:<text>` | Computed from other cited values by a named method. |
| `estimate:<text>` | Engineering estimate, with the basis stated in `<text>`. |
| `assumption:<text>` | A modelling choice, not a measurement (e.g. default ambient). |
| `constant:<text>` | Defined or exact value (e.g. seconds per hour). |

`engine/core/catalog.js` validates the regions the engine reads physics from — `simulation`,
`materials`, `conductors`, every `wires[].model` and every `components[].model` — and fails if
any number inside them is reachable without a `source` in scope, or if a `ref:` key is missing
from `references`. There is no way to add a physical parameter without stating where it came
from. Editor metadata outside those regions (`id`, `name`, `group`, `gridSize`, `terminals`,
`specifications`) is display data and is not validated for provenance.

A key ending in `Source` is itself provenance and annotates its sibling: `internalResistanceOhms`
and `internalResistanceSource` belong together. That is how a single object can hold values
from several documents without splitting into nested objects.

Units are carried in key names (`capacityAh`, `internalResistanceOhms`,
`surfaceAreaM2`, `massKg`, `temperatureC`, `...K` for absolute temperature). Keys without a
unit suffix are dimensionless (efficiencies, fractions, counts, exponents).

## `simulation`

Solver and world defaults: ambient temperature, grid-to-metre scale, `gminSiemens`
(node-to-reference leakage that keeps the nodal matrix non-singular and stands in for real
insulation leakage), Newton tolerances, integrator step bounds, and the default site
(latitude, longitude, altitude, albedo, pressure).

## `materials`

Per material: `densityKgPerM3`, `specificHeatJPerKgC`, `thermalConductivityWPerMK`,
`emissivity`, and where relevant `resistivityOhmMeters` with `resistivityReferenceTemperatureC`
plus either `resistivityTempCoefficientPerC` (linear, metals near room temperature) or
`resistivityTempExponent` (power law, refractory metals over a wide range),
`meltingPointC`, `ignitionTemperatureC`, `softeningTemperatureC`.

`materials.air` additionally carries reference-temperature transport properties
(`thermalConductivityWPerMK`, `kinematicViscosityM2PerS`, `prandtl`) and the exponents used
to scale them with film temperature. `engine/thermal/convection.js` reads these; it holds no
numbers of its own.

## `conductors.gauges`

Keyed by gauge name (`"14"`, `"1/0"`, `"4/0"`). Each entry:

```json
{
  "areaMm2": 5.26,
  "conductorDiameterMm": 2.59,
  "ampacityFreeAir60CAmps": 40,
  "ampacityFreeAir75CAmps": 50,
  "ampacityRaceway75CAmps": 35
}
```

Ampacities are reference values used by `validation/`, not by the engine: the engine derives
the steady temperature from the thermal solve and the validation harness compares it against
the table.

## `wires`

A wire is a catalog item, not a hard-coded constant. Each entry names a gauge, a conductor
material, an insulation material, an insulation outer diameter, and an insulation temperature
rating. Length comes from the layout geometry at run time.

## `components`

```json
{
  "id": "battery-lifepo4-12v-100ah",
  "group": "battery",
  "name": "...",
  "shortName": "...",
  "description": "...",
  "gridSize": { "width": 5, "height": 3 },
  "specifications": { "<label>": "<display string>" },
  "terminals": [
    { "id": "positive", "label": "+", "role": "dc-positive", "domain": "dc",
      "edge": "right", "offset": 0.3, "reference": false }
  ],
  "model": { "type": "battery", "source": "...", "electrical": {}, "limits": {}, "thermal": {} }
}
```

`specifications` is display text for the UI and carries no numbers the engine reads. `shortName`
is what fits on the part as drawn: `gridSize` is the component's real footprint, in grid spaces
that `simulation.metersPerGridSpace` converts to metres for wire length and fire spread, so the
label has to fit the box rather than the box the label.
`terminals[].role` and `.domain` are consumed by the netlist; `.reference: true` marks a
terminal that is a preferred ground for its galvanic island (battery negative, inverter AC
neutral).

### `model`

`model.type` selects the device factory in `engine/devices/registry.js`. Three sub-objects
are conventional:

- `electrical` — everything the `stamp` pass needs.
- `limits` — thresholds the `limits`/`events` passes compare against (trip curves, cutoffs,
  ratings, damage and ignition thresholds).
- `thermal` — the device's lumped network:

```json
"thermal": {
  "nodes": {
    "cell": { "material": "lifepo4-cell", "massKg": 10.0 },
    "case": { "material": "abs-plastic", "massKg": 4.2,
              "surface": { "geometry": "verticalPlate", "areaM2": 0.27,
                           "characteristicLengthM": 0.21 } }
  },
  "links": [ { "from": "cell", "to": "case", "conductanceWPerK": 5.0 } ],
  "ambientNode": "case"
}
```

A node with a `surface` block exchanges heat with ambient by natural (or, with
`surface.forcedAirVelocityMPerS`, forced) convection and by radiation, both computed from the
geometry — there is no global cooling coefficient. `links` are solid conduction paths.
`radiationLinks` are internal radiative couplings (`{ from, to, areaM2, emissivity,
viewFactor, transmittance }`) used by the incandescent lamp. `nodes[].heatShare` is optional
and only relevant for devices whose `heat()` splits dissipation across nodes by default.

### Device-type parameter blocks

| `type` | required `electrical` keys |
|---|---|
| `battery` | `nominalVoltage`, `capacityAh`, `startingStateOfCharge`, `internalResistanceOhms`, `openCircuitVoltageCurve` (SoC→V), `coulombicEfficiency`, `resistanceTemperatureFactors`, `capacityTemperatureFactors` |
| `pv` | `cellsInSeries`, `substrings`, `diodeIdeality`, STC point (`shortCircuitCurrentAmps`, `openCircuitVoltage`, `maxPowerVoltage`, `maxPowerCurrentAmps`), `iscTempCoefficientPerC`, `vocTempCoefficientPerC`, `bypassDiode`, `optical` (`areaM2`, `absorptance`, Faiman `u0`,`u1`) |
| `chargeController` | `topology` (`mppt`\|`pwm`), `efficiencyCurve` or `voltageDropVolts`, `maxChargeCurrentAmps`, `maxInputVoltage`, `idleDrawWatts`, `stages` (`absorbVoltage`, `floatVoltage`, `absorbHoldSeconds`, `tailCurrentFraction`) |
| `inverter` | `nominalInputVoltage`, `outputVoltage`, `outputFrequencyHz`, `continuousOutputWatts`, `idleDrawWatts`, `efficiencyCurve` (load fraction→η), `efficiencyTempCoefficientPerC`, `outputResistanceOhms`, `bodyDiode` |
| `load` | `behaviour` (`constantPower`\|`constantResistance`\|`incandescent`\|`compressor`), `ratedVoltage`, `ratedPowerWatts`, plus behaviour-specific keys (`dutyCycle`, `inrushMultiple`, `inrushSeconds`, `filament`) |
| `fuse` | `ratedAmps`, `coldResistanceOhms`, `timeCurrentCurve` |
| `breaker` | `ratedAmps`, `coldResistanceOhms`, `timeCurrentCurve`, `magneticMultiple`, `magneticTripSeconds` |
| `switch` | `closedResistanceOhms`, `ratedAmps`, `startsClosed` |
| `busbar` | `resistanceOhms`, `ratedAmps` |

`timeCurrentCurve` is an array of `{ multiple, seconds }` points, interpolated log-log.

## Adding a component

1. Add the `references` entry for the datasheet if it is not already there.
2. Add the component with a `source` on `model` (and narrower `source` fields wherever a
   value comes from somewhere else, e.g. a geometry estimate inside `thermal`).
3. Run `npm test`. The catalog test fails on any unsourced number, unknown material, unknown
   ref key, or missing required key for the declared `type`.
4. If the component has a datasheet performance claim, add a `validation/cases/` entry so the
   claim is checked against the model rather than asserted in a unit test.
