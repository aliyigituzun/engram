if (typeof globalThis.browser === "undefined") { globalThis.browser = chrome; }

const EXTRACTION_MODE = Object.freeze({
  PDF_WEBSITE: "pdf-website",
  // Legacy modes intentionally disabled for now:
  // SEMANTIC: "semantic",
  // LAYOUT: "layout",
  // OCR: "ocr",
});

const SEMANTIC_BLOCK_TYPE = Object.freeze({
  HEADING: "heading",
  PARAGRAPH: "paragraph",
  LIST: "list",
  TABLE: "table",
});

const LAYOUT_BLOCK_TYPE = "layout";
const PDF_WEBSITE_BLOCK_TYPE = Object.freeze({
  HEADING: "heading",
  LIST: "list",
  PARAGRAPH: "paragraph",
});
const OCR_BLOCK_TYPE = "ocr";
const PDF_WEBSITE_SELECTABLE_BLOCK_CLASS = "website-selectable-block";
const PDF_WEBSITE_HOVER_CLASS = "website-selectable-hover";
const PDF_WEBSITE_SELECTED_CLASS = "website-selectable-selected";
const PDF_WEBSITE_READER_DEFAULT_WPM = 300;
const PDF_WEBSITE_READER_MIN_WPM = 100;
const PDF_WEBSITE_READER_MAX_WPM = 1200;

