// The board: drag components out of the palette, wire terminal to terminal, and show what the
// engine reports about each of them. The editor holds no physics at all. Positions are pixels on
// a 24 px grid, which is the same grid the engine measures conductor length on.

import {
  GRID_SIZE_PX,
  componentGridSize,
  rotatedTerminalLayout
} from "./engine.js";

const byId = (id) => document.getElementById(id);

const EMPTY_VIEW = { devices: {}, hazards: [] };

export class CircuitEditor {
  constructor({ catalog, initialCircuit, wireTypeId, onChange, onSelectionChange }) {
    this.catalog = catalog;
    this.board = byId("circuit-board");
    this.componentLayer = byId("component-layer");
    this.wireLines = byId("wire-lines");
    this.wirePreview = byId("wire-preview");
    this.emptyHint = byId("empty-hint");
    this.onChange = onChange;
    this.onSelectionChange = onSelectionChange;
    // The gauge a new conductor gets is a toolbar setting, so the editor asks for it rather than
    // holding a copy that can go stale.
    this.wireTypeId = wireTypeId;
    this.circuit = initialCircuit ?? { components: [], wires: [] };
    this.selection = null;
    this.drag = null;
    this.wiring = null;
    this.view = EMPTY_VIEW;

    this.bindBoardEvents();
    this.render();
  }

  definition(componentId) {
    return this.catalog.component(componentId);
  }

  reading(id) {
    return this.view.devices[id] ?? null;
  }

