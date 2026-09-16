import {
  componentGridSize,
  rotatedTerminalLayout
} from "./simulation.js";

const GRID_SIZE = 24;
const FIRE_TEMPERATURE_C = 140;

const byId = (id) => document.getElementById(id);

export class CircuitEditor {
  constructor({ catalog, initialCircuit, onChange, onSelectionChange }) {
    this.catalog = catalog;
    this.definitions = new Map(catalog.components.map((item) => [item.id, item]));
    this.board = byId("circuit-board");
    this.componentLayer = byId("component-layer");
    this.wireLines = byId("wire-lines");
    this.wirePreview = byId("wire-preview");
    this.emptyHint = byId("empty-hint");
    this.onChange = onChange;
    this.onSelectionChange = onSelectionChange;
    this.circuit = initialCircuit ?? { components: [], wires: [] };
    this.selection = null;
    this.drag = null;
    this.wiring = null;
    this.report = { hazards: [] };

    this.bindBoardEvents();
    this.render();
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
      if (!this.definitions.has(componentId)) return;
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
    return Math.max(0, Math.round(value / GRID_SIZE) * GRID_SIZE);
  }

  clampPosition(definition, x, y, rotation = 0) {
    const size = componentGridSize(definition, rotation);
    return {
      x: Math.min(this.snap(x), Math.max(0, this.board.clientWidth - size.width * GRID_SIZE)),
      y: Math.min(this.snap(y), Math.max(0, this.board.clientHeight - size.height * GRID_SIZE))
    };
  }

  addComponent(componentId, x, y) {
    const definition = this.definitions.get(componentId);
    const position = this.clampPosition(
      definition,
      x - definition.gridSize.width * GRID_SIZE / 2,
      y - definition.gridSize.height * GRID_SIZE / 2
    );
    const id = crypto.randomUUID();
    const ambientTemperatureC = this.getAmbientTemperature();
    const state = {
      temperatureC: ambientTemperatureC,
      currentAmps: 0,
      powerWatts: 0,
      heatWatts: 0
    };
    if (definition.model.type === "battery") {
      state.energyWh = definition.model.capacityWh * definition.model.startingStateOfCharge;
      state.stateOfCharge = definition.model.startingStateOfCharge;
    }
    this.circuit.components.push({ id, componentId, rotation: 0, ...position, state });
    this.select({ type: "component", id });
    this.commit();
  }

  componentElement(component) {
    const definition = this.definitions.get(component.componentId);
    const size = componentGridSize(definition, component.rotation ?? 0);
    const element = document.createElement("div");
    element.className = `circuit-component ${definition.model.type}-component`;
    element.dataset.id = component.id;
    element.tabIndex = 0;
    element.style.left = `${component.x}px`;
    element.style.top = `${component.y}px`;
    element.style.width = `${size.width * GRID_SIZE}px`;
    element.style.height = `${size.height * GRID_SIZE}px`;
    if (this.selection?.type === "component" && this.selection.id === component.id) element.classList.add("selected");
    if (this.hazardComponentIds().has(component.id)) element.classList.add("hazard");
    if (
      definition.model.type !== "load" &&
      (component.state?.temperatureC ?? this.getAmbientTemperature()) > FIRE_TEMPERATURE_C
    ) {
      element.classList.add("on-fire");
    }

    const name = document.createElement("span");
    name.className = "component-name";
    name.textContent = definition.name;
    element.append(name);

    const reading = document.createElement("span");
    reading.className = "component-reading";
    const readings = [];
    if (definition.model.type === "battery") {
      readings.push(`${Math.round((component.state?.stateOfCharge ?? 0) * 100)}%`);
    }
    if (definition.model.type !== "load") {
      readings.push(`${(component.state?.temperatureC ?? this.getAmbientTemperature()).toFixed(1)} °C`);
    }
    reading.textContent = readings.join(" • ");
    element.append(reading);

    for (const terminal of definition.terminals) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terminal";
      button.dataset.componentId = component.id;
      button.dataset.terminalId = terminal.id;
      button.dataset.role = terminal.role;
      button.dataset.domain = terminal.domain;
      const layout = rotatedTerminalLayout(
        definition,
        terminal,
        component.rotation ?? 0
      );
      button.style.left = `${layout.x / layout.width * 100}%`;
      button.style.top = `${layout.y / layout.height * 100}%`;
      button.textContent = terminal.label;
      button.title = `${terminal.label} terminal`;
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

  showTooltip(event, definition, component) {
    const tooltip = byId("tooltip");
    const metrics = this.report.componentMetrics?.[component.id] ?? component.state ?? {};
    const liveReadings = [
      ["Temperature", `${(component.state?.temperatureC ?? this.getAmbientTemperature()).toFixed(1)} °C`],
      ["Current power", `${(metrics.powerWatts ?? 0).toFixed(1)} W`]
    ];
    if (definition.model.type === "battery") {
      liveReadings.push(
        ["Charge", `${((component.state?.stateOfCharge ?? 0) * 100).toFixed(1)}%`],
        ["Current voltage", `${(metrics.voltageVolts ?? definition.model.voltage).toFixed(2)} V`]
      );
    }
    const readings = liveReadings
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
    const specifications = Object.entries(definition.specifications)
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
    tooltip.innerHTML = `<h3>${definition.name}</h3><p>${definition.description}</p><dl>${readings}${specifications}</dl>`;
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
      const definition = this.definitions.get(component.componentId);
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
            from,
            to,
            state: {
              temperatureC: this.getAmbientTemperature(),
              currentAmps: 0,
              powerWatts: 0,
              heatWatts: 0
            }
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
    return new Set(this.report.hazards.flatMap((hazard) => hazard.componentIds));
  }

  hazardWireIds() {
    return new Set(this.report.hazards.flatMap((hazard) => hazard.wireIds));
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
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
      hit.setAttribute("class", "wire-hit");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "wire");
      for (const element of [hit, line]) {
        element.setAttribute("x1", from.x);
        element.setAttribute("y1", from.y);
        element.setAttribute("x2", to.x);
        element.setAttribute("y2", to.y);
      }
      if (hazardIds.has(wire.id)) line.classList.add("hazard");
      if ((wire.state?.temperatureC ?? this.getAmbientTemperature()) > FIRE_TEMPERATURE_C) {
        line.classList.add("on-fire");
      }
      if (this.selection?.type === "wire" && this.selection.id === wire.id) line.classList.add("selected");
      hit.addEventListener("click", (event) => {
        event.stopPropagation();
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
    if (this.selection?.type !== "component") return;
    const component = this.circuit.components.find(
      ({ id }) => id === this.selection.id
    );
    if (!component) return;
    const definition = this.definitions.get(component.componentId);
    const oldSize = componentGridSize(definition, component.rotation ?? 0);
    const centerX = component.x + oldSize.width * GRID_SIZE / 2;
    const centerY = component.y + oldSize.height * GRID_SIZE / 2;
    component.rotation = ((component.rotation ?? 0) + 90) % 360;
    const newSize = componentGridSize(definition, component.rotation);
    Object.assign(
      component,
      this.clampPosition(
        definition,
        centerX - newSize.width * GRID_SIZE / 2,
        centerY - newSize.height * GRID_SIZE / 2,
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

  getAmbientTemperature() {
    const ambient = Number(document.getElementById("ambient-input")?.value);
    return Number.isFinite(ambient)
      ? ambient
      : (this.catalog.simulation?.ambientTemperatureC ?? 20);
  }

  updateSimulation(components, wires, report) {
    this.circuit.components = components;
    this.circuit.wires = wires;
    this.report = report;
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