document.addEventListener("DOMContentLoaded", () => {
  const modePdfWebsiteButton = document.getElementById("mode-pdf-website");
  const uploadButton = document.getElementById("upload-pdf-button");
  const uploadInput = document.getElementById("upload-pdf-input");
  const uploadStatus = document.getElementById("upload-status");
  const parsedTextRoot = document.getElementById("parsed-text-root");

  if (
    !(modePdfWebsiteButton instanceof HTMLButtonElement) ||
    !(uploadButton instanceof HTMLButtonElement) ||
    !(uploadInput instanceof HTMLInputElement) ||
    !(uploadStatus instanceof HTMLElement) ||
    !(parsedTextRoot instanceof HTMLElement)
  ) {
    return;
  }

  if (!globalThis.pdfjsLib) {
    setStatus(uploadStatus, "PDF.js failed to load.", "error");
    return;
  }

  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL(
    "vendor/pdfjs/pdf.worker.min.js",
  );

  const currentMode = EXTRACTION_MODE.PDF_WEBSITE;
  let uploadedFile = null;
  let parseToken = 0;
  let pdfWebsiteSelectedBlocks = [];
  let pdfWebsiteSelectedSet = new Set();
  let pdfWebsiteHoveredBlock = null;
  let pdfWebsiteShiftPressed = false;
  let pdfWebsiteReaderSession = null;

  function syncModeButtons() {
    const pdfWebsiteActive = currentMode === EXTRACTION_MODE.PDF_WEBSITE;

    modePdfWebsiteButton.classList.toggle("is-active", pdfWebsiteActive);
    modePdfWebsiteButton.setAttribute("aria-selected", pdfWebsiteActive ? "true" : "false");
  }

  function isPdfWebsiteModeActive() {
    return currentMode === EXTRACTION_MODE.PDF_WEBSITE;
  }

  function getPdfWebsiteSelectableBlocks() {
    return Array.from(
      parsedTextRoot.querySelectorAll(`.${PDF_WEBSITE_SELECTABLE_BLOCK_CLASS}`),
    ).filter((block) => block instanceof HTMLElement);
  }

  function getPdfWebsiteBlockFromTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    const block = target.closest(`.${PDF_WEBSITE_SELECTABLE_BLOCK_CLASS}`);
    if (!(block instanceof HTMLElement)) {
      return null;
    }

    return parsedTextRoot.contains(block) ? block : null;
  }

  function clearPdfWebsiteHoverState() {
    if (pdfWebsiteHoveredBlock instanceof HTMLElement) {
      pdfWebsiteHoveredBlock.classList.remove(PDF_WEBSITE_HOVER_CLASS);
    }
    pdfWebsiteHoveredBlock = null;
  }

  function clearPdfWebsiteSelectionState() {
    for (const block of pdfWebsiteSelectedBlocks) {
      block.classList.remove(PDF_WEBSITE_SELECTED_CLASS);
    }
    pdfWebsiteSelectedBlocks = [];
    pdfWebsiteSelectedSet.clear();
  }

  function resetPdfWebsiteInteractionState() {
    clearPdfWebsiteHoverState();
    clearPdfWebsiteSelectionState();
    pdfWebsiteShiftPressed = false;
  }

  function isPdfWebsiteBlockSelected(block) {
    return block instanceof HTMLElement && pdfWebsiteSelectedSet.has(block);
  }

  function addPdfWebsiteSelection(block) {
    if (!(block instanceof HTMLElement) || isPdfWebsiteBlockSelected(block)) {
      return;
    }

    pdfWebsiteSelectedSet.add(block);
    pdfWebsiteSelectedBlocks.push(block);
    block.classList.add(PDF_WEBSITE_SELECTED_CLASS);
  }

  function removePdfWebsiteSelection(block) {
    if (!(block instanceof HTMLElement) || !isPdfWebsiteBlockSelected(block)) {
      return;
    }

    pdfWebsiteSelectedSet.delete(block);
    const index = pdfWebsiteSelectedBlocks.indexOf(block);
    if (index >= 0) {
      pdfWebsiteSelectedBlocks.splice(index, 1);
    }
    block.classList.remove(PDF_WEBSITE_SELECTED_CLASS);
  }

  function togglePdfWebsiteSelection(block) {
    if (isPdfWebsiteBlockSelected(block)) {
      removePdfWebsiteSelection(block);
      return;
    }

    addPdfWebsiteSelection(block);
  }

  function isPdfWebsiteBlockBoundaryCrossing(block, relatedTarget) {
    return block !== getPdfWebsiteBlockFromTarget(relatedTarget);
  }

  function isPdfWebsiteShiftHoverSelecting(event) {
    return Boolean(pdfWebsiteShiftPressed || event.shiftKey);
  }

  function handlePdfWebsiteMouseOver(event) {
    if (!isPdfWebsiteModeActive()) {
      return;
    }

    const block = getPdfWebsiteBlockFromTarget(event.target);
    if (!block || !isPdfWebsiteBlockBoundaryCrossing(block, event.relatedTarget)) {
      return;
    }

    if (pdfWebsiteHoveredBlock && pdfWebsiteHoveredBlock !== block) {
      pdfWebsiteHoveredBlock.classList.remove(PDF_WEBSITE_HOVER_CLASS);
    }

    block.classList.add(PDF_WEBSITE_HOVER_CLASS);
    pdfWebsiteHoveredBlock = block;

    if (isPdfWebsiteShiftHoverSelecting(event)) {
      addPdfWebsiteSelection(block);
    }
  }

  function handlePdfWebsiteMouseOut(event) {
    if (!isPdfWebsiteModeActive()) {
      return;
    }

    const block = getPdfWebsiteBlockFromTarget(event.target);
    if (!block || !isPdfWebsiteBlockBoundaryCrossing(block, event.relatedTarget)) {
      return;
    }

    block.classList.remove(PDF_WEBSITE_HOVER_CLASS);
    if (pdfWebsiteHoveredBlock === block) {
      pdfWebsiteHoveredBlock = null;
    }
  }

  function handlePdfWebsiteClick(event) {
    if (!isPdfWebsiteModeActive()) {
      return;
    }

    const block = getPdfWebsiteBlockFromTarget(event.target);
    if (!block) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    togglePdfWebsiteSelection(block);
  }

  function isEditableTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const tagName = target.tagName;
    if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
      return true;
    }

    return target.isContentEditable;
  }

  function handlePdfWebsiteKeyDown(event) {
    if (!isPdfWebsiteModeActive()) {
      return;
    }

    if (event.key === "Shift") {
      pdfWebsiteShiftPressed = true;
      if (pdfWebsiteHoveredBlock) {
        addPdfWebsiteSelection(pdfWebsiteHoveredBlock);
      }
      return;
    }

    if (event.key === "Escape") {
      if (pdfWebsiteReaderSession) {
        event.preventDefault();
        event.stopPropagation();
        stopPdfWebsiteReader();
      }
      return;
    }

    if (pdfWebsiteReaderSession && isPdfWebsiteSpaceToggleKey(event) && !isEditableTarget(event.target)) {
      if (isPdfWebsiteAnyStopActive()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      togglePdfWebsiteReaderPlayback();
      return;
    }

    if (event.key !== "Enter" || isEditableTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (pdfWebsiteReaderSession) {
      if (isPdfWebsiteAnyStopActive()) {
        acknowledgeAndResumePdfWebsiteStop();
        return;
      }

      togglePdfWebsiteReaderPlayback();
      return;
    }

    void startPdfWebsiteReader();
  }

  function handlePdfWebsiteKeyUp(event) {
    if (event.key === "Shift") {
      pdfWebsiteShiftPressed = false;
    }
  }

  function getPdfWebsiteReaderSourceBlocks() {
    const blocks = getPdfWebsiteSelectableBlocks();
    if (blocks.length === 0) {
      return [];
    }

    if (pdfWebsiteSelectedSet.size === 0) {
      return blocks;
    }

    return blocks.filter((block) => pdfWebsiteSelectedSet.has(block));
  }

  function getPdfWebsiteBlockText(block) {
    if (!(block instanceof HTMLElement)) {
      return "";
    }

    const blockType = String(block.dataset.websiteBlockType || "");
    if (blockType === PDF_WEBSITE_BLOCK_TYPE.LIST) {
      const items = Array.from(block.querySelectorAll(".website-list-item"))
        .map((item) => sanitizeFragment(item.textContent || ""))
        .filter(Boolean);
      return sanitizeFragment(items.join(" "));
    }

    return sanitizeFragment(block.textContent || "");
  }

  function tokenizePdfWebsiteReaderWords(text) {
    if (typeof text !== "string") {
      return [];
    }

    return text.trim().split(/\s+/).filter(Boolean);
  }

  function collectPdfWebsiteWordsFromBlocks(blocks) {
    if (!Array.isArray(blocks)) {
      return [];
    }

    const words = [];
    for (const block of blocks) {
      const text = getPdfWebsiteBlockText(block);
      if (!text) {
        continue;
      }

      words.push(...tokenizePdfWebsiteReaderWords(text));
    }

    return words;
  }

  function getPdfWebsiteBlockType(block) {
    if (!(block instanceof HTMLElement)) {
      return PDF_WEBSITE_BLOCK_TYPE.PARAGRAPH;
    }

    const blockType = String(block.dataset.websiteBlockType || "");
    if (
      blockType === PDF_WEBSITE_BLOCK_TYPE.HEADING ||
      blockType === PDF_WEBSITE_BLOCK_TYPE.LIST ||
      blockType === PDF_WEBSITE_BLOCK_TYPE.PARAGRAPH
    ) {
      return blockType;
    }

    return PDF_WEBSITE_BLOCK_TYPE.PARAGRAPH;
  }

  function getPdfWebsiteListItems(block) {
    if (!(block instanceof HTMLElement)) {
      return [];
    }

    return Array.from(block.querySelectorAll(".website-list-item"))
      .map((item) => sanitizeFragment(item.textContent || ""))
      .filter(Boolean);
  }

  function buildPdfWebsiteSemanticBlock(block, startWordIndex) {
    if (!(block instanceof HTMLElement) || !Number.isFinite(startWordIndex) || startWordIndex < 0) {
      return null;
    }

    const type = getPdfWebsiteBlockType(block);
    const text = getPdfWebsiteBlockText(block);
    const words = tokenizePdfWebsiteReaderWords(text);
    if (words.length === 0) {
      return null;
    }

    const endWordIndex = startWordIndex + words.length - 1;
    return {
      type,
      text,
      words,
      startWordIndex,
      endWordIndex,
      listItems: type === PDF_WEBSITE_BLOCK_TYPE.LIST ? getPdfWebsiteListItems(block) : [],
      element: block,
    };
  }

  function buildPdfWebsiteReadingDataFromBlocks(blocks) {
    const words = [];
    const semanticBlocks = [];
    const sourceBlocks = [];

    if (!Array.isArray(blocks)) {
      return { words, semanticBlocks, sourceBlocks, lastSourceBlock: null };
    }

    for (const block of blocks) {
      const semanticBlock = buildPdfWebsiteSemanticBlock(block, words.length);
      if (!semanticBlock) {
        continue;
      }

      words.push(...semanticBlock.words);
      semanticBlocks.push({
        type: semanticBlock.type,
        text: semanticBlock.text,
        startWordIndex: semanticBlock.startWordIndex,
        endWordIndex: semanticBlock.endWordIndex,
        listItems: semanticBlock.listItems,
        element: semanticBlock.element,
      });
      sourceBlocks.push(block);
    }

    return {
      words,
      semanticBlocks,
      sourceBlocks,
      lastSourceBlock: sourceBlocks[sourceBlocks.length - 1] || null,
    };
  }

  async function loadPdfWebsiteReaderPreferences() {
    try {
      const stored = await browser.storage.local.get([
        "defaultWpm",
        "autoContinue",
        "stopBeforeHeader",
        "stopBeforeMedia",
      ]);
      return {
        wpm: normalizePdfWebsiteReaderWpm(stored.defaultWpm),
        autoContinue: typeof stored.autoContinue === "boolean" ? stored.autoContinue : false,
        stopBeforeHeader:
          typeof stored.stopBeforeHeader === "boolean" ? stored.stopBeforeHeader : true,
        stopBeforeMedia:
          typeof stored.stopBeforeMedia === "boolean" ? stored.stopBeforeMedia : true,
      };
    } catch (error) {
      console.debug("Engram PDF reader preferences fallback:", error);
      return {
        wpm: PDF_WEBSITE_READER_DEFAULT_WPM,
        autoContinue: false,
        stopBeforeHeader: true,
        stopBeforeMedia: true,
      };
    }
  }

  async function startPdfWebsiteReader() {
    const sourceBlocks = getPdfWebsiteReaderSourceBlocks();
    if (sourceBlocks.length === 0) {
      setStatus(uploadStatus, "No readable PDF-Website blocks found.", "error");
      return;
    }

    const readingData = buildPdfWebsiteReadingDataFromBlocks(sourceBlocks);
    if (readingData.words.length === 0) {
      setStatus(uploadStatus, "No readable words found in the selected blocks.", "error");
      return;
    }

    const preferences = await loadPdfWebsiteReaderPreferences();
    const allBlocks = getPdfWebsiteSelectableBlocks();

    openPdfWebsiteReader({
      words: readingData.words,
      semanticBlocks: readingData.semanticBlocks,
      sourceBlocks: readingData.sourceBlocks,
      lastSourceBlock: readingData.lastSourceBlock,
      allBlocks,
      preferences,
    });

    const autoContinueHint = preferences.autoContinue ? " Auto-continue is enabled." : "";
    if (pdfWebsiteSelectedSet.size === 0) {
      setStatus(uploadStatus, `PDF-Website reader started from beginning.${autoContinueHint}`, "success");
      return;
    }

    const blockLabel = sourceBlocks.length === 1 ? "block" : "blocks";
    setStatus(
      uploadStatus,
      `PDF-Website reader started from ${readingData.sourceBlocks.length} selected ${blockLabel}.${autoContinueHint}`,
      "success",
    );
  }

  function openPdfWebsiteReader({
    words,
    semanticBlocks,
    sourceBlocks,
    lastSourceBlock,
    allBlocks,
    preferences,
  }) {
    stopPdfWebsiteReader();

    const normalizedWords = Array.isArray(words) ? words.slice() : [];
    const normalizedSemanticBlocks = Array.isArray(semanticBlocks) ? semanticBlocks.slice() : [];
    const normalizedSourceBlocks = Array.isArray(sourceBlocks) ? sourceBlocks.slice() : [];
    const normalizedAllBlocks = Array.isArray(allBlocks) ? allBlocks.slice() : [];

    const overlayRoot = document.createElement("div");
    overlayRoot.id = "swift-read-overlay";
    overlayRoot.tabIndex = -1;
    overlayRoot.setAttribute("role", "dialog");
    overlayRoot.setAttribute("aria-modal", "true");
    overlayRoot.setAttribute("aria-label", "Engram reader");

    const modalShell = document.createElement("div");
    modalShell.className = "swift-read-modal-shell";

    const panel = document.createElement("div");
    panel.className = "swift-read-panel";

    const wordDisplay = document.createElement("div");
    wordDisplay.id = "swift-read-word-display";

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
    wpmSlider.min = String(PDF_WEBSITE_READER_MIN_WPM);
    wpmSlider.max = String(PDF_WEBSITE_READER_MAX_WPM);
    wpmSlider.step = "10";

    const wpmValue = document.createElement("span");
    wpmValue.id = "swift-read-wpm-value";

    speedControl.append(speedLabel, wpmSlider, wpmValue);

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

    progressWrap.append(progressBar, progressText, autoContinueNote);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "swift-read-control-button swift-read-close-button";
    closeButton.id = "swift-read-close";
    closeButton.textContent = "Close";

    controls.append(playPauseButton, rewindButton, speedControl, progressWrap, closeButton);
    panel.append(wordDisplay, controls);
    modalShell.append(panel);
    overlayRoot.append(modalShell);
    document.body.append(overlayRoot);

    pdfWebsiteReaderSession = {
      words: normalizedWords,
      initialWordsCount: normalizedWords.length,
      currentIndex: 0,
      currentWpm: normalizePdfWebsiteReaderWpm(preferences?.wpm),
      isPlaying: true,
      autoContinueEnabled: Boolean(preferences?.autoContinue),
      autoContinueStarted: false,
      stopBeforeHeaderEnabled: Boolean(preferences?.stopBeforeHeader),
      stopBeforeMediaEnabled: Boolean(preferences?.stopBeforeMedia),
      semanticBlocks: normalizedSemanticBlocks,
      sourceBlocks: normalizedSourceBlocks,
      allBlocks: normalizedAllBlocks,
      lastSourceBlock:
        lastSourceBlock instanceof HTMLElement
          ? lastSourceBlock
          : (normalizedSourceBlocks[normalizedSourceBlocks.length - 1] || null),
      blockedHeaderBoundaryIndex: null,
      releasedHeaderBoundaryIndex: null,
      pendingRuleBStop: null,
      releasedRuleBBoundarySignature: null,
      resumeFromAcknowledgedListStop: false,
      timerId: null,
      nextTickAt: null,
      overlayRoot,
      ui: {
        modalShell,
        panel,
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
      },
    };

    playPauseButton.addEventListener("click", () => {
      if (isPdfWebsiteAnyStopActive()) {
        return;
      }
      togglePdfWebsiteReaderPlayback();
    });

    rewindButton.addEventListener("click", () => {
      if (!pdfWebsiteReaderSession) {
        return;
      }

      pdfWebsiteReaderSession.currentIndex = Math.max(0, pdfWebsiteReaderSession.currentIndex - 10);
      renderPdfWebsiteReaderWord();
      updatePdfWebsiteReaderProgressUi();
      if (pdfWebsiteReaderSession.isPlaying) {
        restartPdfWebsiteReaderTimerFromNow();
      }
    });

    wpmSlider.addEventListener("input", () => {
      if (!pdfWebsiteReaderSession) {
        return;
      }

      pdfWebsiteReaderSession.currentWpm = normalizePdfWebsiteReaderWpm(wpmSlider.value);
      syncPdfWebsiteReaderWpmUi();
      if (pdfWebsiteReaderSession.isPlaying) {
        restartPdfWebsiteReaderTimerFromNow();
      }
    });

    progressBar.addEventListener("input", handlePdfWebsiteReaderProgressInput);
    progressBar.addEventListener("change", handlePdfWebsiteReaderProgressInput);

    closeButton.addEventListener("click", () => {
      stopPdfWebsiteReader();
    });

    syncPdfWebsiteReaderWpmUi();
    renderPdfWebsiteReaderWord();
    updatePdfWebsiteReaderProgressUi();
    updatePdfWebsiteReaderPlayPauseUi();
    if (!maybeActivateInitialPdfWebsiteRuleBStop()) {
      startPdfWebsiteReaderPlayback();
    }
    focusPdfWebsiteReaderOverlay();
  }

  function focusPdfWebsiteReaderOverlay() {
    const overlayRoot = pdfWebsiteReaderSession?.overlayRoot;
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

  function renderPdfWebsiteReaderWord() {
    if (!pdfWebsiteReaderSession?.ui?.wordDisplay) {
      return;
    }

    const wordDisplay = pdfWebsiteReaderSession.ui.wordDisplay;
    const ruleBStopPreview = getPdfWebsiteRuleBStopPreview();
    if (ruleBStopPreview) {
      renderPdfWebsiteRuleBStopInWordDisplay(ruleBStopPreview);
      return;
    }

    const headerBoundaryPreview = getPdfWebsiteHeaderBoundaryPreview();
    if (headerBoundaryPreview) {
      wordDisplay.classList.remove("swift-read-word-display-rule-b-stop");
      wordDisplay.classList.add("swift-read-word-display-header-stop");
      wordDisplay.style.setProperty(
        "--swift-read-header-preview-size",
        `${getPdfWebsiteHeaderPreviewFontSizePx(headerBoundaryPreview.headerText)}px`,
      );
      wordDisplay.innerHTML = createPdfWebsiteHeaderBoundaryMarkup(headerBoundaryPreview.headerText);
      return;
    }

    wordDisplay.classList.remove("swift-read-word-display-rule-b-stop");
    wordDisplay.classList.remove("swift-read-word-display-header-stop");
    wordDisplay.style.removeProperty("--swift-read-header-preview-size");

    const words = Array.isArray(pdfWebsiteReaderSession.words) ? pdfWebsiteReaderSession.words : [];
    if (words.length === 0) {
      wordDisplay.textContent = "";
      return;
    }

    const safeIndex = Math.min(words.length - 1, Math.max(0, pdfWebsiteReaderSession.currentIndex));
    pdfWebsiteReaderSession.currentIndex = safeIndex;
    const word = words[safeIndex] || "";
    wordDisplay.innerHTML = createPdfWebsiteOrpMarkup(word);
  }

  function syncPdfWebsiteReaderWpmUi() {
    if (!pdfWebsiteReaderSession?.ui) {
      return;
    }

    const wpm = normalizePdfWebsiteReaderWpm(pdfWebsiteReaderSession.currentWpm);
    pdfWebsiteReaderSession.currentWpm = wpm;
    pdfWebsiteReaderSession.ui.wpmSlider.value = String(wpm);
    pdfWebsiteReaderSession.ui.wpmValue.textContent = `${wpm} WPM`;
  }

  function updatePdfWebsiteReaderPlayPauseUi() {
    if (!pdfWebsiteReaderSession?.ui?.playPauseButton) {
      return;
    }

    const button = pdfWebsiteReaderSession.ui.playPauseButton;
    if (isPdfWebsiteAnyStopActive()) {
      button.textContent = "Enter ↵";
      button.classList.add("swift-read-play-pause-stop-active");
      button.disabled = true;
      return;
    }

    button.classList.remove("swift-read-play-pause-stop-active");
    button.disabled = false;
    button.textContent = pdfWebsiteReaderSession.isPlaying ? "Pause" : "Play";
  }

  function isPdfWebsiteRuleBStopActive() {
    return Boolean(pdfWebsiteReaderSession && !pdfWebsiteReaderSession.isPlaying && pdfWebsiteReaderSession.pendingRuleBStop);
  }

  function getPdfWebsiteRuleBStopPreview() {
    if (!isPdfWebsiteRuleBStopActive()) {
      return null;
    }

    return pdfWebsiteReaderSession.pendingRuleBStop;
  }

  function renderPdfWebsiteRuleBStopInWordDisplay(stopEntry) {
    if (!pdfWebsiteReaderSession?.ui?.wordDisplay || !stopEntry || typeof stopEntry !== "object") {
      return;
    }

    const wordDisplay = pdfWebsiteReaderSession.ui.wordDisplay;
    wordDisplay.classList.remove("swift-read-word-display-header-stop");
    wordDisplay.classList.add("swift-read-word-display-rule-b-stop");
    wordDisplay.style.removeProperty("--swift-read-header-preview-size");
    wordDisplay.replaceChildren();

    const note = document.createElement("span");
    note.className = "swift-read-rule-b-stop-note";
    note.textContent = `${stopEntry.title ?? "Checkpoint"} • Press Enter to continue`;

    if (Array.isArray(stopEntry.listItems) && stopEntry.listItems.length > 0) {
      const list = document.createElement("ul");
      list.className = "swift-read-rule-b-stop-list";
      for (const listItemText of stopEntry.listItems.slice(0, 10)) {
        const item = document.createElement("li");
        item.textContent = listItemText;
        list.append(item);
      }
      wordDisplay.append(note, list);
      return;
    }

    const textPreview = document.createElement("p");
    textPreview.className = "swift-read-rule-b-stop-text";
    textPreview.textContent = stopEntry.previewText || "Checkpoint";
    wordDisplay.append(note, textPreview);
  }

  function findUpcomingPdfWebsiteBoundary(currentWordIndex) {
    if (!pdfWebsiteReaderSession || !Array.isArray(pdfWebsiteReaderSession.semanticBlocks)) {
      return null;
    }

    const blocks = pdfWebsiteReaderSession.semanticBlocks;
    for (let index = 0; index < blocks.length - 1; index += 1) {
      const currentBlock = blocks[index];
      const nextBlock = blocks[index + 1];
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
        nextBlockIndex: index + 1,
      };
    }

    return null;
  }

  function isPdfWebsiteListBlock(block) {
    if (!block || typeof block !== "object") {
      return false;
    }

    return block.type === PDF_WEBSITE_BLOCK_TYPE.LIST;
  }

  function getPdfWebsiteHeaderBoundaryPreview() {
    if (!pdfWebsiteReaderSession || pdfWebsiteReaderSession.isPlaying) {
      return null;
    }

    const boundaryIndex = Number(pdfWebsiteReaderSession.blockedHeaderBoundaryIndex);
    if (!Number.isFinite(boundaryIndex) || boundaryIndex !== pdfWebsiteReaderSession.currentIndex) {
      return null;
    }

    const boundary = findUpcomingPdfWebsiteBoundary(boundaryIndex);
    if (!boundary || boundary.nextBlock.type !== PDF_WEBSITE_BLOCK_TYPE.HEADING) {
      return null;
    }

    return {
      boundaryIndex,
      headerText: sanitizeFragment(boundary.nextBlock.text || ""),
    };
  }

  function isPdfWebsiteHeaderBoundaryStopActive() {
    return Boolean(getPdfWebsiteHeaderBoundaryPreview());
  }

  function isPdfWebsiteAnyStopActive() {
    return isPdfWebsiteHeaderBoundaryStopActive() || isPdfWebsiteRuleBStopActive();
  }

  function createPdfWebsiteHeaderBoundaryMarkup(headerText) {
    const safeHeaderText = escapeHtmlForPdfWebsiteReader(sanitizeFragment(headerText) || "Next section");
    return `
      <span class="swift-read-header-stop-note">Next Chapter, press Enter to continue</span>
      <span class="swift-read-header-stop-text">${safeHeaderText}</span>
    `;
  }

  function getPdfWebsiteHeaderPreviewFontSizePx(headerText) {
    const safeLength = String(headerText || "").length;
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

  function tryStopBeforePdfWebsiteHeaderBoundary() {
    if (!pdfWebsiteReaderSession || !pdfWebsiteReaderSession.stopBeforeHeaderEnabled) {
      return false;
    }

    const boundary = findUpcomingPdfWebsiteBoundary(pdfWebsiteReaderSession.currentIndex);
    if (!boundary || boundary.nextBlock.type !== PDF_WEBSITE_BLOCK_TYPE.HEADING) {
      return false;
    }

    if (pdfWebsiteReaderSession.releasedHeaderBoundaryIndex === boundary.boundaryIndex) {
      pdfWebsiteReaderSession.releasedHeaderBoundaryIndex = null;
      pdfWebsiteReaderSession.blockedHeaderBoundaryIndex = null;
      return false;
    }

    pdfWebsiteReaderSession.blockedHeaderBoundaryIndex = boundary.boundaryIndex;
    pdfWebsiteReaderSession.isPlaying = false;
    updatePdfWebsiteReaderPlayPauseUi();
    clearPdfWebsiteReaderTimer();
    renderPdfWebsiteReaderWord();
    focusPdfWebsiteReaderOverlay();
    return true;
  }

  function tryStopBeforePdfWebsiteRuleBBoundary() {
    if (
      !pdfWebsiteReaderSession ||
      !pdfWebsiteReaderSession.stopBeforeMediaEnabled ||
      pdfWebsiteReaderSession.pendingRuleBStop
    ) {
      return false;
    }

    const boundary = findUpcomingPdfWebsiteBoundary(pdfWebsiteReaderSession.currentIndex);
    if (!boundary || boundary.nextBlock.type !== PDF_WEBSITE_BLOCK_TYPE.LIST) {
      return false;
    }

    const signature = `pdf:list:${boundary.boundaryIndex}:${boundary.nextBlockIndex}`;
    if (
      pdfWebsiteReaderSession.releasedRuleBBoundarySignature &&
      pdfWebsiteReaderSession.releasedRuleBBoundarySignature === signature
    ) {
      pdfWebsiteReaderSession.releasedRuleBBoundarySignature = null;
      return false;
    }

    activatePdfWebsiteRuleBStop({
      kind: "list",
      title: "List checkpoint",
      previewText: boundary.nextBlock.text || "List checkpoint",
      listItems: Array.isArray(boundary.nextBlock.listItems) ? boundary.nextBlock.listItems : [],
      signature,
      source: "semantic-boundary",
      nextBlockIndex: boundary.nextBlockIndex,
    });
    return true;
  }

  function maybeActivateInitialPdfWebsiteRuleBStop() {
    if (
      !pdfWebsiteReaderSession ||
      !pdfWebsiteReaderSession.stopBeforeMediaEnabled ||
      pdfWebsiteReaderSession.pendingRuleBStop
    ) {
      return false;
    }

    const semanticBlocks = Array.isArray(pdfWebsiteReaderSession.semanticBlocks)
      ? pdfWebsiteReaderSession.semanticBlocks
      : [];
    const firstBlock = semanticBlocks[0];
    if (!isPdfWebsiteListBlock(firstBlock)) {
      return false;
    }

    const firstBlockStart = Number(firstBlock.startWordIndex);
    const boundaryIndex = Number.isFinite(firstBlockStart) ? firstBlockStart : 0;
    activatePdfWebsiteRuleBStop({
      kind: "list",
      title: "List checkpoint",
      previewText: firstBlock.text || "List checkpoint",
      listItems: Array.isArray(firstBlock.listItems) ? firstBlock.listItems : [],
      signature: `pdf:list:initial:${boundaryIndex}`,
      source: "semantic-boundary",
      nextBlockIndex: 0,
    });
    return true;
  }

  function activatePdfWebsiteRuleBStop(stopEntry) {
    if (!pdfWebsiteReaderSession || !stopEntry || typeof stopEntry !== "object") {
      return;
    }

    pdfWebsiteReaderSession.pendingRuleBStop = {
      ...stopEntry,
      pending: true,
    };
    pdfWebsiteReaderSession.isPlaying = false;
    updatePdfWebsiteReaderPlayPauseUi();
    clearPdfWebsiteReaderTimer();
    renderPdfWebsiteReaderWord();
    focusPdfWebsiteReaderOverlay();
  }

  function maybeSkipPdfWebsiteListWordsAfterCheckpoint(stopEntry) {
    if (
      !pdfWebsiteReaderSession ||
      !stopEntry ||
      stopEntry.kind !== "list" ||
      stopEntry.source !== "semantic-boundary"
    ) {
      return false;
    }

    const skipRange = findPdfWebsiteListSkipRangeForCheckpoint(stopEntry);
    if (!skipRange) {
      return false;
    }

    const totalWords = Array.isArray(pdfWebsiteReaderSession.words)
      ? pdfWebsiteReaderSession.words.length
      : 0;
    if (totalWords === 0) {
      return false;
    }

    const endWordIndex = Number(skipRange.endWordIndex);
    if (!Number.isFinite(endWordIndex) || endWordIndex < pdfWebsiteReaderSession.currentIndex) {
      return false;
    }

    pdfWebsiteReaderSession.currentIndex = Math.min(totalWords - 1, endWordIndex);
    return true;
  }

  function findPdfWebsiteListSkipRangeForCheckpoint(stopEntry) {
    if (!pdfWebsiteReaderSession || !Array.isArray(pdfWebsiteReaderSession.semanticBlocks)) {
      return null;
    }

    const semanticBlocks = pdfWebsiteReaderSession.semanticBlocks;
    let startBlockIndex = Number.parseInt(String(stopEntry.nextBlockIndex), 10);
    if (
      !Number.isInteger(startBlockIndex) ||
      startBlockIndex < 0 ||
      startBlockIndex >= semanticBlocks.length ||
      !isPdfWebsiteListBlock(semanticBlocks[startBlockIndex])
    ) {
      startBlockIndex = -1;
    }

    if (startBlockIndex < 0) {
      const currentWordIndex = Number(pdfWebsiteReaderSession.currentIndex);
      for (let index = 0; index < semanticBlocks.length; index += 1) {
        const block = semanticBlocks[index];
        if (!isPdfWebsiteListBlock(block)) {
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
      if (!isPdfWebsiteListBlock(semanticBlocks[index])) {
        break;
      }
      endBlockIndex = index;
    }

    const endBlock = semanticBlocks[endBlockIndex];
    const endWordIndex = Number(endBlock?.endWordIndex);
    if (!Number.isFinite(endWordIndex)) {
      return null;
    }

    return { endWordIndex };
  }

  function acknowledgeAndResumePdfWebsiteStop() {
    if (!pdfWebsiteReaderSession || !isPdfWebsiteAnyStopActive()) {
      return;
    }

    if (isPdfWebsiteHeaderBoundaryStopActive()) {
      pdfWebsiteReaderSession.releasedHeaderBoundaryIndex = pdfWebsiteReaderSession.currentIndex;
      pdfWebsiteReaderSession.blockedHeaderBoundaryIndex = null;
    }

    if (pdfWebsiteReaderSession.pendingRuleBStop) {
      const pendingStop = pdfWebsiteReaderSession.pendingRuleBStop;
      if (pdfWebsiteReaderSession.pendingRuleBStop.signature) {
        pdfWebsiteReaderSession.releasedRuleBBoundarySignature = pdfWebsiteReaderSession.pendingRuleBStop.signature;
      }
      const skippedListWords = maybeSkipPdfWebsiteListWordsAfterCheckpoint(pendingStop);
      pdfWebsiteReaderSession.resumeFromAcknowledgedListStop = skippedListWords;
      pdfWebsiteReaderSession.pendingRuleBStop = null;
      if (skippedListWords) {
        updatePdfWebsiteReaderProgressUi();
      }
    }

    renderPdfWebsiteReaderWord();
    pdfWebsiteReaderSession.isPlaying = true;
    updatePdfWebsiteReaderPlayPauseUi();

    if (pdfWebsiteReaderSession.resumeFromAcknowledgedListStop) {
      pdfWebsiteReaderSession.resumeFromAcknowledgedListStop = false;
      onPdfWebsiteReaderTick(Date.now());
      return;
    }

    startPdfWebsiteReaderPlayback();
  }

  function isPdfWebsiteAutoContinueVisualStateActive() {
    return Boolean(
      pdfWebsiteReaderSession &&
      pdfWebsiteReaderSession.autoContinueEnabled &&
      pdfWebsiteReaderSession.autoContinueStarted,
    );
  }

  function updatePdfWebsiteReaderProgressUi() {
    if (!pdfWebsiteReaderSession?.ui) {
      return;
    }

    const session = pdfWebsiteReaderSession;
    if (isPdfWebsiteAutoContinueVisualStateActive()) {
      const frozenTotal = Math.max(1, session.initialWordsCount || session.words.length);
      session.ui.progressBar.max = String(frozenTotal - 1);
      session.ui.progressBar.value = String(frozenTotal - 1);
      session.ui.progressWrap.classList.add("swift-read-progress-wrap-auto-continue");
      session.ui.progressBar.classList.add("swift-read-progress-auto-continue");
      session.ui.progressText.textContent = `${frozenTotal} / ${frozenTotal}`;
      return;
    }

    const total = Array.isArray(session.words) ? session.words.length : 0;
    const safeTotal = Math.max(1, total);
    const clampedIndex = Math.min(safeTotal - 1, Math.max(0, session.currentIndex));
    const current = total === 0 ? 0 : clampedIndex + 1;

    session.ui.progressBar.max = String(safeTotal - 1);
    session.ui.progressBar.value = String(clampedIndex);
    session.ui.progressWrap.classList.remove("swift-read-progress-wrap-auto-continue");
    session.ui.progressBar.classList.remove("swift-read-progress-auto-continue");
    session.ui.progressText.textContent = `${current} / ${total}`;
  }

  function getPdfWebsiteCurrentIntervalMs() {
    if (!pdfWebsiteReaderSession) {
      return 60000 / PDF_WEBSITE_READER_DEFAULT_WPM;
    }

    const wpm = normalizePdfWebsiteReaderWpm(pdfWebsiteReaderSession.currentWpm);
    return 60000 / wpm;
  }

  function clearPdfWebsiteReaderTimer() {
    if (!pdfWebsiteReaderSession) {
      return;
    }

    if (pdfWebsiteReaderSession.timerId !== null) {
      window.clearTimeout(pdfWebsiteReaderSession.timerId);
      pdfWebsiteReaderSession.timerId = null;
    }
    pdfWebsiteReaderSession.nextTickAt = null;
  }

  function startPdfWebsiteReaderPlayback() {
    if (!pdfWebsiteReaderSession || !pdfWebsiteReaderSession.isPlaying) {
      return;
    }

    if (!Array.isArray(pdfWebsiteReaderSession.words) || pdfWebsiteReaderSession.words.length === 0) {
      pdfWebsiteReaderSession.isPlaying = false;
      updatePdfWebsiteReaderPlayPauseUi();
      return;
    }

    schedulePdfWebsiteReaderTick(Date.now() + getPdfWebsiteCurrentIntervalMs());
  }

  function restartPdfWebsiteReaderTimerFromNow() {
    if (!pdfWebsiteReaderSession || !pdfWebsiteReaderSession.isPlaying) {
      return;
    }

    schedulePdfWebsiteReaderTick(Date.now() + getPdfWebsiteCurrentIntervalMs());
  }

  function schedulePdfWebsiteReaderTick(targetTimeMs) {
    if (!pdfWebsiteReaderSession || !pdfWebsiteReaderSession.isPlaying) {
      return;
    }

    clearPdfWebsiteReaderTimer();

    const delayMs = Math.max(0, targetTimeMs - Date.now());
    pdfWebsiteReaderSession.nextTickAt = targetTimeMs;
    pdfWebsiteReaderSession.timerId = window.setTimeout(() => {
      if (!pdfWebsiteReaderSession) {
        return;
      }

      pdfWebsiteReaderSession.timerId = null;
      onPdfWebsiteReaderTick(targetTimeMs);
    }, delayMs);
  }

  function onPdfWebsiteReaderTick(scheduledTimeMs) {
    if (!pdfWebsiteReaderSession || !pdfWebsiteReaderSession.isPlaying) {
      return;
    }

    const totalWords = Array.isArray(pdfWebsiteReaderSession.words) ? pdfWebsiteReaderSession.words.length : 0;
    if (totalWords === 0) {
      pdfWebsiteReaderSession.isPlaying = false;
      updatePdfWebsiteReaderPlayPauseUi();
      clearPdfWebsiteReaderTimer();
      return;
    }

    if (tryStopBeforePdfWebsiteHeaderBoundary()) {
      return;
    }

    if (tryStopBeforePdfWebsiteRuleBBoundary()) {
      return;
    }

    if (pdfWebsiteReaderSession.currentIndex >= totalWords - 1) {
      if (tryPdfWebsiteAutoContinueOnStreamEnd(scheduledTimeMs)) {
        return;
      }

      pdfWebsiteReaderSession.isPlaying = false;
      updatePdfWebsiteReaderPlayPauseUi();
      clearPdfWebsiteReaderTimer();
      return;
    }

    pdfWebsiteReaderSession.currentIndex += 1;
    if (
      Number.isFinite(pdfWebsiteReaderSession.blockedHeaderBoundaryIndex) &&
      pdfWebsiteReaderSession.currentIndex > pdfWebsiteReaderSession.blockedHeaderBoundaryIndex
    ) {
      pdfWebsiteReaderSession.blockedHeaderBoundaryIndex = null;
      pdfWebsiteReaderSession.releasedHeaderBoundaryIndex = null;
    }
    if (pdfWebsiteReaderSession.releasedRuleBBoundarySignature) {
      pdfWebsiteReaderSession.releasedRuleBBoundarySignature = null;
    }
    renderPdfWebsiteReaderWord();
    updatePdfWebsiteReaderProgressUi();

    const nextIntervalMs = getPdfWebsiteCurrentIntervalMs();
    const minScheduleTime = Date.now() + 1;
    const nextTargetTime = Math.max(minScheduleTime, scheduledTimeMs + nextIntervalMs);
    schedulePdfWebsiteReaderTick(nextTargetTime);
  }

  function findNextPdfWebsiteAutoContinueBlock(lastBlock, allBlocks) {
    if (!Array.isArray(allBlocks) || allBlocks.length === 0) {
      return null;
    }

    if (!(lastBlock instanceof HTMLElement)) {
      return allBlocks[0] instanceof HTMLElement ? allBlocks[0] : null;
    }

    const lastIndex = allBlocks.indexOf(lastBlock);
    if (lastIndex < 0) {
      return null;
    }

    for (let index = lastIndex + 1; index < allBlocks.length; index += 1) {
      const candidate = allBlocks[index];
      if (candidate instanceof HTMLElement) {
        return candidate;
      }
    }

    return null;
  }

  function appendPdfWebsiteBlockToReaderSession(block) {
    if (!pdfWebsiteReaderSession || !(block instanceof HTMLElement)) {
      return false;
    }

    const startWordIndex = Array.isArray(pdfWebsiteReaderSession.words)
      ? pdfWebsiteReaderSession.words.length
      : 0;
    const semanticBlock = buildPdfWebsiteSemanticBlock(block, startWordIndex);
    if (!semanticBlock) {
      return false;
    }

    pdfWebsiteReaderSession.words.push(...semanticBlock.words);
    pdfWebsiteReaderSession.semanticBlocks.push({
      type: semanticBlock.type,
      text: semanticBlock.text,
      startWordIndex: semanticBlock.startWordIndex,
      endWordIndex: semanticBlock.endWordIndex,
      listItems: semanticBlock.listItems,
      element: semanticBlock.element,
    });
    return true;
  }

  function tryPdfWebsiteAutoContinueOnStreamEnd(scheduledTimeMs) {
    if (!pdfWebsiteReaderSession || !pdfWebsiteReaderSession.autoContinueEnabled) {
      return false;
    }

    let nextBlock = findNextPdfWebsiteAutoContinueBlock(
      pdfWebsiteReaderSession.lastSourceBlock,
      pdfWebsiteReaderSession.allBlocks,
    );

    while (nextBlock instanceof HTMLElement) {
      pdfWebsiteReaderSession.lastSourceBlock = nextBlock;
      const didAppend = appendPdfWebsiteBlockToReaderSession(nextBlock);
      if (didAppend) {
        pdfWebsiteReaderSession.sourceBlocks.push(nextBlock);
        pdfWebsiteReaderSession.autoContinueStarted = true;
        updatePdfWebsiteReaderProgressUi();

        const nextIntervalMs = getPdfWebsiteCurrentIntervalMs();
        const minScheduleTime = Date.now() + 1;
        const nextTargetTime = Math.max(minScheduleTime, scheduledTimeMs + nextIntervalMs);
        schedulePdfWebsiteReaderTick(nextTargetTime);
        return true;
      }

      nextBlock = findNextPdfWebsiteAutoContinueBlock(
        pdfWebsiteReaderSession.lastSourceBlock,
        pdfWebsiteReaderSession.allBlocks,
      );
    }

    return false;
  }

  function handlePdfWebsiteReaderProgressInput(event) {
    if (!pdfWebsiteReaderSession || isPdfWebsiteAutoContinueVisualStateActive()) {
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

    seekPdfWebsiteReaderWordIndex(nextIndex);
  }

  function seekPdfWebsiteReaderWordIndex(nextIndex) {
    if (!pdfWebsiteReaderSession) {
      return;
    }

    const totalWords = Array.isArray(pdfWebsiteReaderSession.words)
      ? pdfWebsiteReaderSession.words.length
      : 0;
    if (totalWords === 0) {
      return;
    }

    const numericNext = Number(nextIndex);
    pdfWebsiteReaderSession.currentIndex = Math.min(totalWords - 1, Math.max(0, numericNext));
    if (
      Number.isFinite(pdfWebsiteReaderSession.blockedHeaderBoundaryIndex) &&
      pdfWebsiteReaderSession.blockedHeaderBoundaryIndex !== pdfWebsiteReaderSession.currentIndex
    ) {
      pdfWebsiteReaderSession.blockedHeaderBoundaryIndex = null;
    }
    pdfWebsiteReaderSession.releasedHeaderBoundaryIndex = null;
    pdfWebsiteReaderSession.pendingRuleBStop = null;
    pdfWebsiteReaderSession.releasedRuleBBoundarySignature = null;
    pdfWebsiteReaderSession.resumeFromAcknowledgedListStop = false;
    renderPdfWebsiteReaderWord();
    updatePdfWebsiteReaderProgressUi();

    if (pdfWebsiteReaderSession.isPlaying) {
      restartPdfWebsiteReaderTimerFromNow();
    }
  }

  function togglePdfWebsiteReaderPlayback() {
    if (!pdfWebsiteReaderSession) {
      return;
    }

    if (isPdfWebsiteAnyStopActive()) {
      return;
    }

    if (
      !pdfWebsiteReaderSession.isPlaying &&
      pdfWebsiteReaderSession.currentIndex >= pdfWebsiteReaderSession.words.length - 1
    ) {
      pdfWebsiteReaderSession.currentIndex = 0;
      pdfWebsiteReaderSession.autoContinueStarted = false;
      pdfWebsiteReaderSession.resumeFromAcknowledgedListStop = false;
      renderPdfWebsiteReaderWord();
      updatePdfWebsiteReaderProgressUi();
    }

    pdfWebsiteReaderSession.isPlaying = !pdfWebsiteReaderSession.isPlaying;
    updatePdfWebsiteReaderPlayPauseUi();
    if (pdfWebsiteReaderSession.isPlaying) {
      startPdfWebsiteReaderPlayback();
      return;
    }

    clearPdfWebsiteReaderTimer();
  }

  function stopPdfWebsiteReader() {
    if (!pdfWebsiteReaderSession) {
      return;
    }

    clearPdfWebsiteReaderTimer();
    if (pdfWebsiteReaderSession.overlayRoot instanceof HTMLElement) {
      pdfWebsiteReaderSession.overlayRoot.remove();
    }

    pdfWebsiteReaderSession = null;
  }

  async function parseAndRenderActiveFile() {
    if (!(uploadedFile instanceof File)) {
      return;
    }

    parseToken += 1;
    const runToken = parseToken;
    stopPdfWebsiteReader();
    resetPdfWebsiteInteractionState();
    parsedTextRoot.replaceChildren();

    const modeLabel = getModeDisplayName();
    setStatus(uploadStatus, `Document uploaded. Parsing ${modeLabel} text...`, "success");

    try {
      const result = await extractPdfPagesAsPdfWebsiteBlocks(uploadedFile);
      if (runToken !== parseToken) {
        return;
      }
      renderPdfWebsitePages(parsedTextRoot, result.pages, result.dominantFontSize);

      // Legacy extraction options intentionally disabled:
      // semantic -> extractPdfPagesAsSemanticBlocks() + renderSemanticPages()
      // layout-aware -> extractPdfPagesAsLayoutAwareBlocks() + renderLayoutAwarePages()
      // OCR -> extractPdfPagesAsOcrBlocks() + renderOcrPages()

      setStatus(
        uploadStatus,
        "Document uploaded. Click blocks to select, Shift+hover adds, Enter starts reading.",
        "success",
      );
    } catch (error) {
      if (runToken !== parseToken) {
        return;
      }

      console.error("Engram PDF parse failed:", error);
      setStatus(uploadStatus, "Could not parse PDF text.", "error");
    }
  }

  uploadButton.addEventListener("click", () => {
    uploadInput.click();
  });

  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    if (!file) {
      return;
    }

    if (!isPdfFile(file)) {
      setStatus(uploadStatus, "Please select a valid PDF file.", "error");
      return;
    }

    uploadedFile = file;
    await parseAndRenderActiveFile();
  });

  parsedTextRoot.addEventListener("mouseover", handlePdfWebsiteMouseOver, true);
  parsedTextRoot.addEventListener("mouseout", handlePdfWebsiteMouseOut, true);
  parsedTextRoot.addEventListener("click", handlePdfWebsiteClick, true);
  document.addEventListener("keydown", handlePdfWebsiteKeyDown, true);
  document.addEventListener("keyup", handlePdfWebsiteKeyUp, true);

  modePdfWebsiteButton.addEventListener("click", () => {
    // PDF-Website is now the only active mode.
    setStatus(uploadStatus, "PDF-Website mode active. Upload a PDF, then press Enter to read.", "neutral");
  });

  // Legacy mode-switch handlers intentionally disabled:
  // modeSemanticButton.addEventListener(...)
  // modeLayoutButton.addEventListener(...)
  // modeOcrButton.addEventListener(...)

  syncModeButtons();
});

function getModeDisplayName() {
  return "PDF-Website";
  // Legacy labels intentionally disabled:
  // if (mode === EXTRACTION_MODE.SEMANTIC) return "semantic";
  // if (mode === EXTRACTION_MODE.LAYOUT) return "layout-aware";
  // if (mode === EXTRACTION_MODE.OCR) return "OCR";
}

function setStatus(uploadStatus, message, type = "neutral") {
  if (!(uploadStatus instanceof HTMLElement)) {
    return;
  }

  uploadStatus.textContent = message;
  uploadStatus.classList.remove("success", "error");

  if (type === "success") {
    uploadStatus.classList.add("success");
  } else if (type === "error") {
    uploadStatus.classList.add("error");
  }
}

function normalizePdfWebsiteReaderWpm(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return PDF_WEBSITE_READER_DEFAULT_WPM;
  }

  return Math.min(
    PDF_WEBSITE_READER_MAX_WPM,
    Math.max(PDF_WEBSITE_READER_MIN_WPM, parsed),
  );
}

function createPdfWebsiteOrpMarkup(word) {
  const safeWord = String(word || "");
  if (!safeWord) {
    return "&nbsp;";
  }

  const pivotIndex = getPdfWebsitePivotIndex(safeWord.length);
  const safePivotIndex = Math.min(Math.max(0, pivotIndex), safeWord.length - 1);
  const before = escapeHtmlForPdfWebsiteReader(safeWord.slice(0, safePivotIndex));
  const pivot = escapeHtmlForPdfWebsiteReader(safeWord.charAt(safePivotIndex));
  const after = escapeHtmlForPdfWebsiteReader(safeWord.slice(safePivotIndex + 1));
  return `${before}<span class="pivot-char">${pivot}</span>${after}`;
}

function isPdfWebsiteSpaceToggleKey(event) {
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

function getPdfWebsitePivotIndex(wordLength) {
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

function escapeHtmlForPdfWebsiteReader(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isPdfFile(file) {
  if (!(file instanceof File)) {
    return false;
  }

  const lowerName = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return lowerName.endsWith(".pdf") || type === "application/pdf";
}

async function extractPdfPagesAsSemanticBlocks(file) {
  const buffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(buffer);
  const pdfDocument = await globalThis.pdfjsLib.getDocument({ data: uint8Array }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const semanticBlocks = extractSemanticBlocksFromPage(textContent);
    if (semanticBlocks.length > 0) {
      pages.push({
        pageNumber,
        blocks: semanticBlocks,
      });
    }
  }

  return pages;
}

async function extractPdfPagesAsLayoutAwareBlocks(file) {
  const buffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(buffer);
  const pdfDocument = await globalThis.pdfjsLib.getDocument({ data: uint8Array }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const layoutBlocks = extractLayoutBlocksFromPage(textContent);
    if (layoutBlocks.length > 0) {
      pages.push({
        pageNumber,
        blocks: layoutBlocks,
      });
    }
  }

  return pages;
}

async function extractPdfPagesAsPdfWebsiteBlocks(file) {
  const buffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(buffer);
  const pdfDocument = await globalThis.pdfjsLib.getDocument({ data: uint8Array }).promise;
  const pageLines = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = buildLinesFromTextItems(textContent?.items || []);
    pageLines.push({ pageNumber, lines });
  }

  const dominantFontSize = determineDominantFontSize(pageLines.map((page) => page.lines));
  const pages = [];

  for (const page of pageLines) {
    const blocks = buildPdfWebsiteBlocksFromLines(page.lines, dominantFontSize);
    if (blocks.length === 0) {
      continue;
    }

    pages.push({
      pageNumber: page.pageNumber,
      blocks,
    });
  }

  const mergedPages = mergePdfWebsitePageContinuations(pages);
  return { pages: mergedPages, dominantFontSize };
}

async function extractPdfPagesAsOcrBlocks(file) {
  const ocrEngine = getOcrEngine();
  if (!ocrEngine) {
    throw new Error("OCR engine unavailable");
  }

  const buffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(buffer);
  const pdfDocument = await globalThis.pdfjsLib.getDocument({ data: uint8Array }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const ocrText = await runOcrOnPage(page, ocrEngine);
    if (ocrText) {
      pages.push({
        pageNumber,
        blocks: [
          {
            type: OCR_BLOCK_TYPE,
            text: ocrText,
          },
        ],
      });
    }
  }

  return pages;
}

function extractSemanticBlocksFromPage(textContent) {
  const items = Array.isArray(textContent?.items) ? textContent.items : [];
  if (items.length === 0) {
    return [];
  }

  const lines = buildLinesFromTextItems(items);
  if (lines.length === 0) {
    return [];
  }

  const pageStats = buildPageStats(lines);
  return buildSemanticBlocksFromLines(lines, pageStats);
}

function extractLayoutBlocksFromPage(textContent) {
  const items = Array.isArray(textContent?.items) ? textContent.items : [];
  if (items.length === 0) {
    return [];
  }

  const lines = buildLinesFromTextItems(items);
  if (lines.length === 0) {
    return [];
  }

  return buildLayoutBlocksFromLines(lines);
}

async function runOcrOnPage(page, ocrEngine) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return "";
  }

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  // Light preprocessing for OCR clarity.
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const luminance = (r * 0.299) + (g * 0.587) + (b * 0.114);
    const normalized = luminance > 160 ? 255 : 0;
    pixels[index] = normalized;
    pixels[index + 1] = normalized;
    pixels[index + 2] = normalized;
  }
  context.putImageData(imageData, 0, 0);

  const raw = ocrEngine(canvas);
  return sanitizeOcrText(raw);
}

