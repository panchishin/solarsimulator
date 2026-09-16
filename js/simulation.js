const EPSILON = 1e-9;
const GRID_SIZE_PX = 24;

class UnionFind {
  constructor(items) {
    this.parent = new Map(items.map((item) => [item, item]));
  }

  find(item) {
    if (!this.parent.has(item)) return null;
    const parent = this.parent.get(item);
    if (parent !== item) this.parent.set(item, this.find(parent));
    return this.parent.get(item);
  }

  union(first, second) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot !== null && secondRoot !== null && firstRoot !== secondRoot) {
      this.parent.set(secondRoot, firstRoot);
    }
  }
}

const terminalKey = (componentId, terminalId) => `${componentId}::${terminalId}`;
const endpointKey = (endpoint) =>
  endpoint ? terminalKey(endpoint.componentId, endpoint.terminalId) : null;

function catalogMap(catalog) {
  const definitions = Array.isArray(catalog) ? catalog : catalog.components;
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function ambientFrom(catalog, ambientTemperatureC) {
  return Number.isFinite(ambientTemperatureC)
    ? ambientTemperatureC
    : (catalog.simulation?.ambientTemperatureC ?? 20);
}

export function createComponentState(definition, ambientTemperatureC = 20) {
  const state = {
    temperatureC: ambientTemperatureC,
    currentAmps: 0,
    powerWatts: 0,
    heatWatts: 0
  };
  if (definition.model.type !== "battery") return state;
  const stateOfCharge = definition.model.startingStateOfCharge ?? 0.8;
  return {
    ...state,
    energyWh: definition.model.capacityWh * stateOfCharge,
    stateOfCharge
  };
}

export function componentGridSize(definition, rotation = 0) {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 270
    ? { width: definition.gridSize.height, height: definition.gridSize.width }
    : { ...definition.gridSize };
}

export function rotatedTerminalLayout(definition, terminal, rotation = 0) {
  const normalized = ((rotation % 360) + 360) % 360;
  const { width, height } = definition.gridSize;
  let x = terminal.edge === "right" ? width : 0;
  let y = height * terminal.offset;

  if (normalized === 90) {
    [x, y] = [height - y, x];
  } else if (normalized === 180) {
    [x, y] = [width - x, height - y];
  } else if (normalized === 270) {
    [x, y] = [y, width - x];
  }

  return { x, y, ...componentGridSize(definition, normalized) };
}

function terminalGridPoint(component, definition, terminalId) {
  const terminal = definition.terminals.find(({ id }) => id === terminalId);
  const left = (component.x ?? 0) / GRID_SIZE_PX;
  const top = (component.y ?? 0) / GRID_SIZE_PX;
  const layout = rotatedTerminalLayout(
    definition,
    terminal,
    component.rotation ?? 0
  );
  return { x: left + layout.x, y: top + layout.y };
}

export function wirePhysicalProperties(catalog, components, wire) {
  const definitions = catalogMap(catalog);
  const instances = new Map(components.map((component) => [component.id, component]));
  const fromComponent = instances.get(wire.from.componentId);
  const toComponent = instances.get(wire.to.componentId);
  const fromDefinition = definitions.get(fromComponent?.componentId);
  const toDefinition = definitions.get(toComponent?.componentId);
  if (!fromComponent || !toComponent || !fromDefinition || !toDefinition) {
    return { lengthMeters: 0, resistanceOhms: 0, massKg: 0 };
  }

  const from = terminalGridPoint(fromComponent, fromDefinition, wire.from.terminalId);
  const to = terminalGridPoint(toComponent, toDefinition, wire.to.terminalId);
  const gridSpaces = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
  const lengthMeters = gridSpaces * (catalog.simulation?.metersPerGridSpace ?? 0.1);
  const wireModel = catalog.wire.model;
  const areaM2 = wireModel.conductorAreaMm2 * 1e-6;

  return {
    lengthMeters,
    resistanceOhms: wireModel.resistivityOhmMeters * lengthMeters / areaM2,
    massKg: wireModel.densityKgPerM3 * areaM2 * lengthMeters
  };
}

export function createWireState(catalog, components, wire, ambientTemperatureC = 20) {
  return {
    temperatureC: ambientTemperatureC,
    currentAmps: 0,
    powerWatts: 0,
    heatWatts: 0,
    ...wirePhysicalProperties(catalog, components, wire)
  };
}

export function buildNetlist(catalog, components, wires) {
  const definitions = catalogMap(catalog);
  const terminalRecords = [];

  for (const component of components) {
    const definition = definitions.get(component.componentId);
    if (!definition) continue;
    for (const terminal of definition.terminals) {
      terminalRecords.push({
        key: terminalKey(component.id, terminal.id),
        componentId: component.id,
        terminalId: terminal.id,
        terminal,
        definition
      });
    }
  }

  const unionFind = new UnionFind(terminalRecords.map(({ key }) => key));
  for (const wire of wires) unionFind.union(endpointKey(wire.from), endpointKey(wire.to));

  const netsByRoot = new Map();
  for (const record of terminalRecords) {
    const root = unionFind.find(record.key);
    if (!netsByRoot.has(root)) netsByRoot.set(root, []);
    netsByRoot.get(root).push(record);
  }

  const terminalToNet = new Map();
  const nets = [...netsByRoot.values()].map((terminals, index) => {
    const id = `net-${index}`;
    terminals.forEach(({ key }) => terminalToNet.set(key, id));
    return { id, terminals };
  });
  return { nets, terminalToNet };
}

function terminalNet(netlist, componentId, definition, role) {
  const terminal = definition.terminals.find((candidate) => candidate.role === role);
  if (!terminal) return null;
  return netlist.terminalToNet.get(terminalKey(componentId, terminal.id)) ?? null;
}

function addHazard(hazards, type, message, componentIds, wireIds = []) {
  const key = `${type}:${[...componentIds].sort().join(",")}`;
  if (!hazards.some((hazard) => hazard.key === key)) {
    hazards.push({ key, type, message, componentIds, wireIds });
  }
}

function wiresOnNets(wires, netIds, netlist) {
  return wires.filter((wire) => {
    const fromNet = netlist.terminalToNet.get(endpointKey(wire.from));
    const toNet = netlist.terminalToNet.get(endpointKey(wire.to));
    return netIds.includes(fromNet) || netIds.includes(toNet);
  });
}

function addWireCurrent(wireCurrents, wires, currentAmps) {
  for (const wire of wires) {
    wireCurrents.set(wire.id, (wireCurrents.get(wire.id) ?? 0) + currentAmps);
  }
}

function wireConnects(wire, first, second) {
  return (
    endpointKey(wire.from) === endpointKey(first) &&
    endpointKey(wire.to) === endpointKey(second)
  ) || (
    endpointKey(wire.from) === endpointKey(second) &&
    endpointKey(wire.to) === endpointKey(first)
  );
}

function directWire(wires, first, second) {
  return wires.find((wire) => wireConnects(wire, first, second));
}

function totalWireResistance(wires, physicalWires) {
  return wires.reduce(
    (total, wire) => total + physicalWires.get(wire.id).resistanceOhms,
    0
  );
}

function evaluateLegacyCircuit({ catalog, components, wires }) {
  const definitions = catalogMap(catalog);
  const netlist = buildNetlist(catalog, components, wires);
  const hazards = [];
  const currents = new Map();
  const wireCurrents = new Map(wires.map((wire) => [wire.id, 0]));
  const componentMetrics = new Map();
  const wireMetrics = new Map();
  const operatingInverters = new Set();
  const operatingLoads = new Set();
  const physicalWires = new Map(
    wires.map((wire) => [wire.id, wirePhysicalProperties(catalog, components, wire)])
  );
  const batteries = [];
  const inverters = [];
  const loads = [];

  for (const component of components) {
    const definition = definitions.get(component.componentId);
    componentMetrics.set(component.id, {
      currentAmps: 0,
      powerWatts: 0,
      heatWatts: 0
    });
    if (definition?.model.type === "battery") batteries.push({ component, definition });
    if (definition?.model.type === "inverter") inverters.push({ component, definition });
    if (definition?.model.type === "load") loads.push({ component, definition });
  }

  for (const net of netlist.nets) {
    const domains = new Set(net.terminals.map(({ terminal }) => terminal.domain));
    if (domains.size > 1) {
      const componentIds = [...new Set(net.terminals.map(({ componentId }) => componentId))];
      addHazard(
        hazards,
        "mixed-ac-dc",
        "AC and DC terminals are connected on the same electrical net.",
        componentIds,
        wiresOnNets(wires, [net.id], netlist).map(({ id }) => id)
      );
    }
  }

  const sourceLoopCurrents = new Map();
  const batteriesInLoops = new Set();
  for (let firstIndex = 0; firstIndex < batteries.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < batteries.length; secondIndex += 1) {
      const first = batteries[firstIndex];
      const second = batteries[secondIndex];
      if (
        batteriesInLoops.has(first.component.id) ||
        batteriesInLoops.has(second.component.id)
      ) continue;
      const firstPositive = terminalNet(netlist, first.component.id, first.definition, "dc-positive");
      const firstNegative = terminalNet(netlist, first.component.id, first.definition, "dc-negative");
      const secondPositive = terminalNet(netlist, second.component.id, second.definition, "dc-positive");
      const secondNegative = terminalNet(netlist, second.component.id, second.definition, "dc-negative");
      const isClosedCrossLoop =
        firstPositive !== firstNegative &&
        firstPositive === secondNegative &&
        firstNegative === secondPositive;
      const bothEnergized =
        (first.component.state?.energyWh ?? 0) > 0 &&
        (second.component.state?.energyWh ?? 0) > 0;
      const firstPositiveTerminal = first.definition.terminals.find(
        ({ role }) => role === "dc-positive"
      );
      const firstNegativeTerminal = first.definition.terminals.find(
        ({ role }) => role === "dc-negative"
      );
      const secondPositiveTerminal = second.definition.terminals.find(
        ({ role }) => role === "dc-positive"
      );
      const secondNegativeTerminal = second.definition.terminals.find(
        ({ role }) => role === "dc-negative"
      );
      const positiveCrossWire = directWire(
        wires,
        { componentId: first.component.id, terminalId: firstPositiveTerminal.id },
        { componentId: second.component.id, terminalId: secondNegativeTerminal.id }
      );
      const negativeCrossWire = directWire(
        wires,
        { componentId: first.component.id, terminalId: firstNegativeTerminal.id },
        { componentId: second.component.id, terminalId: secondPositiveTerminal.id }
      );
      if (
        !isClosedCrossLoop ||
        !bothEnergized ||
        !positiveCrossWire ||
        !negativeCrossWire
      ) continue;

      const loopWires = [positiveCrossWire, negativeCrossWire];
      const wireResistance = totalWireResistance(loopWires, physicalWires);
      const totalResistance =
        first.definition.model.internalResistanceOhms +
        second.definition.model.internalResistanceOhms +
        wireResistance;
      const currentAmps =
        (first.definition.model.voltage + second.definition.model.voltage) /
        Math.max(totalResistance, EPSILON);

      sourceLoopCurrents.set(
        first.component.id,
        (sourceLoopCurrents.get(first.component.id) ?? 0) + currentAmps
      );
      batteriesInLoops.add(first.component.id);
      batteriesInLoops.add(second.component.id);
      sourceLoopCurrents.set(
        second.component.id,
        (sourceLoopCurrents.get(second.component.id) ?? 0) + currentAmps
      );
      addWireCurrent(wireCurrents, loopWires, currentAmps);
      addHazard(
        hazards,
        "battery-loop-short",
        `${first.definition.name} and ${second.definition.name} form a closed source loop.`,
        [first.component.id, second.component.id],
        loopWires.map(({ id }) => id)
      );
    }
  }

  for (const { component: battery, definition: batteryDefinition } of batteries) {
    const positiveNet = terminalNet(netlist, battery.id, batteryDefinition, "dc-positive");
    const negativeNet = terminalNet(netlist, battery.id, batteryDefinition, "dc-negative");
    let currentAmps = sourceLoopCurrents.get(battery.id) ?? 0;

    if (positiveNet === negativeNet && (battery.state?.energyWh ?? 0) > 0) {
      const shortWires = wiresOnNets(wires, [positiveNet], netlist);
      const wireResistance = totalWireResistance(shortWires, physicalWires);
      const shortCurrent = batteryDefinition.model.voltage /
        Math.max(batteryDefinition.model.internalResistanceOhms + wireResistance, EPSILON);
      currentAmps += shortCurrent;
      addWireCurrent(wireCurrents, shortWires, shortCurrent);
      addHazard(
        hazards,
        "dc-short",
        `${batteryDefinition.name} is short-circuited.`,
        [battery.id],
        shortWires.map(({ id }) => id)
      );
    }

    for (const { component: inverter, definition: inverterDefinition } of inverters) {
      const inverterPositive = terminalNet(netlist, inverter.id, inverterDefinition, "dc-positive");
      const inverterNegative = terminalNet(netlist, inverter.id, inverterDefinition, "dc-negative");
      const correctlyConnected =
        positiveNet !== negativeNet &&
        positiveNet === inverterPositive &&
        negativeNet === inverterNegative;
      const reversed =
        positiveNet !== negativeNet &&
        positiveNet === inverterNegative &&
        negativeNet === inverterPositive;

      if (reversed) {
        addHazard(
          hazards,
          "reversed-polarity",
          `${inverterDefinition.name} has reversed DC polarity.`,
          [battery.id, inverter.id],
          wiresOnNets(wires, [positiveNet, negativeNet], netlist).map(({ id }) => id)
        );
      }
      if (!correctlyConnected) continue;

      if (Math.abs(batteryDefinition.model.voltage - inverterDefinition.model.inputVoltage) > EPSILON) {
        addHazard(
          hazards,
          "voltage-mismatch",
          `${batteryDefinition.model.voltage} V source does not match the ${inverterDefinition.model.inputVoltage} V inverter input.`,
          [battery.id, inverter.id],
          wiresOnNets(wires, [positiveNet, negativeNet], netlist).map(({ id }) => id)
        );
        continue;
      }
      if ((battery.state?.energyWh ?? 0) <= 0) continue;

      const acLineNet = terminalNet(netlist, inverter.id, inverterDefinition, "ac-line");
      const acNeutralNet = terminalNet(netlist, inverter.id, inverterDefinition, "ac-neutral");
      const attachedLoads = loads.filter(({ component: load, definition: loadDefinition }) =>
        acLineNet !== acNeutralNet &&
        terminalNet(netlist, load.id, loadDefinition, "ac-line") === acLineNet &&
        terminalNet(netlist, load.id, loadDefinition, "ac-neutral") === acNeutralNet
      );
      const outputWatts = attachedLoads.reduce((total, { definition }) => total + definition.model.powerWatts, 0);
      const inputWatts = inverterDefinition.model.idleDrawWatts +
        outputWatts / inverterDefinition.model.efficiency;
      const inverterCurrent = inputWatts / batteryDefinition.model.voltage;
      currentAmps += inverterCurrent;
      operatingInverters.add(inverter.id);
      componentMetrics.set(inverter.id, {
        currentAmps: inverterCurrent,
        powerWatts: inputWatts,
        heatWatts: inverterDefinition.model.idleDrawWatts +
          outputWatts * (1 / inverterDefinition.model.efficiency - 1)
      });

      const dcWires = wiresOnNets(wires, [positiveNet, negativeNet], netlist);
      addWireCurrent(wireCurrents, dcWires, inverterCurrent);

      for (const { component: load, definition: loadDefinition } of attachedLoads) {
        const loadCurrent = loadDefinition.model.powerWatts / loadDefinition.model.voltage;
        componentMetrics.set(load.id, {
          currentAmps: loadCurrent,
          powerWatts: loadDefinition.model.powerWatts,
          heatWatts: loadDefinition.model.powerWatts
        });
        operatingLoads.add(load.id);
        const loadLineNet = terminalNet(netlist, load.id, loadDefinition, "ac-line");
        const loadNeutralNet = terminalNet(netlist, load.id, loadDefinition, "ac-neutral");
        addWireCurrent(
          wireCurrents,
          wiresOnNets(wires, [loadLineNet, loadNeutralNet], netlist),
          loadCurrent
        );
      }
    }

    currents.set(battery.id, currentAmps);
    componentMetrics.set(battery.id, {
      currentAmps,
      powerWatts: currentAmps * batteryDefinition.model.voltage,
      heatWatts: currentAmps ** 2 * batteryDefinition.model.internalResistanceOhms
    });
  }

  for (const wire of wires) {
    const physical = physicalWires.get(wire.id);
    const currentAmps = wireCurrents.get(wire.id) ?? 0;
    const heatWatts = currentAmps ** 2 * physical.resistanceOhms;
    wireMetrics.set(wire.id, {
      ...physical,
      currentAmps,
      powerWatts: heatWatts,
      heatWatts
    });
  }

  return {
    netlist,
    hazards,
    currents,
    wireCurrents,
    componentMetrics,
    wireMetrics,
    operatingInverters,
    operatingLoads
  };
}

