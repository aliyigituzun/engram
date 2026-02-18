if (typeof globalThis.browser === "undefined") { globalThis.browser = chrome; }

const DEFAULT_WPM = 300;
const MIN_WPM = 100;
const MAX_WPM = 1200;
const STATUS_CLEAR_DELAY_MS = 2000;
const COMMAND_DIAGNOSTIC_STORAGE_KEY = "lastCommandDiagnostic";

document.addEventListener("DOMContentLoaded", () => {
  void initializePopup();
});

async function initializePopup() {
  const form = document.getElementById("settings-form");
  const wpmInput = document.getElementById("default-wpm");
  const autoContinueInput = document.getElementById("auto-continue");
  const stopBeforeHeaderInput = document.getElementById("stop-before-header");
  const stopBeforeMediaInput = document.getElementById("stop-before-media");
  const openPdfReaderButton = document.getElementById("open-pdf-reader");
  const statusEl = document.getElementById("save-status");
  const saveButton = document.getElementById("save-settings");
  const diagnosticEl = document.getElementById("command-diagnostic");
  const clearDiagnosticButton = document.getElementById("clear-command-diagnostic");

  if (
    !(form instanceof HTMLFormElement) ||
    !(wpmInput instanceof HTMLInputElement) ||
    !(autoContinueInput instanceof HTMLInputElement) ||
    !(stopBeforeHeaderInput instanceof HTMLInputElement) ||
    !(stopBeforeMediaInput instanceof HTMLInputElement) ||
    !(openPdfReaderButton instanceof HTMLButtonElement) ||
    !(statusEl instanceof HTMLElement) ||
    !(saveButton instanceof HTMLButtonElement) ||
    !(diagnosticEl instanceof HTMLElement) ||
    !(clearDiagnosticButton instanceof HTMLButtonElement)
  ) {
    return;
  }

  await hydrateForm({
    wpmInput,
    autoContinueInput,
    stopBeforeHeaderInput,
    stopBeforeMediaInput,
    statusEl,
  });
  await hydrateCommandDiagnostic(diagnosticEl);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const parsedWpm = parseWpm(wpmInput.value);
    if (parsedWpm === null) {
      setStatus(statusEl, `WPM must be between ${MIN_WPM} and ${MAX_WPM}.`, "error");
      wpmInput.focus();
      return;
    }

    saveButton.disabled = true;
    try {
      await browser.storage.local.set({
        defaultWpm: parsedWpm,
        autoContinue: autoContinueInput.checked,
        stopBeforeHeader: stopBeforeHeaderInput.checked,
        stopBeforeMedia: stopBeforeMediaInput.checked,
      });
      wpmInput.value = String(parsedWpm);
      setStatus(statusEl, "Settings saved.", "success");
    } catch (error) {
      console.debug("Engram settings save failed:", error);
      setStatus(statusEl, "Could not save settings.", "error");
    } finally {
      saveButton.disabled = false;
    }
  });

  wpmInput.addEventListener("input", () => {
    setStatus(statusEl, "");
  });

  clearDiagnosticButton.addEventListener("click", async () => {
    try {
      await browser.storage.local.remove(COMMAND_DIAGNOSTIC_STORAGE_KEY);
      renderCommandDiagnostic(diagnosticEl, null);
    } catch (error) {
      console.debug("Engram diagnostic clear failed:", error);
      setStatus(statusEl, "Could not clear shortcut diagnostics.", "error");
    }
  });

  openPdfReaderButton.addEventListener("click", async () => {
    try {
      await browser.tabs.create({
        url: browser.runtime.getURL("pdf-reader.html"),
      });
    } catch (error) {
      console.debug("Engram PDF reader launch failed:", error);
      setStatus(statusEl, "Could not launch PDF reader.", "error");
    }
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(COMMAND_DIAGNOSTIC_STORAGE_KEY in changes)) {
      return;
    }

    renderCommandDiagnostic(diagnosticEl, changes[COMMAND_DIAGNOSTIC_STORAGE_KEY].newValue ?? null);
  });
}