function buildLinesFromTextItems(items) {
  const textItems = [];
  for (const item of items) {
    const rawText = typeof item?.str === "string" ? item.str : "";
    const text = sanitizeFragment(rawText);
    if (!text) {
      continue;
    }

    const transform = Array.isArray(item?.transform) ? item.transform : null;
    if (!transform || transform.length < 6) {
      continue;
    }

    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    const fontSize = estimateFontSize(item, transform);
    textItems.push({
      text,
      x,
      y,
      fontSize,
      leadingWhitespace: countLeadingWhitespace(rawText),
    });
  }

  if (textItems.length === 0) {
    return [];
  }

  textItems.sort((a, b) => {
    const yDiff = b.y - a.y;
    if (Math.abs(yDiff) > 0.8) {
      return yDiff;
    }
    return a.x - b.x;
  });

  const lines = [];
  for (const item of textItems) {
    const threshold = Math.max(2, item.fontSize * 0.45);
    let targetLine = null;

    for (const line of lines) {
      if (Math.abs(line.y - item.y) <= threshold) {
        targetLine = line;
        break;
      }
    }

    if (!targetLine) {
      targetLine = { y: item.y, items: [] };
      lines.push(targetLine);
    }

    targetLine.items.push(item);
  }

  const normalizedLines = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    const lineText = joinTextLine(line.items);
    if (!lineText) {
      continue;
    }

    const fontSize = average(line.items.map((item) => item.fontSize));
    const columnCount = estimateColumnCount(line.items, fontSize);
    const firstItem = line.items[0];
    const lastItem = line.items[line.items.length - 1];
    const startX = firstItem.x;
    const endX = lastItem.x + estimateTextWidth(lastItem);

    normalizedLines.push({
      text: lineText,
      y: line.y,
      fontSize,
      columnCount,
      wordCount: countWords(lineText),
      startX,
      endX,
      leadingWhitespace: firstItem.leadingWhitespace || 0,
    });
  }

  normalizedLines.sort((a, b) => b.y - a.y);
  return normalizedLines;
}