function interpolateBatteryVoltage(definition, stateOfCharge) {
  const curve = definition.model.openCircuitVoltageCurve;
  if (!Array.isArray(curve) || curve.length === 0) return definition.model.voltage;
  const charge = Math.max(0, Math.min(1, stateOfCharge ?? 0));
  if (charge <= curve[0].stateOfCharge) return curve[0].voltage;
  for (let index = 1; index < curve.length; index += 1) {
    const upper = curve[index];
    const lower = curve[index - 1];
    if (charge <= upper.stateOfCharge) {
      const fraction = (charge - lower.stateOfCharge) /
        (upper.stateOfCharge - lower.stateOfCharge);
      return lower.voltage + fraction * (upper.voltage - lower.voltage);
    }
  }
  return curve.at(-1).voltage;
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < EPSILON) continue;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let entry = column; entry <= size; entry += 1) rows[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let entry = column; entry <= size; entry += 1) {
        rows[row][entry] -= factor * rows[column][entry];
      }
    }
  }
  return rows.map((row, index) =>
    Math.abs(row[index]) < EPSILON ? 0 : row[size]
  );
}

function solveResistiveNetwork({ branches, injections = new Map(), fixed = new Map() }) {
  const allNodes = new Set();
  const adjacency = new Map();
  for (const branch of branches) {
    allNodes.add(branch.from);
    allNodes.add(branch.to);
    if (!adjacency.has(branch.from)) adjacency.set(branch.from, new Set());
    if (!adjacency.has(branch.to)) adjacency.set(branch.to, new Set());
    adjacency.get(branch.from).add(branch.to);
    adjacency.get(branch.to).add(branch.from);
  }
  for (const node of injections.keys()) allNodes.add(node);
  const references = new Map(fixed);
  const visited = new Set();
  for (const start of allNodes) {
    if (visited.has(start)) continue;
    const stack = [start];
    const connectedNodes = [];
    while (stack.length) {
      const node = stack.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      connectedNodes.push(node);
      for (const neighbor of adjacency.get(node) ?? []) stack.push(neighbor);
    }
    if (!connectedNodes.some((node) => references.has(node))) {
      references.set(connectedNodes[0], 0);
    }
  }

  const unknownNodes = [...allNodes].filter((node) => !references.has(node));
  const indexes = new Map(unknownNodes.map((node, index) => [node, index]));
  const matrix = unknownNodes.map(() => unknownNodes.map(() => 0));
  const vector = unknownNodes.map((node) => injections.get(node) ?? 0);

  for (const branch of branches) {
    const conductance = 1 / Math.max(branch.resistanceOhms, EPSILON);
    for (const [node, other] of [[branch.from, branch.to], [branch.to, branch.from]]) {
      const row = indexes.get(node);
      if (row === undefined) continue;
      matrix[row][row] += conductance;
      const otherColumn = indexes.get(other);
      if (otherColumn === undefined) {
        vector[row] += conductance * (references.get(other) ?? 0);
      } else {
        matrix[row][otherColumn] -= conductance;
      }
    }
  }

  const solved = solveLinearSystem(matrix, vector);
  return new Map([
    ...references,
    ...unknownNodes.map((node, index) => [node, solved[index]])
  ]);
}

