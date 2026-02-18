if (typeof globalThis.browser === "undefined") { globalThis.browser = chrome; }

const MESSAGE_TOGGLE_SELECTION_MODE = "swift-read:toggle-selection-mode";
const MESSAGE_SOURCE = "swift-read-background";
const HOVER_CLASS = "swift-read-hover";
const SELECTED_CLASS = "swift-read-selected";
const SELECTION_INDICATOR_ID = "swift-read-selection-indicator";
const OVERLAY_ID = "swift-read-overlay";
const WORD_DISPLAY_ID = "swift-read-word-display";
const PIVOT_CLASS = "pivot-char";
const UPWARD_EXPANSION_ID = "swift-read-upward-expansion";
const READABLE_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, ul, ol, span";
const NON_SPAN_READABLE_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, ul, ol";
const AUTO_CONTINUE_READABLE_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, span";
const AUTO_CONTINUE_NON_SPAN_READABLE_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6";
const READABLE_BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "UL",
  "OL",
  "SPAN",
]);
const HEADER_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const SEMANTIC_BLOCK_TYPE = Object.freeze({
  HEADER: "header",
  PARAGRAPH: "paragraph",
  MEDIA_STOP: "media-stop",
});
const UPWARD_STREAM_ITEM_KIND = Object.freeze({
  HISTORY_TEXT: "history-text",
  CHECKPOINT: "checkpoint",
  MEDIA: "media",
  LIST: "list",
  TABLE: "table",
  CODE: "code",
});
const MAX_RECENT_HISTORY_ITEMS = 14;
const MAX_CHECKPOINT_HISTORY_ITEMS = 8;
const RULE_B_STOP_TAG_SELECTOR = "img, table, pre, code, ul, ol";
const RULE_B_STOP_KIND = Object.freeze({
  MEDIA: "media",
  LIST: "list",
  TABLE: "table",
  CODE: "code",
});
const LIST_TAGS = new Set(["UL", "OL", "LI"]);
const RULE_B_STOP_TAGS = new Set(["IMG", "TABLE", "PRE", "CODE", "UL", "OL"]);

const READER_STATE = Object.freeze({
  IDLE: "Idle",
  SELECTING: "Selecting",
  READING: "Reading",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [READER_STATE.IDLE]: new Set([READER_STATE.SELECTING, READER_STATE.READING]),
  [READER_STATE.SELECTING]: new Set([READER_STATE.IDLE, READER_STATE.READING]),
  [READER_STATE.READING]: new Set([READER_STATE.IDLE]),
});

const DEFAULT_SETTINGS = Object.freeze({
  wpm: 300,
  autoContinue: false,
  stopBeforeHeader: true,
  stopBeforeMedia: true,
});

const MIN_WPM = 100;
const MAX_WPM = 1200;

let currentState = READER_STATE.IDLE;
let settings = { ...DEFAULT_SETTINGS };
let selectedParagraphs = [];
let selectedParagraphSet = new Set();
let readingSession = null;
let isSelectionListenersAttached = false;
let isReadingKeyListenerAttached = false;
let hoveredParagraph = null;
let isShiftPressed = false;
const stopElementIdentityMap = new WeakMap();
let stopElementIdentityCounter = 0;

void initialize();