function buildPageStats(lines) {
  const fontSizes = lines
    .map((line) => line.fontSize)
    .filter((fontSize) => Number.isFinite(fontSize) && fontSize > 0)
    .sort((a, b) => a - b);

  const medianFontSize =
    fontSizes.length > 0
      ? fontSizes[Math.floor(fontSizes.length / 2)]
      : 11;

  return { medianFontSize };
}

function determineDominantFontSize(linesByPage) {
  if (!Array.isArray(linesByPage) || linesByPage.length === 0) {
    return 11;
  }

  const histogram = new Map();
  for (const lines of linesByPage) {
    if (!Array.isArray(lines)) {
      continue;
    }

    for (const line of lines) {
      const size = Number(line?.fontSize);
      if (!Number.isFinite(size) || size <= 0) {
        continue;
      }

      const bucket = Math.round(size * 2) / 2;
      const count = histogram.get(bucket) || 0;
      histogram.set(bucket, count + 1);
    }
  }

  if (histogram.size === 0) {
    return 11;
  }

  let dominantFontSize = 11;
  let dominantCount = -1;
  for (const [bucket, count] of histogram) {
    if (count > dominantCount || (count === dominantCount && bucket < dominantFontSize)) {
      dominantFontSize = bucket;
      dominantCount = count;
    }
  }

  return dominantFontSize;
}