function addInjection(injections, node, amps) {
  injections.set(node, (injections.get(node) ?? 0) + amps);
}

function branchCurrent(branch, voltages) {
  return ((voltages.get(branch.from) ?? 0) - (voltages.get(branch.to) ?? 0)) /
    Math.max(branch.resistanceOhms, EPSILON);
}

function wireBranch(catalog, components, wire) {
  const physical = wirePhysicalProperties(catalog, components, wire);
  return {
    id: wire.id,
    type: "wire",
    from: endpointKey(wire.from),
    to: endpointKey(wire.to),
    resistanceOhms: physical.resistanceOhms,
    physical
  };
}

export function evaluateCircuit(snapshot) {
  const { catalog, components, wires } = snapshot;
  const legacy = evaluateLegacyCircuit(snapshot);
  const definitions = catalogMap(catalog);
  const componentMetrics = new Map(
    components.map(({ id }) => [id, { currentAmps: 0, powerWatts: 0, heatWatts: 0 }])
  );
  const wireMetrics = new Map();
  const wireCurrents = new Map(wires.map(({ id }) => [id, 0]));
  const instances = new Map(components.map((component) => [component.id, component]));
  const wireBranches = new Map();
  const operatingInverters = new Set();
  const operatingLoads = new Set();
  const branchesByDomain = { ac: [], dc: [] };

  for (const wire of wires) {
    const branch = wireBranch(catalog, components, wire);
    wireBranches.set(wire.id, branch);
    const fromDefinition = definitions.get(
      instances.get(wire.from.componentId)?.componentId
    );
    const terminal = fromDefinition?.terminals.find(({ id }) => id === wire.from.terminalId);
    if (terminal?.domain) branchesByDomain[terminal.domain].push(branch);
  }

  const loads = components.filter(
    ({ componentId }) => definitions.get(componentId)?.model.type === "load"
  );
  for (const load of loads) {
    const definition = definitions.get(load.componentId);
    branchesByDomain.ac.push({
      id: load.id,
      type: "load",
      from: terminalKey(load.id, definition.terminals.find(({ role }) => role === "ac-line").id),
      to: terminalKey(load.id, definition.terminals.find(({ role }) => role === "ac-neutral").id),
      resistanceOhms: definition.model.voltage ** 2 / definition.model.powerWatts
    });
  }

  const inverters = components.filter(
    ({ componentId }) => definitions.get(componentId)?.model.type === "inverter"
  );
  const batteries = components.filter(
    ({ componentId }) => definitions.get(componentId)?.model.type === "battery"
  );
  const probeBranches = [...branchesByDomain.dc];
  const probeInjections = new Map();
  const probeFixed = new Map();
  for (const battery of batteries) {
    if ((battery.state?.energyWh ?? 0) <= 0) continue;
    const definition = definitions.get(battery.componentId);
    const positive = terminalKey(
      battery.id,
      definition.terminals.find(({ role }) => role === "dc-positive").id
    );
    const negative = terminalKey(
      battery.id,
      definition.terminals.find(({ role }) => role === "dc-negative").id
    );
    const resistanceOhms = definition.model.internalResistanceOhms;
    const openCircuitVoltage = interpolateBatteryVoltage(
      definition,
      battery.state?.stateOfCharge
    );
    probeBranches.push({
      from: positive,
      to: negative,
      resistanceOhms
    });
    const nortonCurrent = openCircuitVoltage / resistanceOhms;
    addInjection(probeInjections, positive, nortonCurrent);
    addInjection(probeInjections, negative, -nortonCurrent);
    if (probeFixed.size === 0) probeFixed.set(negative, 0);
  }
  const probeVoltages = solveResistiveNetwork({
    branches: probeBranches,
    injections: probeInjections,
    fixed: probeFixed
  });
  const activeInverterIds = new Set();
  for (const inverter of inverters) {
    const definition = definitions.get(inverter.componentId);
    const positive = terminalKey(
      inverter.id,
      definition.terminals.find(({ role }) => role === "dc-positive").id
    );
    const negative = terminalKey(
      inverter.id,
      definition.terminals.find(({ role }) => role === "dc-negative").id
    );
    const inputVoltage =
      (probeVoltages.get(positive) ?? 0) - (probeVoltages.get(negative) ?? 0);
    const relativeError = Math.abs(inputVoltage - definition.model.inputVoltage) /
      definition.model.inputVoltage;
    if (inputVoltage > 0 && relativeError <= 0.15) {
      activeInverterIds.add(inverter.id);
    }
  }
  const acFixed = new Map();
  for (const inverter of inverters) {
    if (!activeInverterIds.has(inverter.id)) continue;
    const definition = definitions.get(inverter.componentId);
    acFixed.set(
      terminalKey(inverter.id, definition.terminals.find(({ role }) => role === "ac-neutral").id),
      0
    );
    acFixed.set(
      terminalKey(inverter.id, definition.terminals.find(({ role }) => role === "ac-line").id),
      definition.model.outputVoltage
    );
  }
  const acVoltages = solveResistiveNetwork({
    branches: branchesByDomain.ac,
    fixed: acFixed
  });

  for (const branch of branchesByDomain.ac) {
    const currentAmps = Math.abs(branchCurrent(branch, acVoltages));
    if (branch.type === "load") {
      const powerWatts = currentAmps ** 2 * branch.resistanceOhms;
      componentMetrics.set(branch.id, { currentAmps, powerWatts, heatWatts: powerWatts });
      if (powerWatts > EPSILON) operatingLoads.add(branch.id);
    } else {
      wireCurrents.set(branch.id, currentAmps);
    }
  }

  const inverterDemands = new Map();
  for (const inverter of inverters) {
    const definition = definitions.get(inverter.componentId);
    if (!activeInverterIds.has(inverter.id)) {
      inverterDemands.set(inverter.id, 0);
      continue;
    }
    const line = terminalKey(
      inverter.id,
      definition.terminals.find(({ role }) => role === "ac-line").id
    );
    const outputCurrent = branchesByDomain.ac
      .filter((branch) => branch.from === line || branch.to === line)
      .reduce((total, branch) => {
        const signed = branchCurrent(branch, acVoltages);
        return total + (branch.from === line ? signed : -signed);
      }, 0);
    const outputWatts = Math.max(0, definition.model.outputVoltage * outputCurrent);
    const inputWatts = definition.model.idleDrawWatts +
      outputWatts / definition.model.efficiency;
    inverterDemands.set(inverter.id, inputWatts);
    componentMetrics.set(inverter.id, {
      currentAmps: inputWatts / definition.model.inputVoltage,
      powerWatts: inputWatts,
      heatWatts: definition.model.idleDrawWatts +
        outputWatts * (1 / definition.model.efficiency - 1)
    });
    operatingInverters.add(inverter.id);
  }

  const dcInjections = new Map();
  const dcFixed = new Map();
  const currents = new Map(batteries.map(({ id }) => [id, 0]));
  for (const battery of batteries) {
    const definition = definitions.get(battery.componentId);
    if ((battery.state?.energyWh ?? 0) <= 0) continue;
    const positive = terminalKey(
      battery.id,
      definition.terminals.find(({ role }) => role === "dc-positive").id
    );
    const negative = terminalKey(
      battery.id,
      definition.terminals.find(({ role }) => role === "dc-negative").id
    );
    const resistanceOhms = definition.model.internalResistanceOhms;
    const openCircuitVoltage = interpolateBatteryVoltage(
      definition,
      battery.state?.stateOfCharge
    );
    branchesByDomain.dc.push({
      id: battery.id,
      type: "battery",
      from: positive,
      to: negative,
      resistanceOhms,
      openCircuitVoltage
    });
    const nortonCurrent = openCircuitVoltage / resistanceOhms;
    addInjection(dcInjections, positive, nortonCurrent);
    addInjection(dcInjections, negative, -nortonCurrent);
    if (dcFixed.size === 0) dcFixed.set(negative, 0);
  }

  const activeInverters = inverters
    .filter(({ id }) => activeInverterIds.has(id))
    .map((inverter) => {
      const definition = definitions.get(inverter.componentId);
      return {
        inverter,
        definition,
        positive: terminalKey(
          inverter.id,
          definition.terminals.find(({ role }) => role === "dc-positive").id
        ),
        negative: terminalKey(
          inverter.id,
          definition.terminals.find(({ role }) => role === "dc-negative").id
        )
      };
    });
  const inverterCurrents = new Map(
    activeInverters.map(({ inverter, definition }) => [
      inverter.id,
      (inverterDemands.get(inverter.id) ?? 0) / definition.model.inputVoltage
    ])
  );

  const solveDc = () => {
    const injections = new Map(dcInjections);
    for (const { inverter, positive, negative } of activeInverters) {
      const demandAmps = inverterCurrents.get(inverter.id) ?? 0;
      addInjection(injections, positive, -demandAmps);
      addInjection(injections, negative, demandAmps);
    }
    return solveResistiveNetwork({
      branches: branchesByDomain.dc,
      injections,
      fixed: dcFixed
    });
  };

  let dcVoltages = solveDc();
  for (let iteration = 0; iteration < 20; iteration += 1) {
    let largestChange = 0;
    for (const { inverter, positive, negative } of activeInverters) {
      const terminalVoltage = Math.abs(
        (dcVoltages.get(positive) ?? 0) - (dcVoltages.get(negative) ?? 0)
      );
      const nextCurrent = (inverterDemands.get(inverter.id) ?? 0) /
        Math.max(terminalVoltage, 1);
      largestChange = Math.max(
        largestChange,
        Math.abs(nextCurrent - (inverterCurrents.get(inverter.id) ?? 0))
      );
      inverterCurrents.set(inverter.id, nextCurrent);
    }
    dcVoltages = solveDc();
    if (largestChange < 1e-9) break;
  }

  for (const { inverter } of activeInverters) {
    const metrics = componentMetrics.get(inverter.id);
    componentMetrics.set(inverter.id, {
      ...metrics,
      currentAmps: inverterCurrents.get(inverter.id) ?? 0
    });
  }

  for (const branch of branchesByDomain.dc) {
    if (branch.type === "battery") {
      const terminalVoltage =
        (dcVoltages.get(branch.from) ?? 0) - (dcVoltages.get(branch.to) ?? 0);
      const currentAmps =
        (branch.openCircuitVoltage - terminalVoltage) / branch.resistanceOhms;
      currents.set(branch.id, currentAmps);
      componentMetrics.set(branch.id, {
        currentAmps,
        voltageVolts: terminalVoltage,
        powerWatts: branch.openCircuitVoltage * currentAmps,
        heatWatts: currentAmps ** 2 * branch.resistanceOhms
      });
    } else {
      wireCurrents.set(branch.id, Math.abs(branchCurrent(branch, dcVoltages)));
    }
  }

  for (const wire of wires) {
    const physical = wireBranches.get(wire.id).physical;
    const currentAmps = wireCurrents.get(wire.id) ?? 0;
    const heatWatts = currentAmps ** 2 * physical.resistanceOhms;
    wireMetrics.set(wire.id, {
      ...physical,
      currentAmps,
      powerWatts: heatWatts,
      heatWatts
    });
  }

  return {
    netlist: legacy.netlist,
    hazards: legacy.hazards,
    currents,
    wireCurrents,
    componentMetrics,
    wireMetrics,
    operatingInverters,
    operatingLoads
  };
}

