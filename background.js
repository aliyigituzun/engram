if (typeof globalThis.browser === "undefined") { globalThis.browser = chrome; }

const COMMAND_TOGGLE_SELECTION_MODE = "toggle-selection-mode";
const MESSAGE_TOGGLE_SELECTION_MODE = "swift-read:toggle-selection-mode";
const MESSAGE_SOURCE = "swift-read-background";

const COMMAND_DIAGNOSTIC_STORAGE_KEY = "lastCommandDiagnostic";
const ACTION_DEFAULT_TITLE = "Engram - RSVP Reader";
const RESTRICTED_URL_PREFIXES = [
  "about:",
  "moz-extension:",
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "edge:",
  "view-source:",
];

browser.commands.onCommand.addListener((command) => {
  if (command !== COMMAND_TOGGLE_SELECTION_MODE) {
    return;
  }

  void handleToggleSelectionCommand();
});

async function handleToggleSelectionCommand() {
  const activeTab = await getActiveTab();
  if (!activeTab) {
    await reportCommandFailure({
      code: "NO_ACTIVE_TAB",
      message: "No active tab found for shortcut handling.",
      detail: "browser.tabs.query() returned no active tab.",
    });
    return;
  }

  const tabId = activeTab.id;
  const tabUrl = typeof activeTab.url === "string" ? activeTab.url : null;

  if (typeof tabId !== "number") {
    await reportCommandFailure({
      code: "NO_TAB_ID",
      message: "Cannot target this tab for shortcut handling.",
      detail: "Active tab has no numeric tab ID.",
      url: tabUrl,
    });
    return;
  }

  if (tabUrl && !canMessageTab(tabUrl)) {
    await reportCommandFailure({
      tabId,
      code: "RESTRICTED_URL",
      message: "This page is browser-restricted; Engram cannot run here.",
      detail: "Browser internal pages do not allow content scripts.",
      url: tabUrl,
      badgeText: "ERR",
    });
    return;
  }

  const permissionState = await ensureHostPermissionForTab(tabUrl);
  if (!permissionState.granted) {
    const isFileUrl = typeof tabUrl === "string" && tabUrl.toLowerCase().startsWith("file:");
    await reportCommandFailure({
      tabId,
      code: isFileUrl ? "FILE_URL_PERMISSION_REQUIRED" : "HOST_PERMISSION_REQUEST_DENIED",
      message: isFileUrl
        ? "Enable file URL access for Engram, then retry."
        : "Site access permission was not granted for this tab.",
      detail: isFileUrl
        ? "Open extension details and enable \"Allow access to file URLs\"."
        : buildPermissionRequestDetail(permissionState),
      url: tabUrl,
      badgeText: isFileUrl ? "FILE" : "PERM",
    });
    return;
  }

  const firstAttempt = await sendToggleMessageToTab(tabId);
  if (firstAttempt.success) {
    await reportCommandSuccess({
      tabId,
      message: "Shortcut delivered to tab.",
      url: tabUrl,
      detail: "Message delivered on first attempt.",
    });
    return;
  }

  const shouldRetryWithInjection = isNoReceiverError(firstAttempt.error);
  let injectionResult = { attempted: false, success: false, error: null };

  if (shouldRetryWithInjection) {
    injectionResult = await tryInjectContentScripts(tabId);
    if (injectionResult.success) {
      const secondAttempt = await sendToggleMessageToTab(tabId);
      if (secondAttempt.success) {
        await reportCommandSuccess({
          tabId,
          message: "Shortcut delivered after reinjecting content script.",
          url: tabUrl,
          detail: "Initial send had no receiver; reinjection fixed it.",
        });
        return;
      }

      const retryPermissionFailure = resolvePermissionFailure(
        tabUrl,
        secondAttempt.error,
        injectionResult.error,
      );
      if (retryPermissionFailure) {
        await reportCommandFailure({
          tabId,
          code: retryPermissionFailure.code,
          message: retryPermissionFailure.message,
          detail: `${retryPermissionFailure.detail} | ${buildErrorDetail(
            secondAttempt.error,
            injectionResult.error,
          )}`,
          url: tabUrl,
          badgeText: retryPermissionFailure.badgeText,
        });
        return;
      }

      await reportCommandFailure({
        tabId,
        code: "NO_RECEIVER_AFTER_RETRY",
        message: "Could not deliver shortcut message after retry.",
        detail: buildErrorDetail(secondAttempt.error, injectionResult.error),
        url: tabUrl,
        badgeText: "ERR",
      });
      return;
    }
  }

  const permissionFailure = resolvePermissionFailure(
    tabUrl,
    firstAttempt.error,
    injectionResult.error,
  );
  if (permissionFailure) {
    await reportCommandFailure({
      tabId,
      code: permissionFailure.code,
      message: permissionFailure.message,
      detail: `${permissionFailure.detail} | ${buildErrorDetail(
        firstAttempt.error,
        injectionResult.error,
      )}`,
      url: tabUrl,
      badgeText: permissionFailure.badgeText,
    });
    return;
  }

  await reportCommandFailure({
    tabId,
    code: shouldRetryWithInjection ? "INJECTION_FAILED" : "MESSAGE_FAILED",
    message: "Could not deliver shortcut to active tab.",
    detail: buildErrorDetail(firstAttempt.error, injectionResult.error),
    url: tabUrl,
    badgeText: "ERR",
  });
}