function buildSemanticBlocksFromLines(lines, pageStats) {
  const blocks = [];
  let paragraphBuffer = [];
  let groupedLineType = null;
  let groupedLines = [];

  function flushParagraphBuffer() {
    if (paragraphBuffer.length === 0) {
      return;
    }

    blocks.push({
      type: SEMANTIC_BLOCK_TYPE.PARAGRAPH,
      text: paragraphBuffer.join(" "),
    });
    paragraphBuffer = [];
  }

  function flushGroupedLines() {
    if (!groupedLineType || groupedLines.length === 0) {
      groupedLineType = null;
      groupedLines = [];
      return;
    }

    blocks.push({
      type: groupedLineType,
      text: groupedLines.join("\n"),
    });
    groupedLineType = null;
    groupedLines = [];
  }

  for (const line of lines) {
    const lineType = classifyLine(line, pageStats);

    if (lineType === SEMANTIC_BLOCK_TYPE.PARAGRAPH) {
      flushGroupedLines();
      paragraphBuffer.push(line.text);
      continue;
    }

    flushParagraphBuffer();

    if (groupedLineType !== lineType) {
      flushGroupedLines();
      groupedLineType = lineType;
    }

    groupedLines.push(line.text);
  }

  flushParagraphBuffer();
  flushGroupedLines();
  return blocks;
}

