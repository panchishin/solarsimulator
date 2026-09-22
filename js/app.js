// The page: palette, board, clock and readouts. All physics is in engine/, reached through
// js/engine.js. What the browser stores is the layout and the moment the simulated day starts;
// the run itself lives in the engine, so reloading the page starts the day again.

import { CircuitEditor } from "./circuit.js";
import {
  createSession,
  defaultCircuit,
  fetchCatalog,
  groupLabel,
  paletteGroups,
  paletteItems,
  wireTypeOptions
} from "./engine.js";

const STORAGE_KEY = "solar-power-simulator";
const STORAGE_VERSION = 3;
const MAX_HISTORY = 50;
const DEFAULT_START = "2024-06-21T09:00";

const byId = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);

let catalog;
let editor;
let session;
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
        startLocal: DEFAULT_START
      }
    },
    settings: {
      theme: "default",
      minutesPerTick: 1,
      ticksPerSecond: 1,
      running: false,
      wireTypeId: "wire-cu-10awg-thhn"
    }
  };
}

/**
 * Layouts from before version 3 are not migrated. Their parts came from a different catalog and
 * their state came from a different simulation, so there is nothing honest to carry across.
 */
function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const layout = parsed?.layouts?.[parsed.activeLayoutId];
    if (
      parsed?.version !== STORAGE_VERSION ||
      !Array.isArray(layout?.circuit?.components) ||
      !Array.isArray(layout?.circuit?.wires)
    ) return defaultState();
    return parsed;
  } catch {
    return defaultState();
  }
}

const currentLayout = () => appState.layouts[appState.activeLayoutId];

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  byId("save-status").textContent = `Saved locally at ${time}`;
}

function setTheme(theme) {
  const safeTheme = ["default", "retro"].includes(theme) ? theme : "default";
  appState.settings.theme = safeTheme;
  document.documentElement.dataset.theme = safeTheme;
  byId("theme-select").value = safeTheme;
  saveState();
}