async function hydrateForm({
  wpmInput,
  autoContinueInput,
  stopBeforeHeaderInput,
  stopBeforeMediaInput,
  statusEl,
}) {
  try {
    const stored = await browser.storage.local.get([
      "defaultWpm",
      "autoContinue",
      "stopBeforeHeader",
      "stopBeforeMedia",
    ]);
    const parsedStoredWpm = parseWpm(stored.defaultWpm);
    wpmInput.value = String(parsedStoredWpm ?? DEFAULT_WPM);
    autoContinueInput.checked = Boolean(stored.autoContinue);
    stopBeforeHeaderInput.checked =
      typeof stored.stopBeforeHeader === "boolean" ? stored.stopBeforeHeader : true;
    stopBeforeMediaInput.checked =
      typeof stored.stopBeforeMedia === "boolean" ? stored.stopBeforeMedia : true;
  } catch (error) {
    console.debug("Engram settings load failed:", error);
    wpmInput.value = String(DEFAULT_WPM);
    autoContinueInput.checked = false;
    stopBeforeHeaderInput.checked = true;
    stopBeforeMediaInput.checked = true;
    setStatus(statusEl, "Using default settings.", "neutral");
  }
}

function parseWpm(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < MIN_WPM || parsed > MAX_WPM) {
    return null;
  }
  return parsed;
}

async function hydrateCommandDiagnostic(diagnosticEl) {
  try {
    const stored = await browser.storage.local.get([COMMAND_DIAGNOSTIC_STORAGE_KEY]);
    renderCommandDiagnostic(diagnosticEl, stored[COMMAND_DIAGNOSTIC_STORAGE_KEY] ?? null);
  } catch (error) {
    console.debug("Engram diagnostic load failed:", error);
    renderCommandDiagnostic(diagnosticEl, {
      level: "error",
      code: "DIAGNOSTIC_LOAD_FAILED",
      message: "Could not load shortcut diagnostics.",
      detail: String(error?.message ?? error),
      timestamp: Date.now(),
    });
  }
}

function renderCommandDiagnostic(diagnosticEl, diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") {
    diagnosticEl.textContent = "No shortcut diagnostics yet.";
    diagnosticEl.style.color = "rgba(255, 255, 255, 0.78)";
    return;
  }

  const message = typeof diagnostic.message === "string" ? diagnostic.message : "Unknown shortcut status.";
  const code = typeof diagnostic.code === "string" ? diagnostic.code : null;
  const detail = typeof diagnostic.detail === "string" ? diagnostic.detail : null;
  const url = typeof diagnostic.url === "string" ? diagnostic.url : null;
  const level = typeof diagnostic.level === "string" ? diagnostic.level : "neutral";
  const time = formatDiagnosticTimestamp(diagnostic.timestamp);

  const lines = [];
  lines.push(`${time}  ${message}${code ? ` (${code})` : ""}`);
  if (url) lines.push(`URL: ${url}`);
  if (detail) lines.push(`Detail: ${detail}`);
  diagnosticEl.textContent = lines.join("\n");

  if (level === "success") {
    diagnosticEl.style.color = "#56db9a";
  } else if (level === "error") {
    diagnosticEl.style.color = "#ff8f8f";
  } else if (level === "warning") {
    diagnosticEl.style.color = "#ffd07c";
  } else {
    diagnosticEl.style.color = "rgba(255, 255, 255, 0.78)";
  }
}

function formatDiagnosticTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "Unknown time";
  }

  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown time";
  }
}

let statusTimeoutId = null;

function setStatus(statusEl, message, type = "neutral") {
  statusEl.textContent = message;

  if (type === "success") {
    statusEl.style.color = "#56db9a";
  } else if (type === "error") {
    statusEl.style.color = "#ff8f8f";
  } else {
    statusEl.style.color = "rgba(255, 255, 255, 0.78)";
  }

  if (statusTimeoutId !== null) {
    window.clearTimeout(statusTimeoutId);
    statusTimeoutId = null;
  }

  if (message) {
    statusTimeoutId = window.setTimeout(() => {
      statusEl.textContent = "";
      statusTimeoutId = null;
    }, STATUS_CLEAR_DELAY_MS);
  }
}