export function calculateTemperature({
  previousTemperatureC,
  ambientTemperatureC,
  heatWatts,
  massKg,
  specificHeatJPerKgC,
  minutes,
  coolingCoefficientPerMinute
}) {
  const heatCapacity = massKg * specificHeatJPerKgC;
  const seconds = Math.max(0, minutes) * 60;
  if (seconds === 0 || heatCapacity <= EPSILON) return previousTemperatureC;
  const coolingPerSecond = Math.max(0, coolingCoefficientPerMinute) / 60;
  if (coolingPerSecond <= EPSILON) {
    return previousTemperatureC + heatWatts * seconds / heatCapacity;
  }
  const retention = Math.exp(-coolingPerSecond * seconds);
  return ambientTemperatureC +
    (previousTemperatureC - ambientTemperatureC) * retention +
    (heatWatts / heatCapacity) * (1 - retention) / coolingPerSecond;
}

export function findCoolingCoefficient({
  evaluatePeak,
  targetTemperatureC,
  lowerBound = 0,
  upperBound = 1,
  toleranceC = 0.1,
  maxIterations = 80
}) {
  if (
    !Number.isFinite(lowerBound) ||
    !Number.isFinite(upperBound) ||
    lowerBound >= upperBound ||
    !Number.isFinite(targetTemperatureC) ||
    !Number.isFinite(toleranceC) ||
    toleranceC <= 0 ||
    !Number.isInteger(maxIterations) ||
    maxIterations <= 0
  ) {
    throw new RangeError("Cooling calibration requires ordered finite bounds, positive tolerance, and positive iterations.");
  }

  let lower = lowerBound;
  let upper = upperBound;
  const lowerPeak = evaluatePeak(lower);
  const upperPeak = evaluatePeak(upper);
  if (
    !Number.isFinite(lowerPeak) ||
    !Number.isFinite(upperPeak) ||
    lowerPeak < targetTemperatureC ||
    upperPeak > targetTemperatureC
  ) {
    throw new RangeError("Cooling calibration bounds must bracket the target for a decreasing objective.");
  }

  let coefficient = lower;
  let peakTemperatureC = lowerPeak;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    coefficient = (lower + upper) / 2;
    peakTemperatureC = evaluatePeak(coefficient);
    if (Math.abs(peakTemperatureC - targetTemperatureC) <= toleranceC) {
      return { coefficient, peakTemperatureC, iterations: iteration };
    }
    if (peakTemperatureC > targetTemperatureC) {
      lower = coefficient;
    } else {
      upper = coefficient;
    }
  }

  return { coefficient, peakTemperatureC, iterations: maxIterations };
}