function buildLayoutBlocksFromLines(lines) {
  const blocks = [];
  let currentLines = [];
  let previousLine = null;

  function flushCurrentLines() {
    if (currentLines.length === 0) {
      return;
    }

    blocks.push(currentLines.join("\n"));
    currentLines = [];
  }

  for (const line of lines) {
    if (!previousLine) {
      currentLines.push(line.text);
      previousLine = line;
      continue;
    }

    const verticalGap = previousLine.y - line.y;
    const averageFont = Math.max(8, average([previousLine.fontSize, line.fontSize]));
    const gapThreshold = Math.max(10, averageFont * 1.6);
    const columnShift = Math.abs(line.startX - previousLine.startX);
    const shiftThreshold = Math.max(42, averageFont * 3.4);

    const startsNewBlock = verticalGap > gapThreshold || columnShift > shiftThreshold;

    if (startsNewBlock) {
      flushCurrentLines();
    }

    currentLines.push(line.text);
    previousLine = line;
  }

  flushCurrentLines();

  return blocks.map((text, index) => ({
    type: LAYOUT_BLOCK_TYPE,
    blockNumber: index + 1,
    text,
  }));
}

function buildPdfWebsiteBlocksFromLines(lines, dominantFontSize) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }

  const blocks = [];
  let paragraphBuffer = [];
  let listBuffer = [];
  let listContext = null;

  function flushParagraph() {
    if (paragraphBuffer.length === 0) {
      return;
    }

    blocks.push({
      type: PDF_WEBSITE_BLOCK_TYPE.PARAGRAPH,
      text: paragraphBuffer.join(" "),
    });
    paragraphBuffer = [];
  }

  function flushList() {
    if (listBuffer.length === 0) {
      listContext = null;
      return;
    }

    blocks.push({
      type: PDF_WEBSITE_BLOCK_TYPE.LIST,
      items: listBuffer.slice(),
    });
    listBuffer = [];
    listContext = null;
  }

  for (const line of lines) {
    const text = sanitizeFragment(line?.text);
    if (!text) {
      continue;
    }

    const lineFontSize = Number(line?.fontSize);
    const lineBucket = Number.isFinite(lineFontSize) ? Math.round(lineFontSize * 2) / 2 : 0;
    const isHeading = lineBucket > dominantFontSize;

    if (isHeading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: PDF_WEBSITE_BLOCK_TYPE.HEADING,
        text,
      });
      continue;
    }

    if (isLikelyListLine(text)) {
      flushParagraph();
      const listItemText = getWebsiteListItemText(text);
      listBuffer.push(listItemText);
      const lineStartX = Number(line?.startX);
      const normalizedLineStart = Number.isFinite(lineStartX) ? lineStartX : 0;
      listContext = {
        markerStartX: normalizedLineStart,
        continuationMinX: normalizedLineStart + Math.max(4, (Number(line?.fontSize) || 11) * 0.45),
        fontSize: Number(line?.fontSize) || 11,
        lastLineEndedHyphen: /-\s*$/.test(listItemText),
      };
      continue;
    }

    if (
      shouldContinueWebsiteListItem(line, text, lineBucket, dominantFontSize, listBuffer, listContext)
    ) {
      const lastIndex = listBuffer.length - 1;
      listBuffer[lastIndex] = joinFlowingText(listBuffer[lastIndex], text);
      if (listContext) {
        listContext.lastLineEndedHyphen = /-\s*$/.test(text);
      }
      continue;
    }

    flushList();
    paragraphBuffer.push(text);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function shouldContinueWebsiteListItem(
  line,
  text,
  lineBucket,
  dominantFontSize,
  listBuffer,
  listContext,
) {
  if (!Array.isArray(listBuffer) || listBuffer.length === 0 || !listContext) {
    return false;
  }

  if (!text || lineBucket > dominantFontSize || isLikelyListLine(text)) {
    return false;
  }

  const lineStartX = Number(line?.startX);
  const markerStartX = Number(listContext.markerStartX);
  const continuationMinX = Number(listContext.continuationMinX);
  const hasIndentByPosition =
    Number.isFinite(lineStartX) &&
    Number.isFinite(markerStartX) &&
    lineStartX >= (
      Number.isFinite(continuationMinX)
        ? continuationMinX
        : markerStartX + Math.max(4, (Number(listContext.fontSize) || 11) * 0.45)
    );

  const hasLeadingWhitespace = Number(line?.leadingWhitespace) > 0;
  const previousLineEndedHyphen = Boolean(listContext.lastLineEndedHyphen);

  return hasIndentByPosition || hasLeadingWhitespace || previousLineEndedHyphen;
}

