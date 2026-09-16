import { CircuitEditor } from "./circuit.js";
import {
  evaluateCircuit,
  resetSimulation,
  simulateTick
} from "./simulation.js";

const STORAGE_KEY = "solar-power-simulator";
const STORAGE_VERSION = 2;
const MAX_HISTORY = 50;

const byId = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);

let catalog;
let editor;
let appState;
let timer = null;
let history = [];
let historyIndex = -1;
let restoringHistory = false;

function defaultState() {
  return {
    version: STORAGE_VERSION,
    activeLayoutId: "layout-1",
    layouts: {
      "layout-1": {
        id: "layout-1",
        name: "My first system",
        circuit: { components: [], wires: [] },
        elapsedMinutes: 0,
        ambientTemperatureC: catalog?.simulation?.ambientTemperatureC ?? 20
      }
    },
    settings: {
      theme: "default",
      minutesPerTick: 1,
      ticksPerSecond: 1,
      running: false
    }
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.version === 1) migrateVersionOne(parsed);
    if (
      parsed?.version !== STORAGE_VERSION ||
      !parsed.layouts?.[parsed.activeLayoutId] ||
      !Array.isArray(parsed.layouts[parsed.activeLayoutId].circuit?.components) ||
      !Array.isArray(parsed.layouts[parsed.activeLayoutId].circuit?.wires)
    ) return defaultState();
    return parsed;
  } catch {
    return defaultState();
  }
}

function migrateVersionOne(state) {
  const ambientTemperatureC = catalog.simulation?.ambientTemperatureC ?? 20;
  state.version = STORAGE_VERSION;
  for (const layout of Object.values(state.layouts ?? {})) {
    layout.ambientTemperatureC = ambientTemperatureC;
    for (const component of layout.circuit?.components ?? []) {
      component.state = {
        temperatureC: ambientTemperatureC,
        currentAmps: 0,
        powerWatts: 0,
        heatWatts: 0,
        ...component.state
      };
    }
    for (const wire of layout.circuit?.wires ?? []) {
      wire.state = {
        temperatureC: ambientTemperatureC,
        currentAmps: 0,
        powerWatts: 0,
        heatWatts: 0,
        ...wire.state
      };
    }
  }
}