function resolvePermissionFailure(url, sendError, injectionError) {
  if (!isPermissionError(sendError) && !isPermissionError(injectionError)) {
    return null;
  }

  const lowerUrl = typeof url === "string" ? url.toLowerCase() : "";
  const isFileUrl = lowerUrl.startsWith("file:");

  if (isFileUrl) {
    return {
      code: "FILE_URL_PERMISSION_REQUIRED",
      message: "Enable file URL access for Engram, then retry.",
      detail:
        "Open extension details for Engram and enable \"Allow access to file URLs\" for local files support.",
      badgeText: "FILE",
    };
  }

  return {
    code: "HOST_PERMISSION_REQUIRED",
    message: "Engram is missing site access permission for this tab.",
    detail:
      "Grant site access for this site (or all sites) in extension details, then retry the shortcut.",
    badgeText: "PERM",
  };
}

async function ensureHostPermissionForTab(url) {
  const originPattern = getOriginPermissionPattern(url);
  if (!originPattern) {
    return {
      granted: true,
      attempted: false,
      originPattern: null,
      error: null,
    };
  }

  if (
    !browser.permissions ||
    typeof browser.permissions.contains !== "function" ||
    typeof browser.permissions.request !== "function"
  ) {
    return {
      granted: true,
      attempted: false,
      originPattern,
      error: null,
    };
  }

  try {
    const contains = await browser.permissions.contains({ origins: [originPattern] });
    if (contains) {
      return {
        granted: true,
        attempted: false,
        originPattern,
        error: null,
      };
    }
  } catch (error) {
    // Continue and attempt a prompt if contains() is unavailable or blocked.
    console.debug("Engram permissions.contains failed:", error);
  }

  try {
    const granted = await browser.permissions.request({ origins: [originPattern] });
    return {
      granted,
      attempted: true,
      originPattern,
      error: null,
    };
  } catch (error) {
    return {
      granted: false,
      attempted: true,
      originPattern,
      error,
    };
  }
}

