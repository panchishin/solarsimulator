// Nets, galvanic islands and reference nodes.
//
// Solver nodes are nets, not terminals. A wire is a two-port device with resistance, so the
// terminals at its ends are different nets and the voltage drop along it is real. Two nets are
// in the same galvanic island only if a device declares its ports on both of them to be
// conductively connected; that is what gives the AC side of an isolated inverter its own
// reference. Because nodes are nets, wiring a DC terminal to an AC terminal makes them one
// node: current flows, and the consequences come out of the solve rather than out of a
// pattern match.

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  add(item) {
    if (!this.parent.has(item)) this.parent.set(item, item);
    return item;
  }

  find(item) {
    this.add(item);
    let root = item;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let walk = item;
    while (this.parent.get(walk) !== walk) {
      const next = this.parent.get(walk);
      this.parent.set(walk, root);
      walk = next;
    }
    return root;
  }

  union(first, second) {
    const a = this.find(first);
    const b = this.find(second);
    if (a !== b) this.parent.set(b, a);
  }
}

export const terminalKey = (componentId, terminalId) => `${componentId}::${terminalId}`;

/**
 * @param {object} options
 * @param {Catalog} options.catalog
 * @param {object} options.layout `{ components, wires, joins? }`
 * @param {Array} options.devices engine devices, each with `ports`, `bindings`,
 *   `galvanicGroups` and optional `internalNodes`
 * @returns {{nets: Array, netByTerminal: Map, nodeCount: number, islands: Array,
 *   mixedDomainNets: Array}}
 */
export function buildNetlist({ catalog, layout, devices }) {
  const unionFind = new UnionFind();
  const terminalDomain = new Map();

  for (const component of layout.components) {
    const definition = catalog.component(component.componentId);
    for (const terminal of definition.terminals) {
      const key = terminalKey(component.id, terminal.id);
      unionFind.add(key);
      terminalDomain.set(key, {
        domain: terminal.domain,
        reference: terminal.reference === true,
        componentId: component.id,
        terminalId: terminal.id
      });
    }
  }

  // Direct terminal-to-terminal joins are ideal connections with no conductor. The editor
  // never produces them; test fixtures and validation cases use them to isolate one device.
  for (const [first, second] of layout.joins ?? []) {
    unionFind.union(
      terminalKey(first.componentId, first.terminalId),
      terminalKey(second.componentId, second.terminalId)
    );
  }

  const nets = [];
  const netIndexByRoot = new Map();
  const netByTerminal = new Map();

  const netFor = (root, seed) => {
    if (netIndexByRoot.has(root)) return nets[netIndexByRoot.get(root)];
    const net = {
      index: nets.length,
      id: `net-${nets.length}`,
      terminals: [],
      domains: new Set(),
      internal: seed?.internal ?? false,
      deviceId: seed?.deviceId,
      nodeIndex: -1,
      isReference: false,
      island: -1
    };
    netIndexByRoot.set(root, net.index);
    nets.push(net);
    return net;
  };

  for (const [key, info] of terminalDomain) {
    const net = netFor(unionFind.find(key));
    net.terminals.push(info);
    net.domains.add(info.domain);
    netByTerminal.set(key, net);
  }

  // Internal device nodes (PV substring boundaries, busbar centre) are nets of their own.
  for (const device of devices) {
    for (const name of device.internalNodes ?? []) {
      const key = `${device.id}##${name}`;
      unionFind.add(key);
      const net = netFor(unionFind.find(key), { internal: true, deviceId: device.id });
      net.domains.add(device.domain ?? "dc");
      netByTerminal.set(key, net);
    }
  }

  // Bind device ports to nets.
  for (const device of devices) {
    device.nets = new Map();
    for (const port of device.ports) {
      const binding = device.bindings[port.name];
      if (!binding) throw new RangeError(`Device ${device.id} port "${port.name}" has no binding`);
      const key = binding.internal
        ? `${device.id}##${binding.node}`
        : terminalKey(binding.componentId, binding.terminalId);
      const net = netByTerminal.get(key);
      if (!net) throw new RangeError(`Device ${device.id} port "${port.name}" binds to unknown ${key}`);
      device.nets.set(port.name, net);
      if (port.reference) net.preferredReference = true;
      for (const info of net.terminals) {
        if (info.reference) net.preferredReference = true;
      }
    }
  }

  // Galvanic islands: union nets that a device conductively connects.
  const islandFind = new UnionFind();
  for (const net of nets) islandFind.add(net.index);
  for (const device of devices) {
    for (const group of device.galvanicGroups) {
      const members = group.map((portName) => device.nets.get(portName)).filter(Boolean);
      for (let index = 1; index < members.length; index += 1) {
        islandFind.union(members[0].index, members[index].index);
      }
    }
  }

  const islandsByRoot = new Map();
  for (const net of nets) {
    const root = islandFind.find(net.index);
    if (!islandsByRoot.has(root)) islandsByRoot.set(root, []);
    islandsByRoot.get(root).push(net);
  }

  const islands = [];
  for (const members of islandsByRoot.values()) {
    const island = {
      index: islands.length,
      nets: members,
      referenceNet: null,
      domains: new Set()
    };
    const reference =
      members.find((net) => net.preferredReference) ??
      members.find((net) => !net.internal) ??
      members[0];
    reference.isReference = true;
    island.referenceNet = reference;
    for (const net of members) {
      net.island = island.index;
      for (const domain of net.domains) island.domains.add(domain);
    }
    islands.push(island);
  }

  let nodeCount = 0;
  for (const net of nets) {
    net.nodeIndex = net.isReference ? -1 : nodeCount++;
  }
  for (const device of devices) {
    device.nodes = new Map(
      [...device.nets].map(([portName, net]) => [portName, net.nodeIndex])
    );
  }

  // A net whose own terminals span two domains is a hard connection with no conductor between
  // them. An island spanning two domains is the more common case: a conductor runs from the DC
  // side to the AC side, so they are galvanically joined even though each end is its own net.
  const mixedDomainNets = nets.filter((net) => net.domains.size > 1);
  const mixedDomainIslands = islands.filter((island) => island.domains.size > 1);

  return { nets, netByTerminal, nodeCount, islands, mixedDomainNets, mixedDomainIslands };
}