function currentLayout() {
  return appState.layouts[appState.activeLayoutId];
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  byId("save-status").textContent = `Saved locally at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function setTheme(theme) {
  const safeTheme = ["default", "retro"].includes(theme) ? theme : "default";
  appState.settings.theme = safeTheme;
  document.documentElement.dataset.theme = safeTheme;
  byId("theme-select").value = safeTheme;
  saveState();
}

function renderPalette(filter = "all") {
  const items = catalog.components.filter((item) => filter === "all" || item.group === filter);
  byId("palette-count").textContent = items.length;
  byId("palette").replaceChildren(...items.map((definition) => {
    const item = document.createElement("div");
    item.className = "palette-item";
    item.draggable = true;
    item.tabIndex = 0;
    const primarySpecification = definition.specifications.Voltage ??
      definition.specifications["DC input"] ??
      definition.specifications.Supply ??
      definition.specifications.Power;
    item.innerHTML = `<strong>${definition.name}</strong><span>${definition.group} • ${primarySpecification}</span>`;
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-solar-component", definition.id);
      event.dataTransfer.setData("text/plain", definition.id);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dblclick", () => {
      editor.addComponent(definition.id, editor.board.clientWidth / 2, editor.board.clientHeight / 2);
    });
    return item;
  }));
}

function pushHistory(circuit) {
  if (restoringHistory) return;
  history = history.slice(0, historyIndex + 1);
  history.push(clone(circuit));
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  byId("undo-button").disabled = historyIndex <= 0;
  byId("redo-button").disabled = historyIndex >= history.length - 1;
}

function restoreHistory(index) {
  if (index < 0 || index >= history.length) return;
  historyIndex = index;
  restoringHistory = true;
  currentLayout().circuit = clone(history[index]);
  editor.replaceCircuit(clone(history[index]));
  restoringHistory = false;
  refreshEvaluation();
  saveState();
  updateHistoryButtons();
}

function onCircuitChange(circuit) {
  currentLayout().circuit = circuit;
  pushHistory(circuit);
  refreshEvaluation();
  saveState();
}

function onSelectionChange(selection) {
  const label = byId("selection-label");
  byId("delete-button").disabled = !selection;
  byId("rotate-button").disabled = selection?.type !== "component";
  if (!selection) {
    label.textContent = "Nothing selected";
    return;
  }
  if (selection.type === "wire") {
    label.textContent = "Wire selected";
    return;
  }
  const component = currentLayout().circuit.components.find(({ id }) => id === selection.id);
  const definition = catalog.components.find(({ id }) => id === component?.componentId);
  label.textContent = definition ? `${definition.name} selected` : "Component selected";
}

function snapshot() {
  return {
    catalog,
    components: currentLayout().circuit.components,
    wires: currentLayout().circuit.wires,
    elapsedMinutes: currentLayout().elapsedMinutes,
    ambientTemperatureC: currentLayout().ambientTemperatureC
  };
}

function refreshEvaluation() {
  const evaluation = evaluateCircuit(snapshot());
  const report = {
    hazards: evaluation.hazards,
    operatingInverterIds: [...evaluation.operatingInverters],
    operatingLoadIds: [...evaluation.operatingLoads],
    componentMetrics: Object.fromEntries(evaluation.componentMetrics),
    wireMetrics: Object.fromEntries(evaluation.wireMetrics)
  };
  editor.updateSimulation(
    currentLayout().circuit.components,
    currentLayout().circuit.wires,
    report
  );
  renderStatus(report);
  if (!currentLayout().circuit.components.length && !currentLayout().circuit.wires.length) {
    setRunning(false);
  }
}

function runTick() {
  const minutes = Number(appState.settings.minutesPerTick);
  const result = simulateTick(snapshot(), minutes);
  currentLayout().circuit.components = result.components;
  currentLayout().circuit.wires = result.wires;
  currentLayout().elapsedMinutes = result.elapsedMinutes;
  editor.updateSimulation(result.components, result.wires, result.report);
  renderStatus(result.report);
  saveState();
}

function resetSimulationState() {
  setRunning(false);
  const reset = resetSimulation(snapshot());
  currentLayout().circuit.components = reset.components;
  currentLayout().circuit.wires = reset.wires;
  currentLayout().elapsedMinutes = 0;
  refreshEvaluation();
  saveState();
}

function setRunning(running) {
  const hasItems = currentLayout().circuit.components.length > 0;
  appState.settings.running = Boolean(running && hasItems);
  clearInterval(timer);
  timer = null;
  if (appState.settings.running) {
    const interval = 1000 / appState.settings.ticksPerSecond;
    timer = setInterval(runTick, interval);
  }
  byId("run-button").textContent = appState.settings.running ? "Pause" : "Run";
  byId("run-indicator").textContent = appState.settings.running ? "Running" : "Paused";
  byId("run-indicator").classList.toggle("paused", !appState.settings.running);
  saveState();
}

function renderStatus(report) {
  const definitions = new Map(catalog.components.map((item) => [item.id, item]));
  const batteries = currentLayout().circuit.components.filter(
    ({ componentId }) => definitions.get(componentId)?.model.type === "battery"
  );
  const energy = batteries.reduce((total, battery) => total + (battery.state?.energyWh ?? 0), 0);
  const current = batteries.reduce((total, battery) => total + (battery.state?.currentAmps ?? 0), 0);
  const elapsed = currentLayout().elapsedMinutes;

  byId("elapsed-value").textContent = formatMinutes(elapsed);
  byId("energy-value").textContent = `${energy.toFixed(1)} Wh`;
  byId("current-value").textContent = `${current.toFixed(1)} A`;
  byId("inverter-value").textContent = report.operatingInverterIds.length
    ? `${report.operatingInverterIds.length} operating`
    : "Not operating";

  const itemCards = currentLayout().circuit.components.map((component) => {
    const definition = definitions.get(component.componentId);
    const metrics = report.componentMetrics?.[component.id] ?? component.state ?? {};
    const details = [];
    if (Number.isFinite(metrics.powerWatts)) details.push(["Power", `${metrics.powerWatts.toFixed(1)} W`]);
    details.push(["Heat", `${(metrics.heatWatts ?? 0).toFixed(2)} W`]);
    if (definition.model.type === "battery") {
      details.push(["Charge", `${Math.round((component.state?.stateOfCharge ?? 0) * 100)}%`]);
    }
    return itemCard(
      definition.name,
      `${(component.state?.temperatureC ?? currentLayout().ambientTemperatureC).toFixed(1)} °C`,
      details
    );
  });
  const wireCards = currentLayout().circuit.wires.map((wire, index) => {
    const metrics = report.wireMetrics?.[wire.id] ?? wire.state ?? {};
    return itemCard(
      `${catalog.wire.name} ${index + 1}`,
      `${(wire.state?.temperatureC ?? currentLayout().ambientTemperatureC).toFixed(1)} °C`,
      [
        ["Current", `${(metrics.currentAmps ?? 0).toFixed(2)} A`],
        ["Heat", `${(metrics.heatWatts ?? 0).toFixed(3)} W`],
        ["Length", `${(metrics.lengthMeters ?? wire.state?.lengthMeters ?? 0).toFixed(2)} m`]
      ]
    );
  });
  byId("item-status").replaceChildren(...(
    itemCards.length || wireCards.length
      ? [...itemCards, ...wireCards]
      : [paragraph("muted", "Place a component to begin.")]
  ));

  byId("hazard-list").replaceChildren(...(
    report.hazards.length
      ? report.hazards.map((hazard) => paragraph("hazard-card", hazard.message))
      : [paragraph("safe-message", "No active hazards")]
  ));
}

function itemCard(name, value, details) {
  const card = document.createElement("article");
  card.className = "item-card";
  const rows = details.map(([label, reading]) =>
    `<div><dt>${label}</dt><dd>${reading}</dd></div>`
  ).join("");
  card.innerHTML = `<strong><span>${name}</span><span>${value}</span></strong><dl>${rows}</dl>`;
  return card;
}

function paragraph(className, text) {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes.toFixed(minutes % 1 ? 1 : 0)} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  return `${hours}h ${remaining}m`;
}

function bindControls() {
  byId("palette-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
    renderPalette(button.dataset.filter);
  });
  byId("theme-select").addEventListener("change", (event) => setTheme(event.target.value));
  byId("run-button").addEventListener("click", () => setRunning(!appState.settings.running));
  byId("step-button").addEventListener("click", runTick);
  byId("reset-simulation-button").addEventListener("click", resetSimulationState);
  byId("minutes-input").addEventListener("change", (event) => {
    appState.settings.minutesPerTick = Math.max(0.01, Number(event.target.value) || 1);
    event.target.value = appState.settings.minutesPerTick;
    saveState();
  });
  byId("rate-input").addEventListener("change", (event) => {
    appState.settings.ticksPerSecond = Math.min(20, Math.max(0.1, Number(event.target.value) || 1));
    event.target.value = appState.settings.ticksPerSecond;
    setRunning(appState.settings.running);
  });
  byId("ambient-input").addEventListener("change", (event) => {
    currentLayout().ambientTemperatureC = Number.isFinite(Number(event.target.value))
      ? Number(event.target.value)
      : (catalog.simulation?.ambientTemperatureC ?? 20);
    event.target.value = currentLayout().ambientTemperatureC;
    refreshEvaluation();
    saveState();
  });
  byId("undo-button").addEventListener("click", () => restoreHistory(historyIndex - 1));
  byId("redo-button").addEventListener("click", () => restoreHistory(historyIndex + 1));
  byId("rotate-button").addEventListener("click", () => editor.rotateSelection());
  byId("delete-button").addEventListener("click", () => editor.deleteSelection());
  byId("clear-button").addEventListener("click", () => {
    if (currentLayout().circuit.components.length) {
      editor.clear();
    }
  });
  document.addEventListener("keydown", (event) => {
    const editingInput = event.target.matches("input, select, textarea");
    if (editingInput) return;
    if ((event.key === "Delete" || event.key === "Backspace") && editor.selection) {
      event.preventDefault();
      editor.deleteSelection();
    } else if (event.key === "Escape") {
      editor.cancelPointerAction();
      editor.select(null);
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      editor.rotateSelection();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      restoreHistory(historyIndex + (event.shiftKey ? 1 : -1));
    } else if (event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      restoreHistory(historyIndex + 1);
    }
  });
}

async function start() {
  const response = await fetch("components.json");
  if (!response.ok) throw new Error(`Could not load components (${response.status})`);
  catalog = await response.json();
  appState = loadState();
  document.documentElement.dataset.theme = appState.settings.theme;
  byId("theme-select").value = appState.settings.theme;
  byId("minutes-input").value = appState.settings.minutesPerTick;
  byId("rate-input").value = appState.settings.ticksPerSecond;
  byId("ambient-input").value = currentLayout().ambientTemperatureC ??
    catalog.simulation?.ambientTemperatureC ?? 20;
  byId("cooling-value").textContent =
    `${catalog.simulation?.coolingCoefficientPerMinute ?? 0.01}/min`;

  editor = new CircuitEditor({
    catalog,
    initialCircuit: clone(currentLayout().circuit),
    onChange: onCircuitChange,
    onSelectionChange
  });
  bindControls();
  renderPalette();
  pushHistory(editor.getCircuit());
  onSelectionChange(null);
  refreshEvaluation();
  setRunning(appState.settings.running);
}

start().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="load-error"><h1>Solar Power Simulator</h1><p>The component catalog could not be loaded. Run this project through a local static server.</p></main>`;
});