function getOriginPermissionPattern(url) {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}/*`;
    }
    if (parsed.protocol === "file:") {
      return "file:///*";
    }
  } catch {
    return null;
  }

  return null;
}

function buildPermissionRequestDetail(permissionState) {
  const pattern = permissionState?.originPattern ?? "this site";
  const requestError = permissionState?.error
    ? ` | requestError: ${normalizeError(permissionState.error)}`
    : "";
  return `Permission request for ${pattern} was denied or dismissed.${requestError}`;
}

async function sendToggleMessageToTab(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: MESSAGE_TOGGLE_SELECTION_MODE,
      source: MESSAGE_SOURCE,
    });
    return { success: true, error: null };
  } catch (error) {
    return { success: false, error };
  }
}

async function tryInjectContentScripts(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    if (typeof browser.scripting.insertCSS === "function") {
      await browser.scripting.insertCSS({
        target: { tabId },
        files: ["styles.css"],
      });
    }

    return { attempted: true, success: true, error: null };
  } catch (error) {
    return { attempted: true, success: false, error };
  }
}

function isNoReceiverError(error) {
  const text = normalizeError(error).toLowerCase();
  return (
    text.includes("receiving end does not exist") ||
    text.includes("could not establish connection")
  );
}

function isPermissionError(error) {
  const text = normalizeError(error).toLowerCase();
  return (
    text.includes("missing host permission") ||
    text.includes("extension manifest must request permission") ||
    text.includes("cannot access contents of the page")
  );
}

function buildErrorDetail(sendError, injectionError) {
  const parts = [];
  if (sendError) {
    parts.push(`sendMessage: ${normalizeError(sendError)}`);
  }
  if (injectionError) {
    parts.push(`injectScript: ${normalizeError(injectionError)}`);
  }
  return parts.join(" | ");
}

async function reportCommandSuccess({
  tabId = null,
  message,
  detail = null,
  url = null,
}) {
  const diagnostic = {
    timestamp: Date.now(),
    level: "success",
    code: "COMMAND_SENT",
    message,
    detail,
    url,
  };

  console.debug("Engram shortcut diagnostic:", diagnostic);
  await persistCommandDiagnostic(diagnostic);
  await clearTabBadge(tabId);
}

async function reportCommandFailure({
  tabId = null,
  code,
  message,
  detail = null,
  url = null,
  badgeText = "ERR",
}) {
  const diagnostic = {
    timestamp: Date.now(),
    level: "error",
    code,
    message,
    detail,
    url,
  };

  console.warn("Engram shortcut diagnostic:", diagnostic);
  await persistCommandDiagnostic(diagnostic);
  await showTabBadge(tabId, badgeText, message);
}

async function persistCommandDiagnostic(diagnostic) {
  try {
    await browser.storage.local.set({
      [COMMAND_DIAGNOSTIC_STORAGE_KEY]: diagnostic,
    });
  } catch (error) {
    console.debug("Engram could not persist diagnostic:", error);
  }
}

async function showTabBadge(tabId, text, message) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await browser.action.setBadgeBackgroundColor({
      tabId,
      color: "#d9534f",
    });
    await browser.action.setBadgeText({ tabId, text });
    await browser.action.setTitle({
      tabId,
      title: `Engram: ${message}`,
    });
  } catch (error) {
    console.debug("Engram could not show badge diagnostic:", error);
  }
}

async function clearTabBadge(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await browser.action.setBadgeText({ tabId, text: "" });
    await browser.action.setTitle({
      tabId,
      title: ACTION_DEFAULT_TITLE,
    });
  } catch (error) {
    console.debug("Engram could not clear badge diagnostic:", error);
  }
}

function normalizeError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return String(error);
}

async function getActiveTab() {
  try {
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    return activeTab ?? null;
  } catch (error) {
    console.debug("Engram could not query active tab:", error);
    return null;
  }
}

function canMessageTab(url) {
  if (typeof url !== "string" || url.length === 0) {
    return false;
  }

  const lowerUrl = url.toLowerCase();

  // Browsers block content scripts on internal/extension pages.
  for (const prefix of RESTRICTED_URL_PREFIXES) {
    if (lowerUrl.startsWith(prefix)) {
      return false;
    }
  }

  return true;
}