  bindBoardEvents() {
    this.board.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.board.classList.add("drop-target");
    });
    this.board.addEventListener("dragleave", () => this.board.classList.remove("drop-target"));
    this.board.addEventListener("drop", (event) => {
      event.preventDefault();
      this.board.classList.remove("drop-target");
      const componentId = event.dataTransfer.getData("application/x-solar-component") ||
        event.dataTransfer.getData("text/plain");
      if (!this.catalog.components.has(componentId)) return;
      const point = this.boardPoint(event);
      this.addComponent(componentId, point.x, point.y);
    });
    this.board.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.board.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.board.addEventListener("pointercancel", () => this.cancelPointerAction());
    this.board.addEventListener("click", (event) => {
      if (event.target === this.board || event.target === this.componentLayer || event.target === this.wireLines) {
        this.select(null);
      }
    });
    window.addEventListener("resize", () => this.renderWires());
  }

  boardPoint(event) {
    const rect = this.board.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  snap(value) {
    return Math.max(0, Math.round(value / GRID_SIZE_PX) * GRID_SIZE_PX);
  }

  clampPosition(definition, x, y, rotation = 0) {
    const size = componentGridSize(definition, rotation);
    return {
      x: Math.min(this.snap(x), Math.max(0, this.board.clientWidth - size.width * GRID_SIZE_PX)),
      y: Math.min(this.snap(y), Math.max(0, this.board.clientHeight - size.height * GRID_SIZE_PX))
    };
  }

  addComponent(componentId, x, y) {
    const definition = this.definition(componentId);
    const position = this.clampPosition(
      definition,
      x - definition.gridSize.width * GRID_SIZE_PX / 2,
      y - definition.gridSize.height * GRID_SIZE_PX / 2
    );
    const id = crypto.randomUUID();
    this.circuit.components.push({ id, componentId, rotation: 0, ...position });
    this.select({ type: "component", id });
    this.commit();
  }

  componentElement(component) {
    const definition = this.definition(component.componentId);
    const size = componentGridSize(definition, component.rotation ?? 0);
    const reading = this.reading(component.id);
    const element = document.createElement("div");
    element.className = `circuit-component ${definition.model.type}-component`;
    element.dataset.id = component.id;
    element.tabIndex = 0;
    element.style.left = `${component.x}px`;
    element.style.top = `${component.y}px`;
    element.style.width = `${size.width * GRID_SIZE_PX}px`;
    element.style.height = `${size.height * GRID_SIZE_PX}px`;
    if (this.selection?.type === "component" && this.selection.id === component.id) {
      element.classList.add("selected");
    }
    if (this.hazardComponentIds().has(component.id)) element.classList.add("hazard");
    if (reading?.burning) element.classList.add("on-fire");
    if (component.indoors) element.classList.add("indoors");

    // The label is clipped to the part's footprint; the terminals are not, because they sit on
    // its edges and have to stay droppable.
    const label = document.createElement("span");
    label.className = "component-label";

    const name = document.createElement("span");
    name.className = "component-name";
    // The board has the part's physical footprint to work with, so it gets the short label; the
    // palette and the tooltip carry the full one.
    name.textContent = definition.shortName ?? definition.name;
    label.append(name);

    const face = document.createElement("span");
    face.className = "component-reading";
    face.textContent = this.faceReading(definition, reading);
    label.append(face);
    element.append(label);

    for (const terminal of definition.terminals) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terminal";
      button.dataset.componentId = component.id;
      button.dataset.terminalId = terminal.id;
      button.dataset.role = terminal.role;
      button.dataset.domain = terminal.domain;
      const layout = rotatedTerminalLayout(definition, terminal, component.rotation ?? 0);
      button.style.left = `${layout.x / layout.width * 100}%`;
      button.style.top = `${layout.y / layout.height * 100}%`;
      button.textContent = terminal.label;
      button.title = `${terminal.label} (${terminal.role}, ${terminal.domain.toUpperCase()})`;
      button.addEventListener("pointerdown", (event) => this.startWire(event, component.id, terminal.id));
      element.append(button);
    }

    element.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".terminal")) return;
      this.startComponentDrag(event, component.id);
    });
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      this.select({ type: "component", id: component.id });
    });
    element.addEventListener("mouseenter", (event) => this.showTooltip(event, definition, component));
    element.addEventListener("mousemove", (event) => this.moveTooltip(event));
    element.addEventListener("mouseleave", () => this.hideTooltip());
    element.addEventListener("focus", (event) => this.showTooltip(event, definition, component));
    element.addEventListener("blur", () => this.hideTooltip());
    return element;
  }

  /**
   * The facts that belong on the part itself. A fuse is two grid spaces tall and has room for one;
   * a panel is four and has room for three. The rest is in the tooltip.
   */
  faceReading(definition, reading) {
    if (!reading) return "";
    const room = definition.gridSize.height >= 3 ? 3 : 1;
    const parts = [];
    if (definition.model.type === "battery") {
      parts.push(`${(reading.stateOfCharge * 100).toFixed(0)}%`);
    }
    if (definition.model.type === "switch") parts.push(reading.closed ? "closed" : "open");
    if (Number.isFinite(reading.powerWatts) && Math.abs(reading.powerWatts) >= 0.5) {
      parts.push(`${Math.abs(reading.powerWatts).toFixed(0)} W`);
    }
    if (Number.isFinite(reading.temperatureC)) parts.push(`${reading.temperatureC.toFixed(0)} °C`);
    return parts.slice(0, room).join(" • ");
  }

  showTooltip(event, definition, component) {
    const tooltip = byId("tooltip");
    const reading = this.reading(component.id) ?? {};
    const live = [];
    const push = (label, value) => value !== null && live.push([label, value]);
    push("Temperature", format(reading.temperatureC, 1, "°C"));
    push("Power", format(reading.powerWatts, 1, "W"));
    push("Current", format(reading.currentAmps, 2, "A"));
    if (definition.model.type === "battery") {
      push("Charge", format(reading.stateOfCharge * 100, 1, "%"));
      push("Terminal", format(reading.terminalVoltage, 2, "V"));
      push("Stored", format(reading.energyWh, 0, "Wh"));
    }
    if (definition.model.type === "pv") {
      push("In plane", format(reading.irradianceWPerM2, 0, "W/m²"));
    }
    if (definition.model.type === "inverter") {
      push("AC output", format(reading.acVoltage, 1, "V"));
      push("Efficiency", format(reading.efficiency * 100, 1, "%"));
    }
    if (definition.model.type === "chargeController") {
      push("Stage", reading.stage ?? null);
      push("Input", format(reading.inputWatts, 1, "W"));
    }
    if (reading.failure && reading.failure !== "ok") live.push(["State", reading.failure]);
    const readings = live
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
    const specifications = Object.entries(definition.specifications ?? {})
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
    tooltip.innerHTML =
      `<h3>${definition.name}</h3><p>${definition.description}</p>` +
      `<dl>${readings}${specifications}</dl>`;
    tooltip.hidden = false;
    this.moveTooltip(event);
  }

  showWireTooltip(event, wire) {
    const tooltip = byId("tooltip");
    const type = this.catalog.wireType(wire.wireTypeId);
    const reading = this.reading(wire.id) ?? {};
    const readings = [
      ["Current", format(reading.currentAmps, 2, "A")],
      ["Conductor", format(reading.conductorTemperatureC, 1, "°C")],
      ["Insulation", format(reading.insulationTemperatureC, 1, "°C")],
      ["Rated to", `${type.model.insulationRatingC} °C`],
      ["Voltage drop", format(reading.voltageDropVolts, 3, "V")],
      ["Heat", format(reading.heatWatts, 2, "W")],
      ["Length", format(reading.lengthMeters, 2, "m")]
    ]
      .filter(([, value]) => value !== null)
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
    tooltip.innerHTML = `<h3>${type.name}</h3><dl>${readings}</dl>`;
    tooltip.hidden = false;
    this.moveTooltip(event);
  }

  moveTooltip(event) {
    const tooltip = byId("tooltip");
    const x = Math.min((event.clientX ?? 12) + 14, window.innerWidth - tooltip.offsetWidth - 12);
    const y = Math.min((event.clientY ?? 12) + 14, window.innerHeight - tooltip.offsetHeight - 12);
    tooltip.style.left = `${Math.max(12, x)}px`;
    tooltip.style.top = `${Math.max(12, y)}px`;
  }

  hideTooltip() {
    byId("tooltip").hidden = true;
  }

  startComponentDrag(event, id) {
    event.preventDefault();
    const component = this.circuit.components.find((item) => item.id === id);
    this.drag = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originalX: component.x,
      originalY: component.y,
      moved: false
    };
    this.board.setPointerCapture(event.pointerId);
    this.select({ type: "component", id });
  }

  startWire(event, componentId, terminalId) {
    event.preventDefault();
    event.stopPropagation();
    const point = this.terminalPoint(componentId, terminalId);
    this.wiring = { pointerId: event.pointerId, from: { componentId, terminalId } };
    this.wirePreview.setAttribute("x1", point.x);
    this.wirePreview.setAttribute("y1", point.y);
    this.wirePreview.setAttribute("x2", point.x);
    this.wirePreview.setAttribute("y2", point.y);
    this.wirePreview.style.display = "block";
    this.board.setPointerCapture(event.pointerId);
  }

  onPointerMove(event) {
    if (this.drag?.pointerId === event.pointerId) {
      const component = this.circuit.components.find((item) => item.id === this.drag.id);
      const definition = this.definition(component.componentId);
      const position = this.clampPosition(
        definition,
        this.drag.originalX + event.clientX - this.drag.startX,
        this.drag.originalY + event.clientY - this.drag.startY,
        component.rotation ?? 0
      );
      if (position.x !== component.x || position.y !== component.y) this.drag.moved = true;
      Object.assign(component, position);
      const element = this.componentLayer.querySelector(`[data-id="${component.id}"]`);
      element.style.left = `${component.x}px`;
      element.style.top = `${component.y}px`;
      this.renderWires();
    }

    if (this.wiring?.pointerId === event.pointerId) {
      const point = this.boardPoint(event);
      this.wirePreview.setAttribute("x2", point.x);
      this.wirePreview.setAttribute("y2", point.y);
      this.componentLayer.querySelectorAll(".terminal").forEach((terminal) => terminal.classList.remove("wire-target"));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".terminal");
      if (target && !this.sameEndpoint(target, this.wiring.from)) target.classList.add("wire-target");
    }
  }

  onPointerUp(event) {
    if (this.drag?.pointerId === event.pointerId) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.commit();
    }

    if (this.wiring?.pointerId === event.pointerId) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".terminal");
      const from = this.wiring.from;
      this.cancelPointerAction();
      if (target && !this.sameEndpoint(target, from)) {
        const to = { componentId: target.dataset.componentId, terminalId: target.dataset.terminalId };
        const duplicate = this.circuit.wires.some((wire) =>
          (this.endpointEqual(wire.from, from) && this.endpointEqual(wire.to, to)) ||
          (this.endpointEqual(wire.from, to) && this.endpointEqual(wire.to, from))
        );
        if (!duplicate) {
          const wire = {
            id: crypto.randomUUID(),
            wireTypeId: this.wireTypeId(),
            from,
            to
          };
          this.circuit.wires.push(wire);
          this.select({ type: "wire", id: wire.id });
          this.commit();
        }
      }
    }
    if (this.board.hasPointerCapture(event.pointerId)) this.board.releasePointerCapture(event.pointerId);
  }

  sameEndpoint(element, endpoint) {
    return element.dataset.componentId === endpoint.componentId &&
      element.dataset.terminalId === endpoint.terminalId;
  }

  endpointEqual(first, second) {
    return first.componentId === second.componentId && first.terminalId === second.terminalId;
  }

  cancelPointerAction() {
    this.drag = null;
    this.wiring = null;
    this.wirePreview.style.display = "none";
    this.componentLayer.querySelectorAll(".wire-target").forEach((terminal) => terminal.classList.remove("wire-target"));
  }

  terminalPoint(componentId, terminalId) {
    const terminal = this.componentLayer.querySelector(
      `.terminal[data-component-id="${componentId}"][data-terminal-id="${terminalId}"]`
    );
    const terminalRect = terminal.getBoundingClientRect();
    const boardRect = this.board.getBoundingClientRect();
    return {
      x: terminalRect.left + terminalRect.width / 2 - boardRect.left,
      y: terminalRect.top + terminalRect.height / 2 - boardRect.top
    };
  }

  hazardComponentIds() {
    return new Set(this.view.hazards.flatMap((hazard) => hazard.componentIds));
  }

  hazardWireIds() {
    return new Set(this.view.hazards.flatMap((hazard) => hazard.wireIds));
  }

  render() {
    this.componentLayer.replaceChildren(...this.circuit.components.map((component) => this.componentElement(component)));
    this.emptyHint.classList.toggle("hidden", this.circuit.components.length > 0);
    this.renderWires();
  }

  renderWires() {
    const hazardIds = this.hazardWireIds();
    this.wireLines.replaceChildren();
    for (const wire of this.circuit.wires) {
      if (!this.hasEndpoint(wire.from) || !this.hasEndpoint(wire.to)) continue;
      const from = this.terminalPoint(wire.from.componentId, wire.from.terminalId);
      const to = this.terminalPoint(wire.to.componentId, wire.to.terminalId);
      const type = this.catalog.wireType(wire.wireTypeId);
      const reading = this.reading(wire.id);
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
      hit.setAttribute("class", "wire-hit");
      hit.setAttribute("tabindex", "0");
      hit.setAttribute("role", "button");
      hit.setAttribute("aria-label", `${type.name}. Select wire and view measurements.`);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "wire");
      line.setAttribute("aria-hidden", "true");
      // Thicker conductors are drawn thicker: gauge is a decision with consequences, so it
      // should be visible without opening a tooltip.
      line.style.strokeWidth = `${strokeWidth(this.catalog, type)}px`;
      for (const element of [hit, line]) {
        element.setAttribute("x1", from.x);
        element.setAttribute("y1", from.y);
        element.setAttribute("x2", to.x);
        element.setAttribute("y2", to.y);
      }
      if (hazardIds.has(wire.id)) line.classList.add("hazard");
      if (reading?.burning) line.classList.add("on-fire");
      if (this.selection?.type === "wire" && this.selection.id === wire.id) line.classList.add("selected");
      hit.addEventListener("click", (event) => {
        event.stopPropagation();
        this.select({ type: "wire", id: wire.id });
      });
      hit.addEventListener("mouseenter", (event) => this.showWireTooltip(event, wire));
      hit.addEventListener("mousemove", (event) => this.moveTooltip(event));
      hit.addEventListener("mouseleave", () => this.hideTooltip());
      hit.addEventListener("focus", (event) => this.showWireTooltip(event, wire));
      hit.addEventListener("blur", () => this.hideTooltip());
      hit.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.select({ type: "wire", id: wire.id });
      });
      this.wireLines.append(line, hit);
    }
  }

  hasEndpoint(endpoint) {
    return Boolean(this.componentLayer.querySelector(
      `.terminal[data-component-id="${endpoint.componentId}"][data-terminal-id="${endpoint.terminalId}"]`
    ));
  }

  select(selection) {
    this.selection = selection;
    this.render();
    this.onSelectionChange(selection);
  }

  selectedComponent() {
    if (this.selection?.type !== "component") return null;
    return this.circuit.components.find(({ id }) => id === this.selection.id) ?? null;
  }

  selectedWire() {
    if (this.selection?.type !== "wire") return null;
    return this.circuit.wires.find(({ id }) => id === this.selection.id) ?? null;
  }

  /** Installation choices the engine reads off the layout, not off the part. */
  setSelectedIndoors(indoors) {
    const component = this.selectedComponent();
    if (!component) return;
    if (indoors) component.indoors = true;
    else delete component.indoors;
    this.commit();
  }

  setSelectedWireType(wireTypeId) {
    const wire = this.selectedWire();
    if (!wire || !this.catalog.wireTypes.has(wireTypeId)) return;
    wire.wireTypeId = wireTypeId;
    this.commit();
    this.onSelectionChange(this.selection);
  }

  deleteSelection() {
    if (!this.selection) return;
    if (this.selection.type === "component") {
      this.circuit.components = this.circuit.components.filter(({ id }) => id !== this.selection.id);
      this.circuit.wires = this.circuit.wires.filter(
        ({ from, to }) => from.componentId !== this.selection.id && to.componentId !== this.selection.id
      );
    } else {
      this.circuit.wires = this.circuit.wires.filter(({ id }) => id !== this.selection.id);
    }
    this.selection = null;
    this.onSelectionChange(null);
    this.commit();
  }

  rotateSelection() {
    const component = this.selectedComponent();
    if (!component) return;
    const definition = this.definition(component.componentId);
    const oldSize = componentGridSize(definition, component.rotation ?? 0);
    const centerX = component.x + oldSize.width * GRID_SIZE_PX / 2;
    const centerY = component.y + oldSize.height * GRID_SIZE_PX / 2;
    component.rotation = ((component.rotation ?? 0) + 90) % 360;
    const newSize = componentGridSize(definition, component.rotation);
    Object.assign(
      component,
      this.clampPosition(
        definition,
        centerX - newSize.width * GRID_SIZE_PX / 2,
        centerY - newSize.height * GRID_SIZE_PX / 2,
        component.rotation
      )
    );
    this.commit();
  }

  clear() {
    this.circuit = { components: [], wires: [] };
    this.selection = null;
    this.onSelectionChange(null);
    this.commit();
  }

  replaceCircuit(circuit, notify = false) {
    this.circuit = circuit;
    this.selection = null;
    this.onSelectionChange(null);
    this.render();
    if (notify) this.onChange(this.getCircuit());
  }

  /** New readings for the same circuit: the layout is the editor's, the numbers are the engine's. */
  updateReadings(view) {
    this.view = view ?? EMPTY_VIEW;
    this.render();
  }

  getCircuit() {
    return structuredClone(this.circuit);
  }

  commit() {
    this.render();
    this.onChange(this.getCircuit());
  }
}

const format = (value, digits, unit) =>
  Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : null;

/** Line width from conductor area, so the ratio on screen is the ratio in copper. */
function strokeWidth(catalog, type) {
  const area = catalog.gauge(type.gauge).areaMm2;
  return Math.min(7, Math.max(2, 2 * Math.sqrt(area / 2.08)));
}