function getWebsiteListItemText(text) {
  const value = sanitizeFragment(text);
  const match = value.match(/^\s*(?:[-*•‣◦▪]+|(?:\d+|[A-Za-z])[.)])\s*(.+)$/);
  return sanitizeFragment(match ? match[1] : value);
}

function mergePdfWebsitePageContinuations(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return [];
  }

  const clonedPages = pages.map((page) => ({
    pageNumber: page.pageNumber,
    blocks: clonePdfWebsiteBlocks(page.blocks),
  }));

  for (let index = 1; index < clonedPages.length; index += 1) {
    const previousPage = clonedPages[index - 1];
    const currentPage = clonedPages[index];

    while (previousPage.blocks.length > 0 && currentPage.blocks.length > 0) {
      const previousBlock = previousPage.blocks[previousPage.blocks.length - 1];
      const currentBlock = currentPage.blocks[0];
      if (shouldMergePdfWebsiteBlocks(previousBlock, currentBlock)) {
        if (previousBlock.type === PDF_WEBSITE_BLOCK_TYPE.LIST) {
          previousBlock.items = previousBlock.items.concat(currentBlock.items);
        } else {
          previousBlock.text = joinFlowingText(previousBlock.text, currentBlock.text);
        }
        currentPage.blocks.shift();
        continue;
      }

      if (shouldMergeListParagraphContinuation(previousBlock, currentBlock)) {
        const lastIndex = previousBlock.items.length - 1;
        previousBlock.items[lastIndex] = joinFlowingText(previousBlock.items[lastIndex], currentBlock.text);
        currentPage.blocks.shift();
        continue;
      }

      break;
    }
  }

  return clonedPages.filter((page) => page.blocks.length > 0);
}

function clonePdfWebsiteBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks.map((block) => {
    if (block?.type === PDF_WEBSITE_BLOCK_TYPE.LIST) {
      return {
        type: PDF_WEBSITE_BLOCK_TYPE.LIST,
        items: Array.isArray(block.items) ? block.items.slice() : [],
      };
    }

    return {
      type: block?.type,
      text: block?.text || "",
    };
  });
}

function shouldMergePdfWebsiteBlocks(previousBlock, currentBlock) {
  if (!previousBlock || !currentBlock || previousBlock.type !== currentBlock.type) {
    return false;
  }

  return (
    previousBlock.type === PDF_WEBSITE_BLOCK_TYPE.PARAGRAPH ||
    previousBlock.type === PDF_WEBSITE_BLOCK_TYPE.LIST
  );
}

function shouldMergeListParagraphContinuation(previousBlock, currentBlock) {
  if (
    !previousBlock ||
    !currentBlock ||
    previousBlock.type !== PDF_WEBSITE_BLOCK_TYPE.LIST ||
    currentBlock.type !== PDF_WEBSITE_BLOCK_TYPE.PARAGRAPH
  ) {
    return false;
  }

  const paragraphText = sanitizeFragment(currentBlock.text);
  if (!paragraphText) {
    return false;
  }

  const lastListItem = sanitizeFragment(previousBlock.items?.[previousBlock.items.length - 1] || "");
  if (!lastListItem) {
    return false;
  }

  if (/-\s*$/.test(lastListItem)) {
    return true;
  }

  return /^[a-z(]/.test(paragraphText) || /^[,.;:)\]]/.test(paragraphText);
}

function joinFlowingText(first, second) {
  const left = sanitizeFragment(first);
  const right = sanitizeFragment(second);

  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (left.endsWith("-")) {
    return `${left.slice(0, -1)}${right}`;
  }
  return `${left} ${right}`;
}