function renderPaletteFilters() {
  const row = byId("palette-filters");
  const groups = ["all", ...paletteGroups(catalog)];
  row.replaceChildren(...groups.map((group) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-button${group === "all" ? " active" : ""}`;
    button.dataset.filter = group;
    button.textContent = group === "all" ? "All" : groupLabel(group);
    return button;
  }));
}

function renderPalette(filter = "all") {
  const items = paletteItems(catalog, filter);
  byId("palette-count").textContent = items.length;
  byId("palette").replaceChildren(...items.map((definition) => {
    const item = document.createElement("div");
    item.className = "palette-item";
    item.draggable = true;
    item.tabIndex = 0;
    item.innerHTML =
      `<strong>${definition.name}</strong>` +
      `<span>${groupLabel(definition.group)} • ${definition.headline}</span>`;
    item.title = definition.description;
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-solar-component", definition.id);
      event.dataTransfer.setData("text/plain", definition.id);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dblclick", () => {
      editor.addComponent(
        definition.id,
        editor.board.clientWidth / 2,
        editor.board.clientHeight / 2
      );
    });
    return item;
  }));
}

function renderWireTypes() {
  const options = wireTypeOptions(catalog);
  for (const id of ["wire-type-select", "selected-wire-type"]) {
    byId(id).replaceChildren(...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = `${option.gauge} AWG (${option.ampacity} A)`;
      return element;
    }));
  }
  byId("wire-type-select").value = appState.settings.wireTypeId;
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
  applyCircuit();
  saveState();
  updateHistoryButtons();
}

function onCircuitChange(circuit) {
  currentLayout().circuit = circuit;
  pushHistory(circuit);
  applyCircuit();
  saveState();
}

/** The circuit changed: the engine takes the new layout and keeps the run going. */
function applyCircuit() {
  session.replaceCircuit(currentLayout().circuit);
  refresh();
  if (!currentLayout().circuit.components.length) setRunning(false);
}

function onSelectionChange(selection) {
  const label = byId("selection-label");
  byId("delete-button").disabled = !selection;
  byId("rotate-button").disabled = selection?.type !== "component";
  const indoorsRow = byId("indoors-row");
  const wireRow = byId("wire-row");
  const switchRow = byId("switch-row");
  indoorsRow.hidden = true;
  wireRow.hidden = true;
  switchRow.hidden = true;

  if (!selection) {
    label.textContent = "Nothing selected";
    return;
  }
  if (selection.type === "wire") {
    const wire = editor.selectedWire();
    label.textContent = `${catalog.wireType(wire.wireTypeId).name} selected`;
    byId("selected-wire-type").value = wire.wireTypeId;
    wireRow.hidden = false;
    return;
  }
  const component = editor.selectedComponent();
  const definition = component ? catalog.component(component.componentId) : null;
  label.textContent = definition ? `${definition.name} selected` : "Component selected";
  if (!component) return;
  byId("indoors-input").checked = Boolean(component.indoors);
  indoorsRow.hidden = false;
  if (definition.model.type === "switch") {
    switchRow.hidden = false;
    updateSwitchButton();
  }
}

function updateSwitchButton() {
  const component = editor.selectedComponent();
  if (!component) return;
  const closed = session.view().devices[component.id]?.closed ?? true;
  byId("switch-button").textContent = closed ? "Open the switch" : "Close the switch";
}

function refresh() {
  const view = session.view();
  editor.updateReadings(view);
  renderStatus(view);
  if (editor.selection?.type === "component") updateSwitchButton();
}

function runTick() {
  const minutes = Number(appState.settings.minutesPerTick);
  try {
    session.advanceMinutes(minutes);
  } catch (error) {
    // A step the solver cannot take at all is worth stopping for and saying so, not worth
    // pretending through.
    setRunning(false);
    byId("notice").textContent = `The simulation stopped: ${error.message}`;
    byId("notice").hidden = false;
    console.error(error);
  }
  refresh();
}

function resetSimulation() {
  setRunning(false);
  session.reset();
  byId("notice").hidden = true;
  refresh();
}

function setRunning(running) {
  const hasItems = currentLayout().circuit.components.length > 0;
  appState.settings.running = Boolean(running && hasItems);
  clearInterval(timer);
  timer = null;
  if (appState.settings.running) {
    timer = setInterval(runTick, 1000 / appState.settings.ticksPerSecond);
  }
  byId("run-button").textContent = appState.settings.running ? "Pause" : "Run";
  byId("run-indicator").textContent = appState.settings.running ? "Running" : "Paused";
  byId("run-indicator").classList.toggle("paused", !appState.settings.running);
  saveState();
}

function renderStatus(view) {
  const totals = view.totals;
  byId("clock-value").textContent = siteClock(view.date);
  byId("elapsed-value").textContent = formatMinutes(view.elapsedMinutes);
  byId("energy-value").textContent = `${totals.storedWh.toFixed(1)} Wh`;
  byId("generation-value").textContent = `${totals.generatedWatts.toFixed(0)} W`;
  byId("load-value").textContent = `${totals.loadWatts.toFixed(0)} W`;

  const environment = view.environment;
  byId("ambient-value").textContent = `${environment.ambientTemperatureC.toFixed(1)} °C`;
  byId("irradiance-value").textContent =
    `${environment.globalHorizontalWPerM2.toFixed(0)} W/m²`;
  byId("sun-value").textContent = environment.solarElevationDeg > 0
    ? `${environment.solarElevationDeg.toFixed(1)}° up`
    : "below the horizon";
  byId("sky-value").textContent = `${(environment.clearness * 100).toFixed(0)}% clear`;
  byId("wind-value").textContent = `${environment.windSpeedMPerS.toFixed(1)} m/s`;

  const cards = currentLayout().circuit.components.map((component) => {
    const definition = catalog.component(component.componentId);
    const reading = view.devices[component.id] ?? {};
    const details = [];
    if (Number.isFinite(reading.powerWatts)) {
      details.push(["Power", `${Math.abs(reading.powerWatts).toFixed(0)} W`]);
    }
    if (Number.isFinite(reading.currentAmps)) {
      details.push(["Current", `${reading.currentAmps.toFixed(1)} A`]);
    }
    if (definition.model.type === "battery") {
      details.push(["Charge", `${(reading.stateOfCharge * 100).toFixed(0)}%`]);
    }
    if (reading.failure && reading.failure !== "ok") details.push(["State", reading.failure]);
    const temperature = Number.isFinite(reading.temperatureC)
      ? `${reading.temperatureC.toFixed(1)} °C`
      : "—";
    return itemCard(definition.name, temperature, details);
  });
  byId("item-status").replaceChildren(...(
    cards.length ? cards : [paragraph("muted", "Place a component to begin.")]
  ));

  byId("hazard-list").replaceChildren(...(
    view.hazards.length
      ? view.hazards.map((hazard) => paragraph(
          hazard.severity === "critical" ? "hazard-card critical" : "hazard-card",
          hazard.message
        ))
      : [paragraph("safe-message", "No active hazards")]
  ));

  if (view.dropped.length) {
    byId("notice").textContent =
      `${view.dropped.length} saved item(s) were dropped: ` +
      view.dropped.map(({ reason }) => reason).join("; ");
    byId("notice").hidden = false;
  }
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

/**
 * The simulated instant, told in the site's own time. The browser may be anywhere; the array is
 * in Denver, and a reading at 09:00 means 09:00 there.
 */
function siteClock(date) {
  const shifted = new Date(date.getTime() + catalog.simulation.site.timeZoneHours * 3600 * 1000);
  return shifted.toLocaleString([], {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function startDate() {
  return new Date(`${currentLayout().startLocal}:00${timeZoneOffset()}`);
}

/** The site's own offset, so "09:00" means nine in the morning where the array is. */
function timeZoneOffset() {
  const hours = catalog.simulation.site.timeZoneHours;
  const sign = hours <= 0 ? "-" : "+";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

function bindControls() {
  byId("palette-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    document.querySelectorAll(".filter-button").forEach(
      (item) => item.classList.toggle("active", item === button)
    );
    renderPalette(button.dataset.filter);
  });
  byId("theme-select").addEventListener("change", (event) => setTheme(event.target.value));
  byId("run-button").addEventListener("click", () => setRunning(!appState.settings.running));
  byId("step-button").addEventListener("click", runTick);
  byId("reset-simulation-button").addEventListener("click", resetSimulation);
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
  byId("start-input").addEventListener("change", (event) => {
    currentLayout().startLocal = event.target.value || DEFAULT_START;
    event.target.value = currentLayout().startLocal;
    setRunning(false);
    session.setStartDate(startDate());
    refresh();
    saveState();
  });
  byId("wire-type-select").addEventListener("change", (event) => {
    appState.settings.wireTypeId = event.target.value;
    saveState();
  });
  byId("selected-wire-type").addEventListener("change", (event) => {
    editor.setSelectedWireType(event.target.value);
  });
  byId("indoors-input").addEventListener("change", (event) => {
    editor.setSelectedIndoors(event.target.checked);
  });
  byId("switch-button").addEventListener("click", () => {
    const component = editor.selectedComponent();
    if (!component) return;
    const closed = session.view().devices[component.id]?.closed ?? true;
    session.setSwitchClosed(component.id, !closed);
    refresh();
  });
  byId("undo-button").addEventListener("click", () => restoreHistory(historyIndex - 1));
  byId("redo-button").addEventListener("click", () => restoreHistory(historyIndex + 1));
  byId("rotate-button").addEventListener("click", () => editor.rotateSelection());
  byId("delete-button").addEventListener("click", () => editor.deleteSelection());
  byId("clear-button").addEventListener("click", () => {
    if (currentLayout().circuit.components.length) editor.clear();
  });
  byId("default-button").addEventListener("click", () => {
    // A starter system replaces the board rather than adding to it, and starts its own day: there
    // is no state worth carrying from the layout it just displaced.
    editor.replaceCircuit(defaultCircuit(catalog), true);
    resetSimulation();
  });
  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea")) return;
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
  catalog = await fetchCatalog();
  appState = loadState();
  if (!catalog.wireTypes.has(appState.settings.wireTypeId)) {
    appState.settings.wireTypeId = catalog.defaultWireTypeId;
  }
  document.documentElement.dataset.theme = appState.settings.theme;
  byId("theme-select").value = appState.settings.theme;
  byId("minutes-input").value = appState.settings.minutesPerTick;
  byId("rate-input").value = appState.settings.ticksPerSecond;
  byId("start-input").value = currentLayout().startLocal;
  const site = catalog.simulation.site;
  byId("site-value").textContent =
    `${site.latitudeDeg.toFixed(2)}°, ${site.longitudeDeg.toFixed(2)}°, ` +
    `${site.altitudeM} m, array at ${site.arrayTiltDeg}° tilt`;

  session = createSession({
    catalog,
    circuit: currentLayout().circuit,
    startDate: startDate()
  });

  editor = new CircuitEditor({
    catalog,
    initialCircuit: clone(session.circuit),
    wireTypeId: () => appState.settings.wireTypeId,
    onChange: onCircuitChange,
    onSelectionChange
  });
  bindControls();
  renderPaletteFilters();
  renderPalette();
  renderWireTypes();
  pushHistory(editor.getCircuit());
  onSelectionChange(null);
  refresh();
  setRunning(appState.settings.running);
}

start().catch((error) => {
  console.error(error);
  document.body.innerHTML =
    `<main class="load-error"><h1>Solar Power Simulator</h1>` +
    `<p>${error.message}</p>` +
    `<p>Run this project through a local static server.</p></main>`;
});