export function simulateTick(snapshot, minutesPerTick = 1) {
  const safeMinutes = Number.isFinite(minutesPerTick) ? Math.max(0, minutesPerTick) : 0;
  const ambientTemperatureC = ambientFrom(snapshot.catalog, snapshot.ambientTemperatureC);
  const coolingCoefficientPerMinute =
    snapshot.catalog.simulation?.coolingCoefficientPerMinute ?? 0.01;
  const result = evaluateCircuit(snapshot);
  const definitions = catalogMap(snapshot.catalog);

  const components = snapshot.components.map((component) => {
    const definition = definitions.get(component.componentId);
    const previousState = {
      ...createComponentState(definition, ambientTemperatureC),
      ...component.state
    };
    const metrics = result.componentMetrics.get(component.id) ?? {
      currentAmps: 0,
      powerWatts: 0,
      heatWatts: 0
    };
    const nextState = {
      ...previousState,
      ...metrics,
      temperatureC: calculateTemperature({
        previousTemperatureC: previousState.temperatureC,
        ambientTemperatureC,
        heatWatts: metrics.heatWatts,
        massKg: definition.model.massKg,
        specificHeatJPerKgC: definition.model.specificHeatJPerKgC,
        minutes: safeMinutes,
        coolingCoefficientPerMinute
      })
    };

    if (definition.model.type === "battery") {
      const energyUsedWh = metrics.powerWatts * safeMinutes / 60;
      nextState.energyWh = Math.max(
        0,
        Math.min(definition.model.capacityWh, previousState.energyWh - energyUsedWh)
      );
      nextState.stateOfCharge = nextState.energyWh / definition.model.capacityWh;
    }
    return { ...component, state: nextState };
  });

  const wires = snapshot.wires.map((wire) => {
    const previousState = {
      ...createWireState(snapshot.catalog, snapshot.components, wire, ambientTemperatureC),
      ...wire.state
    };
    const metrics = result.wireMetrics.get(wire.id);
    return {
      ...wire,
      state: {
        ...previousState,
        ...metrics,
        temperatureC: calculateTemperature({
          previousTemperatureC: previousState.temperatureC,
          ambientTemperatureC,
          heatWatts: metrics.heatWatts,
          massKg: metrics.massKg,
          specificHeatJPerKgC: snapshot.catalog.wire.model.specificHeatJPerKgC,
          minutes: safeMinutes,
          coolingCoefficientPerMinute
        })
      }
    };
  });

  return {
    ...snapshot,
    components,
    wires,
    ambientTemperatureC,
    elapsedMinutes: (snapshot.elapsedMinutes ?? 0) + safeMinutes,
    report: {
      hazards: result.hazards,
      operatingInverterIds: [...result.operatingInverters],
      operatingLoadIds: [...result.operatingLoads],
      componentMetrics: Object.fromEntries(result.componentMetrics),
      wireMetrics: Object.fromEntries(result.wireMetrics)
    }
  };
}

export function resetSimulation(snapshot) {
  const ambientTemperatureC = ambientFrom(
    snapshot.catalog,
    snapshot.ambientTemperatureC
  );
  const definitions = catalogMap(snapshot.catalog);
  const components = snapshot.components.map((component) => ({
    ...component,
    state: createComponentState(
      definitions.get(component.componentId),
      ambientTemperatureC
    )
  }));
  const wires = snapshot.wires.map((wire) => ({
    ...wire,
    state: createWireState(
      snapshot.catalog,
      components,
      wire,
      ambientTemperatureC
    )
  }));

  return {
    ...snapshot,
    components,
    wires,
    ambientTemperatureC,
    elapsedMinutes: 0
  };
}
