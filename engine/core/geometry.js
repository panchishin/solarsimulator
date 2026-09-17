// Layout geometry. Shared by the engine (wire length) and the editor (terminal placement),
// so a wire's electrical length is the same number the user sees on screen.

export const GRID_SIZE_PX = 24;

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

/** Terminal position in grid spaces, from the component's pixel position. */
export function terminalGridPoint(component, definition, terminalId) {
  const terminal = definition.terminals.find(({ id }) => id === terminalId);
  if (!terminal) throw new RangeError(`Component ${component.id} has no terminal "${terminalId}"`);
  const layout = rotatedTerminalLayout(definition, terminal, component.rotation ?? 0);
  return {
    x: (component.x ?? 0) / GRID_SIZE_PX + layout.x,
    y: (component.y ?? 0) / GRID_SIZE_PX + layout.y
  };
}

/**
 * Wire length in metres: Manhattan distance between its endpoints, because wires are routed
 * along the grid, times the catalog's scale. A wire between adjacent terminals is never
 * shorter than one grid space, since the conductor has to reach both lugs.
 */
export function wireLengthMeters(catalog, componentsById, wire) {
  const from = componentsById.get(wire.from.componentId);
  const to = componentsById.get(wire.to.componentId);
  if (!from || !to) return 0;
  const fromPoint = terminalGridPoint(from, catalog.component(from.componentId), wire.from.terminalId);
  const toPoint = terminalGridPoint(to, catalog.component(to.componentId), wire.to.terminalId);
  const gridSpaces = Math.abs(fromPoint.x - toPoint.x) + Math.abs(fromPoint.y - toPoint.y);
  return Math.max(gridSpaces, 1) * catalog.simulation.metersPerGridSpace;
}