async function initialize() {
  settings = await loadSettings();

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== MESSAGE_TOGGLE_SELECTION_MODE) {
      return undefined;
    }

    // Ignore unexpected cross-extension messages with the same shape.
    if (typeof message.source === "string" && message.source !== MESSAGE_SOURCE) {
      return undefined;
    }

    handleToggleSelectionCommand(message);
    return undefined;
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    applySettingsChanges(changes);
  });
}

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get([
      "defaultWpm",
      "autoContinue",
      "stopBeforeHeader",
      "stopBeforeMedia",
    ]);
    return {
      wpm: normalizeWpm(stored.defaultWpm),
      autoContinue:
        typeof stored.autoContinue === "boolean"
          ? stored.autoContinue
          : DEFAULT_SETTINGS.autoContinue,
      stopBeforeHeader:
        typeof stored.stopBeforeHeader === "boolean"
          ? stored.stopBeforeHeader
          : DEFAULT_SETTINGS.stopBeforeHeader,
      stopBeforeMedia:
        typeof stored.stopBeforeMedia === "boolean"
          ? stored.stopBeforeMedia
          : DEFAULT_SETTINGS.stopBeforeMedia,
    };
  } catch (error) {
    console.debug("Engram settings fallback:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

function handleToggleSelectionCommand(message) {
  if (currentState !== READER_STATE.IDLE) {
    // Command acts as a close/cancel while selecting or reading.
    transitionTo(READER_STATE.IDLE, { reason: "toggle-selection-command" });
    return;
  }

  transitionTo(READER_STATE.SELECTING, { reason: "toggle-selection-command" });
}

function transitionTo(nextState, context = {}) {
  if (nextState === currentState) {
    return true;
  }

  if (!isTransitionAllowed(currentState, nextState)) {
    console.debug("Engram blocked invalid transition:", {
      from: currentState,
      to: nextState,
      context,
    });
    return false;
  }

  const lifecycleContext = {
    ...context,
    fromState: currentState,
    toState: nextState,
  };

  runExitHook(currentState, lifecycleContext);
  currentState = nextState;
  runEnterHook(nextState, lifecycleContext);
  return true;
}

function isTransitionAllowed(fromState, toState) {
  const allowed = ALLOWED_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

function runEnterHook(state, context) {
  if (state === READER_STATE.SELECTING) {
    onEnterSelecting(context);
    return;
  }

  if (state === READER_STATE.READING) {
    onEnterReading(context);
  }
}

function runExitHook(state, context) {
  if (state === READER_STATE.SELECTING) {
    onExitSelecting(context);
    return;
  }

  if (state === READER_STATE.READING) {
    onExitReading(context);
  }
}

function onEnterSelecting() {
  selectedParagraphs = [];
  selectedParagraphSet.clear();
  isShiftPressed = false;
  mountSelectionModeIndicator();
  attachSelectionModeListeners();
}

function onExitSelecting(context) {
  detachSelectionModeListeners();
  unmountSelectionModeIndicator();
  clearSelectionArtifacts();

  if (context.toState !== READER_STATE.READING) {
    selectedParagraphs = [];
    selectedParagraphSet.clear();
  }
}

function onEnterReading(context) {
  const readingData = context.readingData ?? null;
  const initialWpm = normalizeWpm(settings.wpm);

  readingSession = {
    startedAt: Date.now(),
    source: context.reason ?? "unknown",
    paragraphs: readingData?.paragraphs ?? [],
    paragraphTexts: readingData?.paragraphTexts ?? [],
    semanticBlocks: readingData?.semanticBlocks ?? [],
    fullText: readingData?.combinedText ?? "",
    words: readingData?.words ?? [],
    initialWordsCount: readingData?.words?.length ?? 0,
    autoContinueStarted: false,
    currentIndex: context.initialWordIndex ?? 0,
    currentWpm: initialWpm,
    isPlaying: true,
    upwardExpansionOpen: false,
    currentBlockCollapsed: false,
    imagePreviewOpen: false,
    blockedHeaderBoundaryIndex: null,
    releasedHeaderBoundaryIndex: null,
    pendingRuleBStop: null,
    releasedRuleBBoundarySignature: null,
    releasedRuleBStopElement: null,
    resumeFromAcknowledgedListStop: false,
    checkpointHistory: [],
    lastUpwardStreamSignature: null,
    timerId: null,
    nextTickAt: null,
    lastSelectedParagraph: readingData?.lastParagraph ?? null,
    overlayRoot: null,
    ui: null,
  };

  attachReadingKeyboardListener();
  mountReadingUi();
}

function onExitReading() {
  clearReadingTimer();
  detachReadingKeyboardListener();
  unmountReadingUi();
  readingSession = null;
  selectedParagraphs = [];
  selectedParagraphSet.clear();
  isShiftPressed = false;
}

function normalizeWpm(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SETTINGS.wpm;
  }
  return Math.min(MAX_WPM, Math.max(MIN_WPM, parsed));
}

function applySettingsChanges(changes) {
  if (!changes || typeof changes !== "object") {
    return;
  }

  if ("defaultWpm" in changes) {
    settings.wpm = normalizeWpm(changes.defaultWpm.newValue);
  }

  if ("autoContinue" in changes) {
    settings.autoContinue =
      typeof changes.autoContinue.newValue === "boolean"
        ? changes.autoContinue.newValue
        : DEFAULT_SETTINGS.autoContinue;
  }

  if ("stopBeforeHeader" in changes) {
    settings.stopBeforeHeader =
      typeof changes.stopBeforeHeader.newValue === "boolean"
        ? changes.stopBeforeHeader.newValue
        : DEFAULT_SETTINGS.stopBeforeHeader;
  }

  if ("stopBeforeMedia" in changes) {
    settings.stopBeforeMedia =
      typeof changes.stopBeforeMedia.newValue === "boolean"
        ? changes.stopBeforeMedia.newValue
        : DEFAULT_SETTINGS.stopBeforeMedia;
  }
}

function attachSelectionModeListeners() {
  if (isSelectionListenersAttached) {
    return;
  }

  document.addEventListener("mouseover", handleSelectionMouseOver, true);
  document.addEventListener("mouseout", handleSelectionMouseOut, true);
  document.addEventListener("click", handleSelectionClick, true);
  document.addEventListener("keydown", handleSelectionKeyDown, true);
  document.addEventListener("keyup", handleSelectionKeyUp, true);
  isSelectionListenersAttached = true;
}

function attachReadingKeyboardListener() {
  if (isReadingKeyListenerAttached) {
    return;
  }

  document.addEventListener("keydown", handleReadingKeyDown, true);
  isReadingKeyListenerAttached = true;
}

function detachReadingKeyboardListener() {
  if (!isReadingKeyListenerAttached) {
    return;
  }

  document.removeEventListener("keydown", handleReadingKeyDown, true);
  isReadingKeyListenerAttached = false;
}

function detachSelectionModeListeners() {
  if (!isSelectionListenersAttached) {
    return;
  }

  document.removeEventListener("mouseover", handleSelectionMouseOver, true);
  document.removeEventListener("mouseout", handleSelectionMouseOut, true);
  document.removeEventListener("click", handleSelectionClick, true);
  document.removeEventListener("keydown", handleSelectionKeyDown, true);
  document.removeEventListener("keyup", handleSelectionKeyUp, true);
  isSelectionListenersAttached = false;
  hoveredParagraph = null;
  isShiftPressed = false;
}

function clearSelectionArtifacts() {
  for (const paragraph of document.querySelectorAll(`.${HOVER_CLASS}`)) {
    paragraph.classList.remove(HOVER_CLASS);
  }

  for (const paragraph of document.querySelectorAll(`.${SELECTED_CLASS}`)) {
    paragraph.classList.remove(SELECTED_CLASS);
  }

  hoveredParagraph = null;
}

function mountSelectionModeIndicator() {
  unmountSelectionModeIndicator();

  const indicator = document.createElement("div");
  indicator.id = SELECTION_INDICATOR_ID;
  indicator.textContent = "Selection Mode On";
  indicator.setAttribute("role", "status");
  indicator.setAttribute("aria-live", "polite");

  const mountTarget = document.body ?? document.documentElement;
  mountTarget.appendChild(indicator);
}

function unmountSelectionModeIndicator() {
  const existing = document.getElementById(SELECTION_INDICATOR_ID);
  if (existing) {
    existing.remove();
  }
}

function mountReadingUi() {
  if (!readingSession || !Array.isArray(readingSession.words) || readingSession.words.length === 0) {
    stopReading();
    return;
  }

  unmountReadingUi();

  const overlayRoot = document.createElement("div");
  overlayRoot.id = OVERLAY_ID;
  overlayRoot.tabIndex = -1;
  overlayRoot.setAttribute("role", "dialog");
  overlayRoot.setAttribute("aria-modal", "true");
  overlayRoot.setAttribute("aria-label", "Engram reader");

  const modalShell = document.createElement("div");
  modalShell.className = "swift-read-modal-shell";

  const upwardExpansion = document.createElement("section");
  upwardExpansion.id = UPWARD_EXPANSION_ID;
  upwardExpansion.className = "swift-read-upward-expansion";
  upwardExpansion.setAttribute("aria-hidden", "true");

  const upwardExpansionStream = document.createElement("div");
  upwardExpansionStream.className = "swift-read-upward-stream";
  upwardExpansionStream.setAttribute("role", "region");
  upwardExpansionStream.setAttribute("aria-label", "Engram upward stream");

  upwardExpansion.append(upwardExpansionStream);

  const panel = document.createElement("div");
  panel.className = "swift-read-panel";

  const upwardToggleButton = document.createElement("button");
  upwardToggleButton.type = "button";
  upwardToggleButton.className = "swift-read-upward-toggle";
  upwardToggleButton.textContent = "▴";
  upwardToggleButton.setAttribute("aria-label", "Toggle upward stream");
  upwardToggleButton.setAttribute("aria-controls", UPWARD_EXPANSION_ID);
  upwardToggleButton.setAttribute("aria-expanded", "false");

  const wordDisplay = document.createElement("div");
  wordDisplay.id = WORD_DISPLAY_ID;

  const controls = document.createElement("div");
  controls.className = "swift-read-controls";

  const playPauseButton = document.createElement("button");
  playPauseButton.type = "button";
  playPauseButton.className = "swift-read-control-button";
  playPauseButton.id = "swift-read-play-pause";

  const rewindButton = document.createElement("button");
  rewindButton.type = "button";
  rewindButton.className = "swift-read-control-button";
  rewindButton.id = "swift-read-rewind";
  rewindButton.textContent = "Rewind 10";

  const speedControl = document.createElement("label");
  speedControl.className = "swift-read-speed-control";
  speedControl.htmlFor = "swift-read-wpm-slider";

  const speedLabel = document.createElement("span");
  speedLabel.className = "swift-read-speed-label";
  speedLabel.textContent = "WPM";

  const wpmSlider = document.createElement("input");
  wpmSlider.id = "swift-read-wpm-slider";
  wpmSlider.type = "range";
  wpmSlider.min = String(MIN_WPM);
  wpmSlider.max = String(MAX_WPM);
  wpmSlider.step = "10";

  const wpmValue = document.createElement("span");
  wpmValue.id = "swift-read-wpm-value";

  const progressWrap = document.createElement("div");
  progressWrap.className = "swift-read-progress-wrap";

  const progressBar = document.createElement("input");
  progressBar.id = "swift-read-progress";
  progressBar.type = "range";
  progressBar.min = "0";
  progressBar.step = "1";

  const progressText = document.createElement("span");
  progressText.id = "swift-read-progress-text";

  const autoContinueNote = document.createElement("span");
  autoContinueNote.id = "swift-read-auto-continue-note";
  autoContinueNote.textContent = "Auto-continue is on";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "swift-read-control-button swift-read-close-button";
  closeButton.id = "swift-read-close";
  closeButton.textContent = "Close";

  speedControl.append(speedLabel, wpmSlider, wpmValue);
  progressWrap.append(progressBar, progressText, autoContinueNote);
  controls.append(playPauseButton, rewindButton, speedControl, progressWrap, closeButton);
  panel.append(upwardToggleButton, wordDisplay, controls);
  modalShell.append(upwardExpansion, panel);
  overlayRoot.append(modalShell);

  upwardExpansionStream.addEventListener("click", handleUpwardStreamClick);
  playPauseButton.addEventListener("click", handlePlayPauseClick);
  rewindButton.addEventListener("click", handleRewindClick);
  wpmSlider.addEventListener("input", handleWpmInput);
  progressBar.addEventListener("input", handleProgressInput);
  progressBar.addEventListener("change", handleProgressInput);
  upwardToggleButton.addEventListener("click", handleUpwardToggleClick);
  closeButton.addEventListener("click", handleCloseReadingClick);

  const mountTarget = document.body ?? document.documentElement;
  mountTarget.appendChild(overlayRoot);

  readingSession.overlayRoot = overlayRoot;
  readingSession.ui = {
    modalShell,
    upwardExpansion,
    upwardExpansionStream,
    upwardToggleButton,
    imagePreviewOverlay: null,
    wordDisplay,
    playPauseButton,
    rewindButton,
    wpmSlider,
    wpmValue,
    progressWrap,
    progressBar,
    progressText,
    autoContinueNote,
    closeButton,
  };

  syncWpmUi();
  renderCurrentWord();
  updateProgressUi();
  updatePlayPauseUi();
  syncUpwardStreamUi();
  syncUpwardExpansionUi();
  if (!maybeActivateInitialRuleBStop()) {
    startRsvpPlayback();
  }

  focusReadingOverlay();
}

function unmountReadingUi() {
  if (!readingSession?.overlayRoot) {
    return;
  }

  closeImagePreviewModal();
  readingSession.overlayRoot.remove();
  readingSession.overlayRoot = null;
  readingSession.ui = null;
}

function focusReadingOverlay() {
  const overlayRoot = readingSession?.overlayRoot;
  if (!(overlayRoot instanceof HTMLElement)) {
    return;
  }

  requestAnimationFrame(() => {
    if (!overlayRoot.isConnected) {
      return;
    }

    overlayRoot.focus();
  });
}

async function startReadingFromSelection() {
  if (currentState !== READER_STATE.SELECTING || selectedParagraphs.length === 0) {
    return false;
  }

  // Ensure we respect the latest popup settings at the moment reading starts.
  settings = await loadSettings();

  const readingData = buildReadingDataFromSelection(selectedParagraphs);
  if (!readingData) {
    return false;
  }

  return transitionTo(READER_STATE.READING, {
    reason: "selection-confirmed",
    readingData,
  });
}

function stopReading() {
  transitionTo(READER_STATE.IDLE, { reason: "reading-stopped" });
}

function handlePlayPauseClick() {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  if (isAnyStopActive()) {
    return;
  }

  if (readingSession.isPlaying) {
    readingSession.isPlaying = false;
    updatePlayPauseUi();
    pauseRsvpPlayback();
    return;
  }

  readingSession.isPlaying = true;
  updatePlayPauseUi();
  renderCurrentWord();
  startRsvpPlayback();
}

function acknowledgeAndResumeFromStop() {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  if (!isAnyStopActive()) {
    return;
  }

  // Phase 1: Release stops
  if (readingSession.blockedHeaderBoundaryIndex === readingSession.currentIndex) {
    readingSession.releasedHeaderBoundaryIndex = readingSession.currentIndex;
  }

  if (isRuleBStopActive() && !acknowledgePendingRuleBStop()) {
    return;
  }

  // Phase 1 visual: Re-render to hide stop display and show the ORP word
  renderCurrentWord();
  updatePlayPauseUi();

  // Phase 2: Resume playback
  readingSession.isPlaying = true;
  updatePlayPauseUi();

  if (readingSession.resumeFromAcknowledgedListStop) {
    readingSession.resumeFromAcknowledgedListStop = false;
    onPlaybackTick(Date.now());
    return;
  }

  startRsvpPlayback();
}

function handleRewindClick() {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  readingSession.currentIndex = Math.max(0, readingSession.currentIndex - 10);
  renderCurrentWord();
  updateProgressUi();

  if (readingSession.isPlaying) {
    restartPlaybackTimerFromNow();
  }
}

function handleWpmInput(event) {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  readingSession.currentWpm = normalizeWpm(input.value);
  syncWpmUi();

  if (readingSession.isPlaying) {
    restartPlaybackTimerFromNow();
  }
}

function handleCloseReadingClick() {
  stopReading();
}

function handleUpwardToggleClick() {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  setUpwardExpansionOpen(!readingSession.upwardExpansionOpen);
}

function handleUpwardStreamClick(event) {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const image = target.closest(".swift-read-upward-previewable-image");
  if (!(image instanceof HTMLImageElement)) {
    return;
  }

  // Prefer the raw attribute value to preserve encoded data-URI characters (e.g. %23 in SVG).
  const source = image.getAttribute("src") || image.currentSrc || image.src;
  if (!source) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  openImagePreviewModal(image);
}

function openImagePreviewModal(sourceImage) {
  if (!(sourceImage instanceof HTMLImageElement)) {
    return;
  }

  if (!readingSession?.overlayRoot || !readingSession.ui) {
    return;
  }

  closeImagePreviewModal();

  const previewOverlay = document.createElement("div");
  previewOverlay.className = "swift-read-image-preview-overlay";
  previewOverlay.setAttribute("role", "dialog");
  previewOverlay.setAttribute("aria-modal", "true");
  previewOverlay.setAttribute("aria-label", "Image preview");

  const previewShell = document.createElement("div");
  previewShell.className = "swift-read-image-preview-shell";

  const previewViewport = document.createElement("div");
  previewViewport.className = "swift-read-image-preview-viewport";

  const previewVisual = createImagePreviewVisual(sourceImage);

  previewViewport.append(previewVisual.node);
  previewShell.append(previewViewport);
  previewOverlay.append(previewShell);
  previewOverlay.addEventListener("click", (event) => {
    if (event.target === previewOverlay) {
      closeImagePreviewModal();
    }
  });

  readingSession.overlayRoot.append(previewOverlay);
  readingSession.ui.imagePreviewOverlay = previewOverlay;
  readingSession.imagePreviewOpen = true;
}

function createImagePreviewVisual(sourceImage) {
  const previewImage = document.createElement("img");
  previewImage.className = "swift-read-image-preview-image";
  const previewSource = sourceImage.getAttribute("src") || sourceImage.currentSrc || sourceImage.src;
  if (previewSource) {
    previewImage.src = previewSource;
  }
  previewImage.alt = sourceImage.alt || "Preview image";
  previewImage.loading = "eager";
  previewImage.decoding = "sync";
  previewImage.addEventListener("error", () => {
    const fallbackVisual = createCanvasPreviewVisual(sourceImage);
    if (fallbackVisual) {
      previewImage.replaceWith(fallbackVisual.node);
      return;
    }

    previewImage.replaceWith(createImagePreviewErrorMessage());
  });
  return {
    node: previewImage,
  };
}

function createCanvasPreviewVisual(sourceImage) {
  const naturalWidth = sourceImage.naturalWidth;
  const naturalHeight = sourceImage.naturalHeight;
  if (!(naturalWidth > 0 && naturalHeight > 0)) {
    return null;
  }

  const previewCanvas = document.createElement("canvas");
  previewCanvas.className = "swift-read-image-preview-canvas";
  previewCanvas.width = naturalWidth;
  previewCanvas.height = naturalHeight;

  const context = previewCanvas.getContext("2d");
  if (!context) {
    return null;
  }

  try {
    context.drawImage(sourceImage, 0, 0, naturalWidth, naturalHeight);
  } catch (error) {
    console.debug("Engram preview canvas render failed:", error);
    return null;
  }

  return {
    node: previewCanvas,
  };
}

function createImagePreviewErrorMessage() {
  const message = document.createElement("div");
  message.className = "swift-read-image-preview-error";
  message.textContent = "Image failed to render in preview.";
  return message;
}

function closeImagePreviewModal() {
  if (!readingSession?.ui?.imagePreviewOverlay) {
    if (readingSession?.ui) {
      readingSession.imagePreviewOpen = false;
    }
    return;
  }

  readingSession.ui.imagePreviewOverlay.remove();
  readingSession.ui.imagePreviewOverlay = null;
  readingSession.imagePreviewOpen = false;
  focusReadingOverlay();
}

function handleReadingKeyDown(event) {
  if (currentState !== READER_STATE.READING) {
    return;
  }

  if (readingSession?.imagePreviewOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeImagePreviewModal();
    }
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    stopReading();
    return;
  }

  if (isAnyStopActive()) {
    if (isEnterActivationKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      acknowledgeAndResumeFromStop();
    }
    return;
  }

  if (isSpaceToggleKey(event)) {
    event.preventDefault();
    event.stopPropagation();
    handlePlayPauseClick();
    return;
  }
}

function isSpaceToggleKey(event) {
  if (!(event instanceof KeyboardEvent)) {
    return false;
  }

  return (
    event.key === " " ||
    event.key === "Spacebar" ||
    event.key === "Space" ||
    event.code === "Space" ||
    event.keyCode === 32 ||
    event.which === 32
  );
}

function isEnterActivationKey(event) {
  if (!(event instanceof KeyboardEvent)) {
    return false;
  }

  return (
    event.key === "Enter" ||
    event.key === "Return" ||
    event.code === "Enter" ||
    event.code === "NumpadEnter" ||
    event.keyCode === 13 ||
    event.which === 13
  );
}

function syncWpmUi() {
  if (!readingSession?.ui) {
    return;
  }

  const wpm = normalizeWpm(readingSession.currentWpm);
  readingSession.currentWpm = wpm;
  readingSession.ui.wpmSlider.value = String(wpm);
  readingSession.ui.wpmValue.textContent = `${wpm} WPM`;
}

function renderCurrentWord() {
  if (!readingSession?.ui) {
    return;
  }

  const ruleBStopPreview = getRuleBStopPreview();
  if (ruleBStopPreview) {
    renderRuleBStopInWordDisplay(ruleBStopPreview);
    syncUpwardStreamUi();
    return;
  }

  const headerBoundaryPreview = getHeaderBoundaryPreview();
  if (headerBoundaryPreview) {
    readingSession.ui.wordDisplay.classList.remove("swift-read-word-display-rule-b-stop");
    readingSession.ui.wordDisplay.classList.add("swift-read-word-display-header-stop");
    readingSession.ui.wordDisplay.style.setProperty(
      "--swift-read-header-preview-size",
      `${getHeaderPreviewFontSizePx(headerBoundaryPreview.headerText)}px`,
    );
    readingSession.ui.wordDisplay.innerHTML = createHeaderBoundaryMarkup(
      headerBoundaryPreview.headerText,
    );
    syncUpwardStreamUi();
    return;
  }

  readingSession.ui.wordDisplay.classList.remove("swift-read-word-display-rule-b-stop");
  readingSession.ui.wordDisplay.classList.remove("swift-read-word-display-header-stop");
  readingSession.ui.wordDisplay.style.removeProperty("--swift-read-header-preview-size");

  const words = readingSession.words;
  if (!Array.isArray(words) || words.length === 0) {
    readingSession.ui.wordDisplay.textContent = "";
    syncUpwardStreamUi();
    return;
  }

  readingSession.currentIndex = Math.min(
    words.length - 1,
    Math.max(0, readingSession.currentIndex),
  );

  const word = words[readingSession.currentIndex] ?? "";
  readingSession.ui.wordDisplay.innerHTML = createOrpMarkup(word);
  syncUpwardStreamUi();
}

function getRuleBStopPreview() {
  if (!readingSession || readingSession.isPlaying || !readingSession.pendingRuleBStop) {
    return null;
  }

  return readingSession.pendingRuleBStop;
}

function renderRuleBStopInWordDisplay(stopEntry) {
  if (!readingSession?.ui?.wordDisplay || !stopEntry || typeof stopEntry !== "object") {
    return;
  }

  const wordDisplay = readingSession.ui.wordDisplay;
  wordDisplay.classList.remove("swift-read-word-display-header-stop");
  wordDisplay.classList.add("swift-read-word-display-rule-b-stop");
  wordDisplay.style.removeProperty("--swift-read-header-preview-size");
  wordDisplay.replaceChildren();

  const note = document.createElement("span");
  note.className = "swift-read-rule-b-stop-note";
  note.textContent = `${stopEntry.title ?? "Checkpoint"} • Press Enter to continue`;

  const body = createRuleBStopWordDisplayBody(stopEntry);
  wordDisplay.append(note, body);
}

function createRuleBStopWordDisplayBody(stopEntry) {
  if (!stopEntry || typeof stopEntry !== "object") {
    const fallback = document.createElement("p");
    fallback.className = "swift-read-rule-b-stop-text";
    fallback.textContent = "Checkpoint";
    return fallback;
  }

  if (stopEntry.kind === RULE_B_STOP_KIND.MEDIA && stopEntry.imageSource) {
    const image = document.createElement("img");
    image.className = "swift-read-rule-b-stop-image";
    image.src = stopEntry.imageSource;
    image.alt = stopEntry.imageAlt || "Checkpoint image";
    image.setAttribute("loading", "eager");
    image.setAttribute("decoding", "sync");
    return image;
  }

  if (stopEntry.kind === RULE_B_STOP_KIND.TABLE) {
    const tablePreview = createRuleBWordDisplayTable(stopEntry.anchorElement);
    if (tablePreview) {
      return tablePreview;
    }
  }

  if (stopEntry.kind === RULE_B_STOP_KIND.LIST) {
    const listPreview = createRuleBWordDisplayList(stopEntry.anchorElement);
    if (listPreview) {
      return listPreview;
    }
  }

  if (stopEntry.kind === RULE_B_STOP_KIND.CODE) {
    const codePreview = document.createElement("pre");
    codePreview.className = "swift-read-rule-b-stop-code";
    const sourceText = truncateForCheckpointPreview(
      stopEntry.anchorElement?.textContent || stopEntry.previewText || "",
      1200,
    );
    codePreview.textContent = sourceText || "Code checkpoint.";
    return codePreview;
  }

  const textPreview = document.createElement("p");
  textPreview.className = "swift-read-rule-b-stop-text";
  textPreview.textContent = stopEntry.previewText || "Checkpoint";
  return textPreview;
}

function createRuleBWordDisplayTable(anchorElement) {
  if (!(anchorElement instanceof HTMLTableElement)) {
    return null;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "swift-read-rule-b-stop-table-wrap";

  const table = document.createElement("table");
  table.className = "swift-read-rule-b-stop-table";

  const maxRows = 6;
  const maxCols = 6;
  const sourceRows = Array.from(anchorElement.rows);
  const rowsToRender = sourceRows.slice(0, maxRows);

  for (const sourceRow of rowsToRender) {
    const row = document.createElement("tr");
    const sourceCells = Array.from(sourceRow.cells);
    const cellsToRender = sourceCells.slice(0, maxCols);

    for (const sourceCell of cellsToRender) {
      const cellTag = sourceCell.tagName === "TH" ? "th" : "td";
      const cell = document.createElement(cellTag);
      cell.textContent = truncateForCheckpointPreview(sourceCell.textContent || "", 90);
      if (sourceCell.colSpan > 1) {
        cell.colSpan = sourceCell.colSpan;
      }
      if (sourceCell.rowSpan > 1) {
        cell.rowSpan = sourceCell.rowSpan;
      }
      row.append(cell);
    }

    if (sourceCells.length > maxCols) {
      const overflowCell = document.createElement("td");
      overflowCell.textContent = "…";
      row.append(overflowCell);
    }

    table.append(row);
  }

  if (sourceRows.length > maxRows) {
    const overflowRow = document.createElement("tr");
    const overflowCell = document.createElement("td");
    overflowCell.colSpan = maxCols;
    overflowCell.textContent = "…";
    overflowRow.append(overflowCell);
    table.append(overflowRow);
  }

  wrapper.append(table);
  return wrapper;
}

function createRuleBWordDisplayList(anchorElement) {
  if (!(anchorElement instanceof Element)) {
    return null;
  }

  const listTag = anchorElement.tagName === "OL" ? "ol" : "ul";
  const list = document.createElement(listTag);
  list.className = "swift-read-rule-b-stop-list";

  const listItems = collectRuleBListItems(anchorElement, 6);
  if (listItems.length === 0) {
    return null;
  }

  for (const itemText of listItems) {
    const item = document.createElement("li");
    item.textContent = itemText;
    list.append(item);
  }

  return list;
}

function collectRuleBListItems(anchorElement, maxItems = 6) {
  if (!(anchorElement instanceof Element)) {
    return [];
  }

  if (anchorElement.tagName === "LI") {
    const liText = sanitizeText(anchorElement.textContent || "");
    return liText ? [truncateForCheckpointPreview(liText, 220)] : [];
  }

  if (anchorElement.tagName !== "UL" && anchorElement.tagName !== "OL") {
    return [];
  }

  const items = [];
  for (const child of Array.from(anchorElement.children)) {
    if (!(child instanceof Element) || child.tagName !== "LI") {
      continue;
    }

    const text = sanitizeText(child.textContent || "");
    if (!text) {
      continue;
    }

    items.push(truncateForCheckpointPreview(text, 220));
    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

function isHeaderBoundaryStopActive() {
  return Boolean(getHeaderBoundaryPreview());
}

function isRuleBStopActive() {
  return Boolean(readingSession && !readingSession.isPlaying && readingSession.pendingRuleBStop);
}

function isAnyStopActive() {
  return isHeaderBoundaryStopActive() || isRuleBStopActive();
}

function acknowledgePendingRuleBStop() {
  if (!readingSession || !readingSession.pendingRuleBStop) {
    return true;
  }

  const pendingStop = readingSession.pendingRuleBStop;
  pushCheckpointHistoryEntry({
    ...pendingStop,
    pending: false,
  });

  if (pendingStop.source === "semantic-boundary" && pendingStop.signature) {
    readingSession.releasedRuleBBoundarySignature = pendingStop.signature;
  }

  if (pendingStop.source === "auto-continue" && pendingStop.anchorElement instanceof Element) {
    readingSession.releasedRuleBStopElement = pendingStop.anchorElement;
  }

  const skippedListWords = maybeSkipListStreamWordsAfterCheckpoint(pendingStop);
  readingSession.resumeFromAcknowledgedListStop = skippedListWords;
  if (skippedListWords) {
    updateProgressUi();
  }

  readingSession.pendingRuleBStop = null;
  syncUpwardStreamUi();
  return true;
}

function maybeSkipListStreamWordsAfterCheckpoint(stopEntry) {
  if (
    !readingSession ||
    !stopEntry ||
    stopEntry.kind !== RULE_B_STOP_KIND.LIST ||
    stopEntry.source !== "semantic-boundary"
  ) {
    return false;
  }

  const skipRange = findSemanticListSkipRangeForCheckpoint(stopEntry);
  if (!skipRange) {
    return false;
  }

  const totalWords = Array.isArray(readingSession.words) ? readingSession.words.length : 0;
  if (totalWords === 0) {
    return false;
  }

  const endWordIndex = Number(skipRange.endWordIndex);
  if (!Number.isFinite(endWordIndex) || endWordIndex < readingSession.currentIndex) {
    return false;
  }

  readingSession.currentIndex = Math.min(totalWords - 1, endWordIndex);
  return true;
}

function findSemanticListSkipRangeForCheckpoint(stopEntry) {
  if (!readingSession || !Array.isArray(readingSession.semanticBlocks)) {
    return null;
  }

  const semanticBlocks = readingSession.semanticBlocks;
  const currentWordIndex = Number(readingSession.currentIndex);
  const anchorElement = stopEntry.anchorElement instanceof Element ? stopEntry.anchorElement : null;

  let startBlockIndex = -1;
  if (anchorElement) {
    for (let index = 0; index < semanticBlocks.length; index += 1) {
      const block = semanticBlocks[index];
      if (
        isSemanticListBlock(block) &&
        isSemanticBlockWithinCheckpointAnchor(block, anchorElement)
      ) {
        startBlockIndex = index;
        break;
      }
    }
  }

  if (startBlockIndex < 0) {
    for (let index = 0; index < semanticBlocks.length; index += 1) {
      const block = semanticBlocks[index];
      if (!isSemanticListBlock(block)) {
        continue;
      }

      const blockStartWordIndex = Number(block.startWordIndex);
      if (!Number.isFinite(blockStartWordIndex) || blockStartWordIndex < currentWordIndex) {
        continue;
      }

      startBlockIndex = index;
      break;
    }
  }

  if (startBlockIndex < 0) {
    return null;
  }

  let endBlockIndex = startBlockIndex;
  for (let index = startBlockIndex + 1; index < semanticBlocks.length; index += 1) {
    if (!isSemanticListBlock(semanticBlocks[index])) {
      break;
    }
    endBlockIndex = index;
  }

  const endBlock = semanticBlocks[endBlockIndex];
  const endWordIndex = Number(endBlock?.endWordIndex);
  if (!Number.isFinite(endWordIndex)) {
    return null;
  }

  return {
    endWordIndex,
  };
}

function isSemanticListBlock(block) {
  if (!block || typeof block !== "object") {
    return false;
  }

  return getRuleBKindForTagName(block.tagName) === RULE_B_STOP_KIND.LIST;
}

function isSemanticBlockWithinCheckpointAnchor(block, anchorElement) {
  if (!block || typeof block !== "object" || !(anchorElement instanceof Element)) {
    return false;
  }

  if (!(block.element instanceof Element)) {
    return false;
  }

  return (
    block.element === anchorElement ||
    anchorElement.contains(block.element) ||
    block.element.contains(anchorElement)
  );
}

function pushCheckpointHistoryEntry(entry) {
  if (!readingSession || !entry || typeof entry !== "object") {
    return;
  }

  const history = Array.isArray(readingSession.checkpointHistory)
    ? readingSession.checkpointHistory
    : [];
  const nextEntry = {
    ...entry,
    pending: false,
    acknowledgedAt: Date.now(),
  };

  const lastEntry = history[history.length - 1] ?? null;
  if (lastEntry?.signature && nextEntry.signature && lastEntry.signature === nextEntry.signature) {
    readingSession.checkpointHistory = history;
    return;
  }

  history.push(nextEntry);
  if (history.length > MAX_CHECKPOINT_HISTORY_ITEMS) {
    history.splice(0, history.length - MAX_CHECKPOINT_HISTORY_ITEMS);
  }
  readingSession.checkpointHistory = history;
}

function getHeaderBoundaryPreview() {
  if (!readingSession || readingSession.isPlaying) {
    return null;
  }

  const boundaryIndex = Number(readingSession.blockedHeaderBoundaryIndex);
  if (!Number.isFinite(boundaryIndex) || boundaryIndex !== readingSession.currentIndex) {
    return null;
  }

  const boundary = findUpcomingHeaderBoundary(boundaryIndex);
  if (!boundary?.nextHeaderBlock) {
    return null;
  }

  return {
    boundaryIndex,
    headerText: sanitizeText(
      boundary.nextHeaderBlock.text ??
        boundary.nextHeaderBlock.element?.innerText ??
        boundary.nextHeaderBlock.element?.textContent ??
        "",
    ),
  };
}

function createHeaderBoundaryMarkup(headerText) {
  const safeHeaderText = sanitizeText(headerText) || "Next section";
  return `
    <span class="swift-read-header-stop-note">Next Chapter, press Enter to continue</span>
    <span class="swift-read-header-stop-text">${escapeHtml(safeHeaderText)}</span>
  `;
}

function getHeaderPreviewFontSizePx(headerText) {
  const safeLength = String(headerText).length;
  if (safeLength <= 24) {
    return 60;
  }

  if (safeLength <= 48) {
    return 52;
  }

  if (safeLength <= 72) {
    return 46;
  }

  if (safeLength <= 110) {
    return 40;
  }

  if (safeLength <= 160) {
    return 34;
  }

  return 30;
}

function updateProgressUi() {
  if (!readingSession?.ui) {
    return;
  }

  const isAutoContinueVisualState = isAutoContinueVisualStateActive();
  if (isAutoContinueVisualState) {
    const frozenTotal = Math.max(1, readingSession.initialWordsCount || readingSession.words.length);
    readingSession.ui.progressBar.max = String(frozenTotal - 1);
    readingSession.ui.progressBar.value = String(frozenTotal - 1);
    readingSession.ui.progressWrap.classList.add("swift-read-progress-wrap-auto-continue");
    readingSession.ui.progressBar.classList.add("swift-read-progress-auto-continue");
    readingSession.ui.progressText.textContent = `${frozenTotal} / ${frozenTotal}`;
    return;
  }

  const total = readingSession.words.length;
  const safeTotal = Math.max(1, total);
  const clampedIndex = Math.min(safeTotal - 1, Math.max(0, readingSession.currentIndex));
  const current = total === 0 ? 0 : clampedIndex + 1;

  readingSession.ui.progressBar.max = String(safeTotal - 1);
  readingSession.ui.progressBar.value = String(clampedIndex);
  readingSession.ui.progressWrap.classList.remove("swift-read-progress-wrap-auto-continue");
  readingSession.ui.progressBar.classList.remove("swift-read-progress-auto-continue");
  readingSession.ui.progressText.textContent = `${current} / ${total}`;
}

function updatePlayPauseUi() {
  if (!readingSession?.ui) {
    return;
  }

  const btn = readingSession.ui.playPauseButton;

  if (isAnyStopActive()) {
    btn.textContent = "Enter \u21B5";
    btn.classList.add("swift-read-play-pause-stop-active");
    btn.disabled = true;
    return;
  }

  btn.classList.remove("swift-read-play-pause-stop-active");
  btn.disabled = false;
  btn.textContent = readingSession.isPlaying ? "Pause" : "Play";
}

function setUpwardExpansionOpen(isOpen) {
  if (!readingSession) {
    return;
  }

  readingSession.upwardExpansionOpen = Boolean(isOpen);
  syncUpwardExpansionUi();
}

function syncUpwardExpansionUi() {
  if (!readingSession?.ui) {
    return;
  }

  const isOpen = Boolean(readingSession.upwardExpansionOpen);
  readingSession.ui.modalShell.classList.toggle("swift-read-modal-shell-upward-open", isOpen);
  readingSession.ui.upwardExpansion.classList.toggle("swift-read-upward-expansion-open", isOpen);
  readingSession.ui.upwardToggleButton.classList.toggle("swift-read-upward-toggle-open", isOpen);
  readingSession.ui.upwardExpansion.setAttribute("aria-hidden", isOpen ? "false" : "true");
  readingSession.ui.upwardToggleButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function syncUpwardStreamUi() {
  if (!readingSession?.ui?.upwardExpansionStream) {
    return;
  }

  const currentBlockEntry = buildCurrentBlockProgressEntry();
  const streamEntries = buildUpwardStreamEntries();
  const checkpointEntries = buildCheckpointEntries();
  const currentBlockSignature = currentBlockEntry
    ? `current:${currentBlockEntry.startWordIndex}:${currentBlockEntry.endWordIndex}:${currentBlockEntry.readWordsCount}`
    : "current:none";
  const historySignature = streamEntries
    .map((entry) => `${entry.kind}:${entry.startWordIndex}:${entry.endWordIndex}`)
    .join("|");
  const checkpointSignature = checkpointEntries
    .map((entry) => `${entry.kind}:${entry.signature}:${entry.pending ? "1" : "0"}`)
    .join("|");
  const collapseSignature = readingSession.currentBlockCollapsed ? "collapsed:1" : "collapsed:0";
  const nextSignature = `${collapseSignature}|${currentBlockSignature}|${historySignature}|${checkpointSignature}`;
  if (readingSession.lastUpwardStreamSignature === nextSignature) {
    return;
  }

  readingSession.lastUpwardStreamSignature = nextSignature;
  renderUpwardStreamEntries(streamEntries, currentBlockEntry, checkpointEntries);
}

function buildCurrentBlockProgressEntry() {
  if (!readingSession || !Array.isArray(readingSession.semanticBlocks)) {
    return null;
  }

  const currentBlock = findCurrentSemanticBlock(readingSession.currentIndex);
  if (!currentBlock || !Array.isArray(readingSession.words)) {
    return null;
  }

  if (isSemanticListBlock(currentBlock)) {
    return null;
  }

  const startWordIndex = Number(currentBlock.startWordIndex);
  const endWordIndex = Number(currentBlock.endWordIndex);
  if (!Number.isFinite(startWordIndex) || !Number.isFinite(endWordIndex)) {
    return null;
  }

  const safeStartWordIndex = Math.max(0, startWordIndex);
  const safeEndWordIndex = Math.min(readingSession.words.length - 1, endWordIndex);
  if (safeEndWordIndex < safeStartWordIndex) {
    return null;
  }

  const totalWordsCount = safeEndWordIndex - safeStartWordIndex + 1;
  const readWordsCount = Math.min(
    totalWordsCount,
    Math.max(0, readingSession.currentIndex - safeStartWordIndex + 1),
  );

  const readText = readingSession.words
    .slice(safeStartWordIndex, safeStartWordIndex + readWordsCount)
    .join(" ");
  const remainingText = readingSession.words
    .slice(safeStartWordIndex + readWordsCount, safeEndWordIndex + 1)
    .join(" ");

  return {
    type: currentBlock.type,
    tagName: currentBlock.tagName,
    startWordIndex: safeStartWordIndex,
    endWordIndex: safeEndWordIndex,
    readWordsCount,
    totalWordsCount,
    readText,
    remainingText,
  };
}

function findCurrentSemanticBlock(currentWordIndex) {
  if (!readingSession || !Array.isArray(readingSession.semanticBlocks)) {
    return null;
  }

  for (const block of readingSession.semanticBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const startWordIndex = Number(block.startWordIndex);
    const endWordIndex = Number(block.endWordIndex);
    if (!Number.isFinite(startWordIndex) || !Number.isFinite(endWordIndex)) {
      continue;
    }

    if (currentWordIndex >= startWordIndex && currentWordIndex <= endWordIndex) {
      return block;
    }
  }

  return null;
}

function buildUpwardStreamEntries() {
  if (!readingSession) {
    return [];
  }

  const semanticBlocks = Array.isArray(readingSession.semanticBlocks)
    ? readingSession.semanticBlocks
    : [];
  const consumedBlocks = semanticBlocks.filter((block) =>
    isSemanticBlockConsumed(block, readingSession.currentIndex) && !isSemanticListBlock(block),
  );
  const recentBlocks = consumedBlocks.slice(-MAX_RECENT_HISTORY_ITEMS);

  return recentBlocks.map((block) => ({
    kind: UPWARD_STREAM_ITEM_KIND.HISTORY_TEXT,
    type: block.type,
    tagName: block.tagName,
    text: block.text,
    startWordIndex: block.startWordIndex,
    endWordIndex: block.endWordIndex,
  }));
}

function buildCheckpointEntries() {
  if (!readingSession) {
    return [];
  }

  const historyEntries = Array.isArray(readingSession.checkpointHistory)
    ? readingSession.checkpointHistory
    : [];
  const recentHistoryEntries = historyEntries
    .slice(-MAX_CHECKPOINT_HISTORY_ITEMS)
    .map((entry) => ({
      ...entry,
      pending: false,
    }));

  if (readingSession.pendingRuleBStop) {
    recentHistoryEntries.push({
      ...readingSession.pendingRuleBStop,
      pending: true,
    });
  }

  return recentHistoryEntries;
}

function isSemanticBlockConsumed(block, currentWordIndex) {
  if (!block || typeof block !== "object") {
    return false;
  }

  const endWordIndex = Number(block.endWordIndex);
  if (!Number.isFinite(endWordIndex)) {
    return false;
  }

  return endWordIndex < currentWordIndex;
}

function renderUpwardStreamEntries(streamEntries, currentBlockEntry, checkpointEntries) {
  if (!readingSession?.ui?.upwardExpansionStream) {
    return;
  }

  const streamRoot = readingSession.ui.upwardExpansionStream;
  streamRoot.replaceChildren();

  const header = document.createElement("div");
  header.className = "swift-read-upward-stream-header";

  const title = document.createElement("div");
  title.className = "swift-read-upward-stream-title";
  title.textContent = "Reading Stream";

  const currentBlockToggleButton = document.createElement("button");
  currentBlockToggleButton.type = "button";
  currentBlockToggleButton.className = "swift-read-current-block-toggle";
  if (readingSession.currentBlockCollapsed) {
    currentBlockToggleButton.classList.add("swift-read-current-block-toggle-collapsed");
  }
  currentBlockToggleButton.textContent = "▾";
  currentBlockToggleButton.setAttribute("aria-label", "Toggle current block");
  currentBlockToggleButton.setAttribute(
    "aria-expanded",
    readingSession.currentBlockCollapsed ? "false" : "true",
  );
  currentBlockToggleButton.addEventListener("click", handleCurrentBlockToggleClick);

  header.append(title, currentBlockToggleButton);
  streamRoot.append(header);

  const recentHeader = document.createElement("div");
  recentHeader.className = "swift-read-upward-stream-subtitle";
  recentHeader.textContent = "Recently Read";
  streamRoot.append(recentHeader);

  if (!Array.isArray(streamEntries) || streamEntries.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "swift-read-upward-stream-empty";
    emptyState.textContent = "No completed blocks yet.";
    streamRoot.append(emptyState);
  } else {
    for (const entry of streamEntries) {
      streamRoot.append(createUpwardStreamHistoryEntry(entry));
    }
  }

  if (Array.isArray(checkpointEntries) && checkpointEntries.length > 0) {
    const checkpointHeader = document.createElement("div");
    checkpointHeader.className = "swift-read-upward-stream-subtitle";
    checkpointHeader.textContent = "Checkpoints";
    streamRoot.append(checkpointHeader);

    for (const checkpointEntry of checkpointEntries) {
      streamRoot.append(createRuleBCheckpointCard(checkpointEntry));
    }
  }

  if (currentBlockEntry && !readingSession.currentBlockCollapsed) {
    streamRoot.append(createCurrentBlockProgressCard(currentBlockEntry));
  }
}

function createRuleBCheckpointCard(entry) {
  const card = document.createElement("article");
  card.className = "swift-read-upward-checkpoint-card swift-read-upward-checkpoint-card-rule-b";
  card.setAttribute("data-stream-kind", UPWARD_STREAM_ITEM_KIND.CHECKPOINT);
  card.setAttribute("data-checkpoint-kind", entry.kind ?? "checkpoint");
  if (entry.pending) {
    card.classList.add("swift-read-upward-checkpoint-card-pending");
  }

  const label = document.createElement("span");
  label.className = "swift-read-upward-checkpoint-label";
  label.textContent = entry.pending
    ? `${entry.title ?? "Checkpoint"} (Paused)`
    : entry.title ?? "Checkpoint";

  card.append(label);

  if (entry.imageSource) {
    const mediaRow = document.createElement("div");
    mediaRow.className = "swift-read-upward-checkpoint-media-row";

    const image = document.createElement("img");
    image.className = "swift-read-upward-checkpoint-image swift-read-upward-previewable-image";
    image.src = entry.imageSource;
    image.alt = entry.imageAlt || "Checkpoint image preview";
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("title", "Open image preview");
    mediaRow.append(image);
    card.append(mediaRow);
  }

  const checkpointBody = createRuleBCheckpointBody(entry);
  if (checkpointBody) {
    card.append(checkpointBody);
  }

  if (entry.previewText) {
    const caption = document.createElement("p");
    caption.className = "swift-read-upward-checkpoint-caption";
    caption.textContent = entry.previewText;
    card.append(caption);
  }

  if (entry.pending) {
    const hint = document.createElement("p");
    hint.className = "swift-read-upward-checkpoint-hint";
    hint.textContent = "Press Enter to continue";
    card.append(hint);
  }

  return card;
}

function createRuleBCheckpointBody(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  if (entry.kind === RULE_B_STOP_KIND.CODE) {
    const code = document.createElement("pre");
    code.className = "swift-read-upward-checkpoint-code";
    code.textContent = truncateForCheckpointPreview(
      entry.anchorElement?.textContent || entry.previewText || "",
      600,
    );
    return code;
  }

  if (entry.kind === RULE_B_STOP_KIND.LIST) {
    const listItems = collectRuleBListItems(entry.anchorElement, 5);
    if (listItems.length === 0) {
      return null;
    }

    const list = document.createElement("ul");
    list.className = "swift-read-upward-checkpoint-list";
    for (const listItemText of listItems) {
      const listItem = document.createElement("li");
      listItem.textContent = listItemText;
      list.append(listItem);
    }
    return list;
  }

  if (entry.kind === RULE_B_STOP_KIND.TABLE) {
    return createRuleBUpwardCheckpointTable(entry.anchorElement);
  }

  return null;
}

function createRuleBUpwardCheckpointTable(anchorElement) {
  if (!(anchorElement instanceof HTMLTableElement)) {
    return null;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "swift-read-upward-checkpoint-table-wrap";

  const table = document.createElement("table");
  table.className = "swift-read-upward-checkpoint-table";

  const maxRows = 4;
  const maxCols = 4;
  const sourceRows = Array.from(anchorElement.rows).slice(0, maxRows);
  for (const sourceRow of sourceRows) {
    const row = document.createElement("tr");
    const sourceCells = Array.from(sourceRow.cells).slice(0, maxCols);
    for (const sourceCell of sourceCells) {
      const cellTag = sourceCell.tagName === "TH" ? "th" : "td";
      const cell = document.createElement(cellTag);
      cell.textContent = truncateForCheckpointPreview(sourceCell.textContent || "", 70);
      row.append(cell);
    }
    table.append(row);
  }

  wrapper.append(table);
  return wrapper;
}

function handleCurrentBlockToggleClick() {
  if (!readingSession) {
    return;
  }

  readingSession.currentBlockCollapsed = !readingSession.currentBlockCollapsed;
  syncUpwardStreamUi();
}

function createCurrentBlockProgressCard(currentBlockEntry) {
  const card = document.createElement("article");
  card.className = "swift-read-current-block-card";
  card.setAttribute("data-block-type", currentBlockEntry.type);

  const label = document.createElement("span");
  label.className = "swift-read-current-block-label";
  label.textContent = `Current Block (${formatTagNameForDisplay(currentBlockEntry.tagName)})`;

  const meta = document.createElement("span");
  meta.className = "swift-read-current-block-meta";
  meta.textContent = `${currentBlockEntry.readWordsCount} / ${currentBlockEntry.totalWordsCount} words`;

  const text = document.createElement("p");
  text.className = "swift-read-current-block-text";

  const readSpan = document.createElement("span");
  readSpan.className = "swift-read-current-block-read";
  readSpan.textContent = currentBlockEntry.readText;

  const remainingSpan = document.createElement("span");
  remainingSpan.className = "swift-read-current-block-remaining";
  remainingSpan.textContent = currentBlockEntry.remainingText;

  if (currentBlockEntry.readText && currentBlockEntry.remainingText) {
    readSpan.textContent = `${currentBlockEntry.readText} `;
  }

  text.append(readSpan, remainingSpan);
  card.append(label, meta, text);
  return card;
}

function createUpwardStreamHistoryEntry(entry) {
  const item = document.createElement("article");
  item.className = "swift-read-upward-stream-entry";
  item.setAttribute("data-stream-kind", entry.kind);
  item.setAttribute("data-block-type", entry.type);

  const label = document.createElement("span");
  label.className = "swift-read-upward-stream-entry-label";
  label.textContent = formatStreamHistoryLabel(entry);

  const text = document.createElement("p");
  text.className = "swift-read-upward-stream-entry-text";
  text.textContent = entry.text;

  item.append(label, text);
  return item;
}

function formatTagNameForDisplay(tagName) {
  if (!tagName) return "";
  return String(tagName).toUpperCase();
}

function formatStreamHistoryLabel(entry) {
  if (!entry || typeof entry !== "object") {
    return "Block";
  }

  if (entry.type === SEMANTIC_BLOCK_TYPE.HEADER) {
    return entry.tagName ? `Header (${formatTagNameForDisplay(entry.tagName)})` : "Header";
  }

  return entry.tagName ? `Text (${formatTagNameForDisplay(entry.tagName)})` : "Text";
}

function createOrpMarkup(word) {
  const safeWord = String(word);
  if (!safeWord) {
    return "&nbsp;";
  }

  const pivotIndex = getPivotIndex(safeWord.length);
  const safePivotIndex = Math.min(Math.max(0, pivotIndex), safeWord.length - 1);

  const before = escapeHtml(safeWord.slice(0, safePivotIndex));
  const pivot = escapeHtml(safeWord.charAt(safePivotIndex));
  const after = escapeHtml(safeWord.slice(safePivotIndex + 1));

  return `${before}<span class="${PIVOT_CLASS}">${pivot}</span>${after}`;
}

function getPivotIndex(wordLength) {
  if (wordLength <= 1) {
    return 0;
  }
  if (wordLength <= 5) {
    return 1;
  }
  if (wordLength <= 9) {
    return 2;
  }
  if (wordLength <= 13) {
    return 3;
  }
  return 4;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function startRsvpPlayback() {
  if (
    currentState !== READER_STATE.READING ||
    !readingSession ||
    !readingSession.isPlaying ||
    !Array.isArray(readingSession.words)
  ) {
    return;
  }

  if (readingSession.words.length === 0) {
    stopReading();
    return;
  }

  scheduleNextPlaybackTick(Date.now() + getCurrentIntervalMs());
}

function pauseRsvpPlayback() {
  clearReadingTimer();
}

function clearReadingTimer() {
  if (!readingSession) {
    return;
  }

  if (readingSession.timerId !== null) {
    window.clearTimeout(readingSession.timerId);
    readingSession.timerId = null;
  }

  readingSession.nextTickAt = null;
}

function scheduleNextPlaybackTick(targetTimeMs) {
  if (!readingSession || !readingSession.isPlaying) {
    return;
  }

  clearReadingTimer();

  const delayMs = Math.max(0, targetTimeMs - Date.now());
  readingSession.nextTickAt = targetTimeMs;
  readingSession.timerId = window.setTimeout(() => {
    if (!readingSession) {
      return;
    }

    readingSession.timerId = null;
    onPlaybackTick(targetTimeMs);
  }, delayMs);
}

function onPlaybackTick(scheduledTimeMs) {
  if (currentState !== READER_STATE.READING || !readingSession || !readingSession.isPlaying) {
    return;
  }

  const totalWords = readingSession.words.length;
  if (totalWords === 0) {
    stopReading();
    return;
  }

  if (tryStopBeforeUpcomingHeaderBoundary()) {
    return;
  }

  if (tryStopBeforeRuleBBoundary()) {
    return;
  }

  if (readingSession.currentIndex >= totalWords - 1) {
    if (tryAutoContinueOnStreamEnd(scheduledTimeMs)) {
      return;
    }

    readingSession.isPlaying = false;
    updatePlayPauseUi();
    clearReadingTimer();
    return;
  }

  readingSession.currentIndex += 1;
  if (
    Number.isFinite(readingSession.blockedHeaderBoundaryIndex) &&
    readingSession.currentIndex > readingSession.blockedHeaderBoundaryIndex
  ) {
    readingSession.blockedHeaderBoundaryIndex = null;
    readingSession.releasedHeaderBoundaryIndex = null;
  }
  if (readingSession.releasedRuleBBoundarySignature) {
    readingSession.releasedRuleBBoundarySignature = null;
  }
  renderCurrentWord();
  updateProgressUi();

  const nextIntervalMs = getCurrentIntervalMs();
  const minScheduleTime = Date.now() + 1;
  const nextTargetTime = Math.max(minScheduleTime, scheduledTimeMs + nextIntervalMs);
  scheduleNextPlaybackTick(nextTargetTime);
}

function tryStopBeforeUpcomingHeaderBoundary() {
  if (!readingSession || !settings.stopBeforeHeader) {
    return false;
  }

  const boundary = findUpcomingHeaderBoundary(readingSession.currentIndex);
  if (!boundary || !Number.isFinite(boundary.boundaryIndex)) {
    return false;
  }
  const boundaryIndex = boundary.boundaryIndex;

  if (readingSession.releasedHeaderBoundaryIndex === boundaryIndex) {
    readingSession.releasedHeaderBoundaryIndex = null;
    readingSession.blockedHeaderBoundaryIndex = null;
    return false;
  }

  readingSession.blockedHeaderBoundaryIndex = boundaryIndex;
  readingSession.isPlaying = false;
  updatePlayPauseUi();
  clearReadingTimer();
  renderCurrentWord();
  focusReadingOverlay();
  return true;
}

function findUpcomingSemanticBoundary(currentWordIndex) {
  if (!readingSession || !Array.isArray(readingSession.semanticBlocks)) {
    return null;
  }

  for (let index = 0; index < readingSession.semanticBlocks.length - 1; index += 1) {
    const currentBlock = readingSession.semanticBlocks[index];
    const nextBlock = readingSession.semanticBlocks[index + 1];
    if (!currentBlock || !nextBlock) {
      continue;
    }

    const endWordIndex = Number(currentBlock.endWordIndex);
    if (!Number.isFinite(endWordIndex) || endWordIndex !== currentWordIndex) {
      continue;
    }

    return {
      boundaryIndex: endWordIndex,
      currentBlock,
      nextBlock,
    };
  }

  return null;
}

function findUpcomingHeaderBoundary(currentWordIndex) {
  const semanticBoundary = findUpcomingSemanticBoundary(currentWordIndex);
  if (!semanticBoundary) {
    return null;
  }

  if (semanticBoundary.nextBlock.type === SEMANTIC_BLOCK_TYPE.HEADER) {
    return {
      boundaryIndex: semanticBoundary.boundaryIndex,
      nextHeaderBlock: semanticBoundary.nextBlock,
    };
  }

  return null;
}

function tryStopBeforeRuleBBoundary() {
  if (!readingSession || !settings.stopBeforeMedia || readingSession.pendingRuleBStop) {
    return false;
  }

  const stopEntry = findUpcomingRuleBBoundary(readingSession.currentIndex);
  if (!stopEntry) {
    return false;
  }

  if (
    readingSession.releasedRuleBBoundarySignature &&
    readingSession.releasedRuleBBoundarySignature === stopEntry.signature
  ) {
    readingSession.releasedRuleBBoundarySignature = null;
    return false;
  }

  activateRuleBStop(stopEntry);
  return true;
}

function findUpcomingRuleBBoundary(currentWordIndex) {
  const semanticBoundary = findUpcomingSemanticBoundary(currentWordIndex);
  if (!semanticBoundary?.nextBlock) {
    return null;
  }

  return createRuleBStopFromSemanticBoundary(semanticBoundary);
}

function createRuleBStopFromSemanticBoundary(semanticBoundary) {
  if (!semanticBoundary || typeof semanticBoundary !== "object") {
    return null;
  }

  const currentBlock = semanticBoundary.currentBlock;
  const nextBlock = semanticBoundary.nextBlock;
  if (!currentBlock || !nextBlock) {
    return null;
  }

  const nextTagName = String(nextBlock.tagName || "").toUpperCase();
  const kind = getRuleBKindForTagName(nextTagName);
  if (!kind) {
    return null;
  }

  if (
    nextTagName === "LI" &&
    String(currentBlock.tagName || "").toUpperCase() === "LI" &&
    currentBlock.element instanceof Element &&
    nextBlock.element instanceof Element &&
    currentBlock.element.parentElement === nextBlock.element.parentElement
  ) {
    return null;
  }

  const boundaryIndex = Number(semanticBoundary.boundaryIndex);
  const signature = `semantic:${boundaryIndex}:${nextTagName}`;
  const anchorElement = resolveRuleBStopAnchorElement(
    nextBlock.element instanceof Element ? nextBlock.element : null,
    kind,
  );
  const anchorTagName = String(anchorElement?.tagName || nextTagName).toUpperCase();
  const previewText = buildRuleBPreviewText(anchorElement, nextBlock.text, kind);

  return {
    kind,
    title: getRuleBCheckpointTitle(kind, anchorTagName),
    previewText,
    imageSource: getRuleBImageSource(anchorElement, kind),
    imageAlt: getRuleBImageAlt(anchorElement),
    signature,
    source: "semantic-boundary",
    anchorElement: anchorElement instanceof Element ? anchorElement : null,
  };
}

function resolveRuleBStopAnchorElement(element, kind) {
  if (!(element instanceof Element)) {
    return null;
  }

  if (kind === RULE_B_STOP_KIND.LIST && element.tagName === "LI") {
    const parentList = element.parentElement;
    if (isListContainerElement(parentList)) {
      return parentList;
    }
  }

  return element;
}

function activateRuleBStop(stopEntry) {
  if (!readingSession || !stopEntry || typeof stopEntry !== "object") {
    return;
  }

  readingSession.pendingRuleBStop = {
    ...stopEntry,
    pending: true,
  };
  readingSession.isPlaying = false;
  updatePlayPauseUi();
  clearReadingTimer();
  renderCurrentWord();
  syncUpwardStreamUi();
  focusReadingOverlay();
}

function tryAutoContinueOnStreamEnd(scheduledTimeMs) {
  if (!readingSession || !settings.autoContinue) {
    return false;
  }

  const didAppend = appendNextSiblingReadableBlockToReadingSession();
  if (!didAppend) {
    return false;
  }

  readingSession.autoContinueStarted = true;
  updateProgressUi();

  const nextIntervalMs = getCurrentIntervalMs();
  const minScheduleTime = Date.now() + 1;
  const nextTargetTime = Math.max(minScheduleTime, scheduledTimeMs + nextIntervalMs);
  scheduleNextPlaybackTick(nextTargetTime);
  return true;
}

function restartPlaybackTimerFromNow() {
  if (currentState !== READER_STATE.READING || !readingSession || !readingSession.isPlaying) {
    return;
  }

  scheduleNextPlaybackTick(Date.now() + getCurrentIntervalMs());
}

function handleProgressInput(event) {
  if (currentState !== READER_STATE.READING || !readingSession) {
    return;
  }

  if (isAutoContinueVisualStateActive()) {
    return;
  }

  const slider = event.currentTarget;
  if (!(slider instanceof HTMLInputElement)) {
    return;
  }

  const nextIndex = Number.parseInt(slider.value, 10);
  if (!Number.isFinite(nextIndex)) {
    return;
  }

  seekToWordIndex(nextIndex);
}

function seekToWordIndex(nextIndex) {
  if (!readingSession) {
    return;
  }

  const nextIndexNumber = Number(nextIndex);
  const totalWords = readingSession.words.length;
  if (totalWords === 0) {
    return;
  }

  readingSession.currentIndex = Math.min(totalWords - 1, Math.max(0, nextIndexNumber));
  if (
    Number.isFinite(readingSession.blockedHeaderBoundaryIndex) &&
    readingSession.blockedHeaderBoundaryIndex !== readingSession.currentIndex
  ) {
    readingSession.blockedHeaderBoundaryIndex = null;
  }
  readingSession.releasedHeaderBoundaryIndex = null;
  readingSession.pendingRuleBStop = null;
  readingSession.releasedRuleBBoundarySignature = null;
  readingSession.releasedRuleBStopElement = null;
  renderCurrentWord();
  updateProgressUi();

  if (readingSession.isPlaying) {
    restartPlaybackTimerFromNow();
  }
}

function getCurrentIntervalMs() {
  if (!readingSession) {
    return 60000 / DEFAULT_SETTINGS.wpm;
  }

  const wpm = normalizeWpm(readingSession.currentWpm);
  return 60000 / wpm;
}

function isAutoContinueVisualStateActive() {
  return Boolean(readingSession && settings.autoContinue && readingSession.autoContinueStarted);
}

function appendNextSiblingReadableBlockToReadingSession() {
  if (!readingSession) {
    return false;
  }

  const currentLastReadableBlock = readingSession.lastSelectedParagraph;
  if (!(currentLastReadableBlock instanceof Element)) {
    return false;
  }

  const nextTarget = findNextAutoContinueTarget(currentLastReadableBlock);
  if (!nextTarget || typeof nextTarget !== "object") {
    return false;
  }

  if (nextTarget.type === "stop" && nextTarget.stop) {
    activateRuleBStop(nextTarget.stop);
    return false;
  }

  if (nextTarget.type !== "readable" || !isReadableBlockElement(nextTarget.element)) {
    return false;
  }

  const didAppend = appendReadableBlockToReadingSession(nextTarget.element);
  if (didAppend) {
    readingSession.releasedRuleBStopElement = null;
  }
  return didAppend;
}

function findNextAutoContinueTarget(currentReadableBlock) {
  if (!isReadableBlockElement(currentReadableBlock)) {
    return null;
  }

  if (currentReadableBlock.tagName === "LI") {
    const parentList = currentReadableBlock.parentElement;
    if (isListContainerElement(parentList)) {
      return findNextAutoContinueTargetAfterElement(parentList);
    }
  }

  if (isListContainerElement(currentReadableBlock)) {
    return findNextAutoContinueTargetAfterElement(currentReadableBlock);
  }

  return findNextAutoContinueTargetAfterElement(currentReadableBlock);
}

function findNextAutoContinueTargetAfterElement(startElement) {
  if (!(startElement instanceof Element)) {
    return null;
  }

  let cursor = startElement;
  while (cursor) {
    let sibling = cursor.nextElementSibling;
    while (sibling) {
      const ruleBStop = maybeCreateRuleBStopFromFlowElement(sibling);
      if (ruleBStop) {
        if (!shouldSkipReleasedRuleBStop(ruleBStop)) {
          return {
            type: "stop",
            stop: ruleBStop,
          };
        }
      }

      const siblingReadable = resolveReadableCandidateForAutoContinue(sibling);
      if (siblingReadable) {
        return {
          type: "readable",
          element: siblingReadable,
        };
      }
      sibling = sibling.nextElementSibling;
    }

    cursor = cursor.parentElement;
  }

  return null;
}

function shouldSkipReleasedRuleBStop(stopEntry) {
  if (!readingSession?.releasedRuleBStopElement || !stopEntry?.anchorElement) {
    return false;
  }

  return readingSession.releasedRuleBStopElement === stopEntry.anchorElement;
}

function maybeCreateRuleBStopFromFlowElement(element) {
  if (!readingSession || !settings.stopBeforeMedia || !(element instanceof Element)) {
    return null;
  }

  const stopCandidate = getFirstRuleBStopCandidate(element);
  if (!(stopCandidate instanceof Element)) {
    return null;
  }

  const readableCandidate = resolveReadableCandidateForAutoContinue(element);
  if (
    readableCandidate &&
    stopCandidate !== readableCandidate &&
    !isElementBeforeOrSame(stopCandidate, readableCandidate)
  ) {
    return null;
  }

  return createRuleBStopEntryFromElement(stopCandidate, "auto-continue");
}

function getFirstRuleBStopCandidate(element) {
  if (!(element instanceof Element)) {
    return null;
  }

  if (RULE_B_STOP_TAGS.has(element.tagName)) {
    return element;
  }

  const descendant = element.querySelector(RULE_B_STOP_TAG_SELECTOR);
  return descendant instanceof Element ? descendant : null;
}

function isElementBeforeOrSame(leftElement, rightElement) {
  if (!(leftElement instanceof Element) || !(rightElement instanceof Element)) {
    return false;
  }

  if (leftElement === rightElement) {
    return true;
  }

  const position = leftElement.compareDocumentPosition(rightElement);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return true;
  }

  return false;
}

function resolveReadableCandidateForAutoContinue(element) {
  if (!(element instanceof Element)) {
    return null;
  }

  if (isAutoContinueReadableCandidate(element)) {
    return element;
  }

  for (const nonSpanDescendant of element.querySelectorAll(
    AUTO_CONTINUE_NON_SPAN_READABLE_BLOCK_SELECTOR,
  )) {
    if (isAutoContinueReadableCandidate(nonSpanDescendant)) {
      return nonSpanDescendant;
    }
  }

  for (const readableDescendant of element.querySelectorAll(
    AUTO_CONTINUE_READABLE_BLOCK_SELECTOR,
  )) {
    if (isAutoContinueReadableCandidate(readableDescendant)) {
      return readableDescendant;
    }
  }

  return null;
}

function isAutoContinueReadableCandidate(element) {
  return (
    element instanceof Element &&
    isReadableBlockElement(element) &&
    !isElementInsideListStructure(element)
  );
}

function isListContainerElement(element) {
  return element instanceof Element && (element.tagName === "UL" || element.tagName === "OL");
}

function isListTagName(tagName) {
  return LIST_TAGS.has(String(tagName || "").toUpperCase());
}

function isElementInsideListStructure(element) {
  return element instanceof Element && element.closest("ul, ol, li") !== null;
}

function createRuleBStopEntryFromElement(anchorElement, source) {
  if (!(anchorElement instanceof Element)) {
    return null;
  }

  const tagName = anchorElement.tagName;
  const kind = getRuleBKindForTagName(tagName);
  if (!kind) {
    return null;
  }

  if (source === "auto-continue" && tagName === "LI") {
    return null;
  }

  return {
    kind,
    title: getRuleBCheckpointTitle(kind, tagName),
    previewText: buildRuleBPreviewText(anchorElement, "", kind),
    imageSource: getRuleBImageSource(anchorElement, kind),
    imageAlt: getRuleBImageAlt(anchorElement),
    signature: `${source}:${kind}:${getStopElementIdentity(anchorElement)}`,
    source,
    anchorElement,
  };
}

function getRuleBKindForTagName(tagName) {
  const upperTagName = String(tagName || "").toUpperCase();
  if (!upperTagName) {
    return null;
  }

  if (upperTagName === "IMG") {
    return RULE_B_STOP_KIND.MEDIA;
  }

  if (upperTagName === "TABLE") {
    return RULE_B_STOP_KIND.TABLE;
  }

  if (upperTagName === "PRE" || upperTagName === "CODE") {
    return RULE_B_STOP_KIND.CODE;
  }

  if (isListTagName(upperTagName)) {
    return RULE_B_STOP_KIND.LIST;
  }

  return null;
}

function getRuleBCheckpointTitle(kind, tagName) {
  const upperTagName = String(tagName || "").toUpperCase();
  if (kind === RULE_B_STOP_KIND.MEDIA) {
    return "Image Checkpoint";
  }

  if (kind === RULE_B_STOP_KIND.TABLE) {
    return "Table Checkpoint";
  }

  if (kind === RULE_B_STOP_KIND.CODE) {
    return "Code Checkpoint";
  }

  if (kind === RULE_B_STOP_KIND.LIST) {
    return upperTagName === "LI" ? "List Item Checkpoint" : "List Checkpoint";
  }

  return "Checkpoint";
}

function buildRuleBPreviewText(anchorElement, fallbackText, kind) {
  if (kind === RULE_B_STOP_KIND.LIST) {
    return buildListPreviewText(anchorElement, fallbackText);
  }

  if (kind === RULE_B_STOP_KIND.TABLE) {
    return buildTablePreviewText(anchorElement, fallbackText);
  }

  if (kind === RULE_B_STOP_KIND.CODE) {
    return buildCodePreviewText(anchorElement, fallbackText);
  }

  if (kind === RULE_B_STOP_KIND.MEDIA) {
    return buildMediaPreviewText(anchorElement, fallbackText);
  }

  return truncateForCheckpointPreview(fallbackText);
}

function buildListPreviewText(listElement, fallbackText) {
  if (!(listElement instanceof Element)) {
    return truncateForCheckpointPreview(fallbackText);
  }

  if (listElement.tagName === "LI") {
    return truncateForCheckpointPreview(listElement.textContent || fallbackText);
  }

  const listItems = [];
  for (const child of Array.from(listElement.children)) {
    if (!(child instanceof Element) || child.tagName !== "LI") {
      continue;
    }

    const text = sanitizeText(child.textContent || "");
    if (!text) {
      continue;
    }

    listItems.push(text);
    if (listItems.length >= 3) {
      break;
    }
  }

  if (listItems.length === 0) {
    return truncateForCheckpointPreview(listElement.textContent || fallbackText);
  }

  return truncateForCheckpointPreview(listItems.map((item) => `• ${item}`).join(" "));
}

function buildTablePreviewText(tableElement, fallbackText) {
  if (!(tableElement instanceof HTMLTableElement)) {
    return truncateForCheckpointPreview(tableElement?.textContent || fallbackText);
  }

  const rowCount = tableElement.rows.length;
  const firstRow = tableElement.rows.item(0);
  const colCount = firstRow ? firstRow.cells.length : 0;
  const summary = rowCount > 0 ? `${rowCount} rows × ${colCount} columns.` : "Table checkpoint.";
  const text = sanitizeText(tableElement.textContent || "");
  if (!text) {
    return summary;
  }

  return `${summary} ${truncateForCheckpointPreview(text, 160)}`;
}

function buildCodePreviewText(codeElement, fallbackText) {
  if (!(codeElement instanceof Element)) {
    return truncateForCheckpointPreview(fallbackText);
  }

  return truncateForCheckpointPreview(codeElement.textContent || fallbackText, 260);
}

function buildMediaPreviewText(mediaElement, fallbackText) {
  if (!(mediaElement instanceof HTMLImageElement)) {
    return truncateForCheckpointPreview(mediaElement?.textContent || fallbackText);
  }

  const alt = sanitizeText(mediaElement.alt || "");
  if (alt) {
    return truncateForCheckpointPreview(alt);
  }

  return "Image encountered in document flow.";
}

function truncateForCheckpointPreview(text, maxLength = 220) {
  const safeText = sanitizeText(text || "");
  if (!safeText) {
    return "";
  }

  if (safeText.length <= maxLength) {
    return safeText;
  }

  return `${safeText.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getRuleBImageSource(element, kind) {
  if (kind !== RULE_B_STOP_KIND.MEDIA || !(element instanceof HTMLImageElement)) {
    return "";
  }

  return element.getAttribute("src") || element.currentSrc || element.src || "";
}

function getRuleBImageAlt(element) {
  if (!(element instanceof HTMLImageElement)) {
    return "";
  }

  return element.alt || "Checkpoint image preview";
}

function getStopElementIdentity(element) {
  if (!(element instanceof Element)) {
    return "none";
  }

  const existingIdentity = stopElementIdentityMap.get(element);
  if (existingIdentity) {
    return existingIdentity;
  }

  stopElementIdentityCounter += 1;
  stopElementIdentityMap.set(element, stopElementIdentityCounter);
  return stopElementIdentityCounter;
}

function buildReadingDataFromSelection(paragraphQueue) {
  const normalizedParagraphQueue = normalizeSelectedReadableBlocks(paragraphQueue);
  if (normalizedParagraphQueue.length === 0) {
    return null;
  }

  const paragraphs = [];
  const paragraphTexts = [];
  const semanticBlocks = [];
  const words = [];

  for (const paragraph of normalizedParagraphQueue) {
    const sanitized = sanitizeText(paragraph.innerText ?? paragraph.textContent ?? "");
    if (!sanitized) {
      continue;
    }

    const paragraphWords = sanitized.split(/\s+/).filter(Boolean);
    if (paragraphWords.length === 0) {
      continue;
    }

    const startWordIndex = words.length;
    words.push(...paragraphWords);
    const endWordIndex = words.length - 1;

    paragraphs.push(paragraph);
    paragraphTexts.push(sanitized);
    semanticBlocks.push(
      buildSemanticBlock(paragraph, sanitized, startWordIndex, endWordIndex),
    );
  }

  if (paragraphTexts.length === 0 || semanticBlocks.length === 0 || words.length === 0) {
    return null;
  }

  const combinedText = paragraphTexts.join(" ");

  return {
    paragraphs,
    paragraphTexts,
    semanticBlocks,
    combinedText,
    words,
    lastParagraph: paragraphs[paragraphs.length - 1] ?? null,
  };
}

function normalizeSelectedReadableBlocks(readableBlocks) {
  if (!Array.isArray(readableBlocks) || readableBlocks.length === 0) {
    return [];
  }

  const dedupedBlocks = [];
  const seenBlocks = new Set();

  for (const block of readableBlocks) {
    if (!isReadableBlockElement(block) || !block.isConnected || seenBlocks.has(block)) {
      continue;
    }

    seenBlocks.add(block);
    dedupedBlocks.push(block);
  }

  dedupedBlocks.sort(compareReadableBlockOrder);
  return dedupedBlocks.filter(
    (block) => !hasSelectedAncestorReadableBlock(block, seenBlocks),
  );
}

function compareReadableBlockOrder(leftBlock, rightBlock) {
  if (leftBlock === rightBlock) {
    return 0;
  }

  const position = leftBlock.compareDocumentPosition(rightBlock);
  if (position & Node.DOCUMENT_POSITION_PRECEDING) {
    return 1;
  }

  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return -1;
  }

  return 0;
}

function appendReadableBlockToReadingSession(readableBlock) {
  if (!readingSession || !isReadableBlockElement(readableBlock)) {
    return false;
  }

  if (isElementInsideListStructure(readableBlock)) {
    return false;
  }

  const nextText = sanitizeText(readableBlock.innerText ?? readableBlock.textContent ?? "");
  if (!nextText) {
    return false;
  }

  const nextWords = nextText.split(/\s+/).filter(Boolean);
  if (nextWords.length === 0) {
    return false;
  }

  const startWordIndex = readingSession.words.length;
  readingSession.words.push(...nextWords);
  const endWordIndex = readingSession.words.length - 1;

  readingSession.paragraphs.push(readableBlock);
  readingSession.paragraphTexts.push(nextText);
  readingSession.semanticBlocks.push(
    buildSemanticBlock(readableBlock, nextText, startWordIndex, endWordIndex),
  );
  readingSession.fullText = readingSession.fullText
    ? `${readingSession.fullText} ${nextText}`
    : nextText;
  readingSession.lastSelectedParagraph = readableBlock;
  return true;
}

function buildSemanticBlock(readableBlock, text, startWordIndex, endWordIndex) {
  return {
    type: getSemanticBlockType(readableBlock),
    tagName: readableBlock.tagName.toLowerCase(),
    element: readableBlock,
    text,
    startWordIndex,
    endWordIndex,
  };
}

function maybeActivateInitialRuleBStop() {
  if (!readingSession || !settings.stopBeforeMedia || readingSession.pendingRuleBStop) {
    return false;
  }

  const semanticBlocks = Array.isArray(readingSession.semanticBlocks)
    ? readingSession.semanticBlocks
    : [];
  const firstBlock = semanticBlocks[0];
  if (!isSemanticListBlock(firstBlock)) {
    return false;
  }

  const kind = RULE_B_STOP_KIND.LIST;
  const anchorElement = resolveRuleBStopAnchorElement(
    firstBlock.element instanceof Element ? firstBlock.element : null,
    kind,
  );
  const anchorTagName = String(anchorElement?.tagName || firstBlock.tagName || "").toUpperCase();
  const firstBlockStart = Number(firstBlock.startWordIndex);
  const boundaryIndex = Number.isFinite(firstBlockStart) ? firstBlockStart : 0;

  activateRuleBStop({
    kind,
    title: getRuleBCheckpointTitle(kind, anchorTagName),
    previewText: buildRuleBPreviewText(anchorElement, firstBlock.text, kind),
    imageSource: getRuleBImageSource(anchorElement, kind),
    imageAlt: getRuleBImageAlt(anchorElement),
    signature: `semantic-initial:${boundaryIndex}:${anchorTagName}`,
    source: "semantic-boundary",
    anchorElement: anchorElement instanceof Element ? anchorElement : null,
  });

  return true;
}

function getSemanticBlockType(readableBlock) {
  if (!(readableBlock instanceof Element)) {
    return SEMANTIC_BLOCK_TYPE.PARAGRAPH;
  }

  return HEADER_TAGS.has(readableBlock.tagName)
    ? SEMANTIC_BLOCK_TYPE.HEADER
    : SEMANTIC_BLOCK_TYPE.PARAGRAPH;
}

function sanitizeText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function handleSelectionMouseOver(event) {
  if (currentState !== READER_STATE.SELECTING) {
    return;
  }

  const paragraph = getParagraphFromTarget(event.target);
  if (!paragraph) {
    return;
  }

  if (!isParagraphBoundaryCrossing(paragraph, event.relatedTarget)) {
    return;
  }

  if (hoveredParagraph && hoveredParagraph !== paragraph) {
    hoveredParagraph.classList.remove(HOVER_CLASS);
  }

  paragraph.classList.add(HOVER_CLASS);
  hoveredParagraph = paragraph;

  if (isShiftHoverSelecting(event)) {
    addParagraphSelection(paragraph);
  }
}

function handleSelectionMouseOut(event) {
  if (currentState !== READER_STATE.SELECTING) {
    return;
  }

  const paragraph = getParagraphFromTarget(event.target);
  if (!paragraph) {
    return;
  }

  if (!isParagraphBoundaryCrossing(paragraph, event.relatedTarget)) {
    return;
  }

  paragraph.classList.remove(HOVER_CLASS);
  if (hoveredParagraph === paragraph) {
    hoveredParagraph = null;
  }
}

function handleSelectionClick(event) {
  if (currentState !== READER_STATE.SELECTING) {
    return;
  }

  const paragraph = getParagraphFromTarget(event.target);
  if (!paragraph) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  toggleParagraphSelection(paragraph);
}

function handleSelectionKeyDown(event) {
  if (currentState !== READER_STATE.SELECTING) {
    return;
  }

  if (event.key === "Shift") {
    isShiftPressed = true;
    if (hoveredParagraph) {
      addParagraphSelection(hoveredParagraph);
    }
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    transitionTo(READER_STATE.IDLE, { reason: "selection-cancelled" });
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void startReadingFromSelection();
  }
}

function handleSelectionKeyUp(event) {
  if (event.key === "Shift") {
    isShiftPressed = false;
  }
}

function toggleParagraphSelection(paragraph) {
  if (isParagraphSelected(paragraph)) {
    removeParagraphSelection(paragraph);
    return;
  }

  addParagraphSelection(paragraph);
}

function addParagraphSelection(paragraph) {
  if (!(paragraph instanceof Element) || !isReadableBlockElement(paragraph)) {
    return;
  }

  if (isAncestorReadableBlockSelected(paragraph)) {
    return;
  }

  if (isParagraphSelected(paragraph)) {
    return;
  }

  selectedParagraphSet.add(paragraph);
  selectedParagraphs.push(paragraph);
  paragraph.classList.add(SELECTED_CLASS);
  removeSelectedDescendantReadableBlocks(paragraph);
}

function removeParagraphSelection(paragraph) {
  if (!(paragraph instanceof Element) || !isParagraphSelected(paragraph)) {
    return;
  }

  selectedParagraphSet.delete(paragraph);
  const existingIndex = selectedParagraphs.indexOf(paragraph);
  if (existingIndex >= 0) {
    selectedParagraphs.splice(existingIndex, 1);
  }
  paragraph.classList.remove(SELECTED_CLASS);
}

function isParagraphSelected(paragraph) {
  return selectedParagraphSet.has(paragraph);
}

function isParagraphBoundaryCrossing(paragraph, relatedTarget) {
  const relatedParagraph = getParagraphFromTarget(relatedTarget);
  return paragraph !== relatedParagraph;
}

function isShiftHoverSelecting(event) {
  return Boolean(isShiftPressed || event.shiftKey);
}

function getParagraphFromTarget(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  const nonSpanReadableBlock = target.closest(NON_SPAN_READABLE_BLOCK_SELECTOR);
  if (nonSpanReadableBlock) {
    return nonSpanReadableBlock;
  }

  return target.closest(READABLE_BLOCK_SELECTOR);
}

function isReadableBlockElement(element) {
  return element instanceof Element && READABLE_BLOCK_TAGS.has(element.tagName);
}

function isAncestorReadableBlockSelected(readableBlock) {
  if (!isReadableBlockElement(readableBlock)) {
    return false;
  }

  let ancestor = readableBlock.parentElement;
  while (ancestor) {
    if (isReadableBlockElement(ancestor) && isParagraphSelected(ancestor)) {
      return true;
    }

    ancestor = ancestor.parentElement;
  }

  return false;
}

function hasSelectedAncestorReadableBlock(readableBlock, selectedBlockSet) {
  if (!isReadableBlockElement(readableBlock) || !(selectedBlockSet instanceof Set)) {
    return false;
  }

  let ancestor = readableBlock.parentElement;
  while (ancestor) {
    if (isReadableBlockElement(ancestor) && selectedBlockSet.has(ancestor)) {
      return true;
    }

    ancestor = ancestor.parentElement;
  }

  return false;
}

function removeSelectedDescendantReadableBlocks(readableBlock) {
  if (!isReadableBlockElement(readableBlock)) {
    return;
  }

  const selectedSnapshot = [...selectedParagraphs];
  for (const selectedElement of selectedSnapshot) {
    if (
      !isReadableBlockElement(selectedElement) ||
      selectedElement === readableBlock ||
      !readableBlock.contains(selectedElement)
    ) {
      continue;
    }

    removeParagraphSelection(selectedElement);
  }
}