function classifyLine(line, pageStats) {
  if (isLikelyListLine(line.text)) {
    return SEMANTIC_BLOCK_TYPE.LIST;
  }

  if (isLikelyTableLine(line, pageStats)) {
    return SEMANTIC_BLOCK_TYPE.TABLE;
  }

  if (isLikelyHeadingLine(line, pageStats)) {
    return SEMANTIC_BLOCK_TYPE.HEADING;
  }

  return SEMANTIC_BLOCK_TYPE.PARAGRAPH;
}

function isLikelyListLine(text) {
  return /^\s*(?:[-*•‣◦▪]|(?:\d+|[A-Za-z])[.)])\s+\S/.test(text);
}

function isLikelyTableLine(line, pageStats) {
  if (!line || typeof line !== "object") {
    return false;
  }

  if (!Number.isFinite(line.columnCount) || line.columnCount < 3) {
    return false;
  }

  if (line.wordCount < 3 || line.wordCount > 20) {
    return false;
  }

  const smallFont = line.fontSize <= pageStats.medianFontSize * 1.15;
  return smallFont;
}

function isLikelyHeadingLine(line, pageStats) {
  if (!line || typeof line !== "object") {
    return false;
  }

  if (line.wordCount === 0 || line.wordCount > 16) {
    return false;
  }

  const text = line.text;
  const fontBoost = line.fontSize >= pageStats.medianFontSize * 1.2;
  const uppercaseRatio = getUppercaseRatio(text);
  const isShort = text.length <= 120;
  const endsLikeSentence = /[.!?]\s*$/.test(text);
  const looksTitleCase = /^[A-Z][\w'"()\-]/.test(text);

  if (!isShort) {
    return false;
  }

  if (fontBoost && looksTitleCase && !endsLikeSentence) {
    return true;
  }

  if (uppercaseRatio >= 0.75 && line.wordCount <= 14) {
    return true;
  }

  return false;
}

function joinTextLine(items) {
  let result = "";

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const text = item.text;
    if (!text) {
      continue;
    }

    if (result.length === 0) {
      result = text;
      continue;
    }

    const previous = items[index - 1];
    const previousEndX = previous.x + estimateTextWidth(previous);
    const gap = item.x - previousEndX;
    const spacingThreshold = Math.max(2, previous.fontSize * 0.2);
    const shouldInsertSpace = gap > spacingThreshold && !result.endsWith("-");

    result += shouldInsertSpace ? ` ${text}` : text;
  }

  return sanitizeFragment(result);
}

function estimateColumnCount(items, fontSize) {
  if (!Array.isArray(items) || items.length <= 1) {
    return 1;
  }

  const largeGapThreshold = Math.max(28, fontSize * 2.5);
  let columns = 1;

  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    const previousEndX = previous.x + estimateTextWidth(previous);
    const gap = current.x - previousEndX;
    if (gap > largeGapThreshold) {
      columns += 1;
    }
  }

  return columns;
}

function estimateFontSize(item, transform) {
  const transformA = Number(transform[0]);
  const transformB = Number(transform[1]);
  const transformScale = Math.hypot(
    Number.isFinite(transformA) ? transformA : 0,
    Number.isFinite(transformB) ? transformB : 0,
  );
  const itemHeight = Number(item?.height);
  if (Number.isFinite(transformScale) && transformScale > 0.5) {
    return transformScale;
  }
  if (Number.isFinite(itemHeight) && itemHeight > 0.5) {
    return itemHeight;
  }
  return 11;
}

function estimateTextWidth(item) {
  const width = Number(item?.width);
  if (Number.isFinite(width) && width > 0) {
    return width;
  }

  return Math.max(8, item.text.length * item.fontSize * 0.45);
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function countWords(text) {
  if (typeof text !== "string") {
    return 0;
  }

  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.length;
}

function countLeadingWhitespace(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }

  const match = text.match(/^\s+/);
  return match ? match[0].length : 0;
}

function sanitizeFragment(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeOcrText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getOcrEngine() {
  if (typeof globalThis.OCRAD === "function") {
    return globalThis.OCRAD;
  }

  if (typeof window !== "undefined" && typeof window.OCRAD === "function") {
    return window.OCRAD;
  }

  if (typeof OCRAD === "function") {
    return OCRAD;
  }

  return null;
}

function getUppercaseRatio(text) {
  if (typeof text !== "string") {
    return 0;
  }

  const letters = text.match(/[A-Za-z]/g);
  if (!letters || letters.length === 0) {
    return 0;
  }

  const uppercaseLetters = letters.filter((letter) => letter >= "A" && letter <= "Z");
  return uppercaseLetters.length / letters.length;
}

function getSemanticLabel(type) {
  if (type === SEMANTIC_BLOCK_TYPE.HEADING) {
    return "Heading";
  }
  if (type === SEMANTIC_BLOCK_TYPE.LIST) {
    return "List";
  }
  if (type === SEMANTIC_BLOCK_TYPE.TABLE) {
    return "Table";
  }
  return "Paragraph";
}

function renderSemanticPages(root, pages) {
  root.replaceChildren();

  if (!Array.isArray(pages) || pages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "page-text";
    empty.textContent = "No readable text found in this PDF.";
    root.append(empty);
    return;
  }

  for (const page of pages) {
    const block = document.createElement("article");
    block.className = "page-block";

    const title = document.createElement("h2");
    title.className = "page-title";
    title.textContent = `Page ${page.pageNumber}`;
    block.append(title);

    for (const semanticBlock of page.blocks) {
      const semanticCard = document.createElement("article");
      semanticCard.className = "semantic-block";

      const semanticLabel = document.createElement("span");
      semanticLabel.className = `semantic-label semantic-label-${semanticBlock.type}`;
      semanticLabel.textContent = getSemanticLabel(semanticBlock.type);

      const semanticText = document.createElement("p");
      semanticText.className = "page-text";
      semanticText.textContent = semanticBlock.text;

      semanticCard.append(semanticLabel, semanticText);
      block.append(semanticCard);
    }

    root.append(block);
  }
}

function renderLayoutAwarePages(root, pages) {
  root.replaceChildren();

  if (!Array.isArray(pages) || pages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "page-text";
    empty.textContent = "No readable text found in this PDF.";
    root.append(empty);
    return;
  }

  for (const page of pages) {
    const block = document.createElement("article");
    block.className = "page-block";

    const title = document.createElement("h2");
    title.className = "page-title";
    title.textContent = `Page ${page.pageNumber}`;
    block.append(title);

    for (const layoutBlock of page.blocks) {
      const layoutCard = document.createElement("article");
      layoutCard.className = "semantic-block";

      const layoutLabel = document.createElement("span");
      layoutLabel.className = "semantic-label semantic-label-layout";
      layoutLabel.textContent = `Layout Block ${layoutBlock.blockNumber}`;

      const layoutText = document.createElement("p");
      layoutText.className = "page-text";
      layoutText.textContent = layoutBlock.text;

      layoutCard.append(layoutLabel, layoutText);
      block.append(layoutCard);
    }

    root.append(block);
  }
}

function renderOcrPages(root, pages) {
  root.replaceChildren();

  if (!Array.isArray(pages) || pages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "page-text";
    empty.textContent = "No readable OCR text found in this PDF.";
    root.append(empty);
    return;
  }

  for (const page of pages) {
    const block = document.createElement("article");
    block.className = "page-block";

    const title = document.createElement("h2");
    title.className = "page-title";
    title.textContent = `Page ${page.pageNumber}`;
    block.append(title);

    for (const ocrBlock of page.blocks) {
      const ocrCard = document.createElement("article");
      ocrCard.className = "semantic-block";

      const ocrLabel = document.createElement("span");
      ocrLabel.className = "semantic-label semantic-label-ocr";
      ocrLabel.textContent = "OCR";

      const ocrText = document.createElement("p");
      ocrText.className = "page-text";
      ocrText.textContent = ocrBlock.text;

      ocrCard.append(ocrLabel, ocrText);
      block.append(ocrCard);
    }

    root.append(block);
  }
}

function renderPdfWebsitePages(root, pages, dominantFontSize) {
  root.replaceChildren();

  if (!Array.isArray(pages) || pages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "page-text";
    empty.textContent = "No readable text found in this PDF.";
    root.append(empty);
    return;
  }

  const note = document.createElement("p");
  note.className = "page-title";
  note.textContent = `PDF-Website heuristic: dominant font size ${dominantFontSize}. Larger text becomes headings; bullet lines become lists.`;
  root.append(note);

  for (const page of pages) {
    const block = document.createElement("article");
    block.className = "page-block";

    const title = document.createElement("h2");
    title.className = "page-title";
    title.textContent = `Page ${page.pageNumber}`;
    block.append(title);

    const websitePage = document.createElement("section");
    websitePage.className = "website-page";

    for (const websiteBlock of page.blocks) {
      const selectableBlock = document.createElement("div");
      selectableBlock.className = PDF_WEBSITE_SELECTABLE_BLOCK_CLASS;
      selectableBlock.dataset.websiteBlockType = websiteBlock.type;

      if (websiteBlock.type === PDF_WEBSITE_BLOCK_TYPE.HEADING) {
        const heading = document.createElement("h3");
        heading.className = "website-heading";
        heading.textContent = websiteBlock.text;
        selectableBlock.append(heading);
        websitePage.append(selectableBlock);
        continue;
      }

      if (websiteBlock.type === PDF_WEBSITE_BLOCK_TYPE.LIST) {
        const list = document.createElement("ul");
        list.className = "website-list";
        for (const itemText of websiteBlock.items || []) {
          const item = document.createElement("li");
          item.className = "website-list-item";
          item.textContent = itemText;
          list.append(item);
        }
        selectableBlock.append(list);
        websitePage.append(selectableBlock);
        continue;
      }

      const paragraph = document.createElement("p");
      paragraph.className = "website-paragraph";
      paragraph.textContent = websiteBlock.text;
      selectableBlock.append(paragraph);
      websitePage.append(selectableBlock);
    }

    block.append(websitePage);
    root.append(block);
  }
}
