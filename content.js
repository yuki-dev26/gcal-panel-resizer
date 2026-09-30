"use strict";

const STORAGE_KEY = "gcalPanelWidth";
const MIN_WIDTH = 320;
const MAX_WIDTH = 760;
const MAX_RATIO = 0.55;
const HANDLE_CLASS = "gcal-panel-resizer-handle";
const BLOCKED_IFRAME =
  /doubleclick|googleads|recaptcha|accounts\.google|ogs\.google|feedback/i;

const state = {
  savedWidth: null,
  storageReady: false,
  dragging: false,
  drag: null,
  overlay: null,
  mutationLock: 0,
  scanTimer: 0,
};

const styleObserver = new MutationObserver(onStyleMutations);

function clampContentWidth(contentWidth, reserved) {
  const reservedPx = Math.max(0, reserved);
  const byRatio = Math.floor(window.innerWidth * MAX_RATIO) - reservedPx;
  const maxContent = Math.min(MAX_WIDTH, byRatio);
  const min = Math.min(MIN_WIDTH, Math.max(maxContent, 0));
  const max = Math.max(maxContent, min);
  const value = Math.round(Number(contentWidth));
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function loadSavedWidth(done) {
  try {
    chrome.storage.local.get(STORAGE_KEY, (items) => {
      if (!chrome.runtime.lastError) {
        const value = items?.[STORAGE_KEY];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          state.savedWidth = value;
        }
      }
      state.storageReady = true;
      done();
    });
  } catch (error) {
    console.warn("[gcal-panel-resizer] storage read failed", error);
    state.storageReady = true;
    done();
  }
}

function persistWidth(width) {
  state.savedWidth = width;
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: width }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[gcal-panel-resizer]", chrome.runtime.lastError.message);
      }
    });
  } catch (error) {
    console.warn("[gcal-panel-resizer] storage write failed", error);
  }
}

function isAddonIframe(iframe) {
  if (!(iframe instanceof HTMLIFrameElement)) return false;
  const rect = iframe.getBoundingClientRect();
  if (rect.width < 200 || rect.height < 200) return false;
  if (rect.width >= window.innerWidth * 0.92) return false;
  if (rect.right < window.innerWidth - 180) return false;
  const style = getComputedStyle(iframe);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const src = iframe.getAttribute("src") || "";
  if (BLOCKED_IFRAME.test(src)) return false;
  return true;
}

function findPanelIframe(panel) {
  const frames = [...panel.querySelectorAll("iframe")];
  return (
    frames.find((frame) => isAddonIframe(frame)) ||
    frames.find((frame) => {
      const rect = frame.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 100;
    }) ||
    null
  );
}

function findPanelContainer(iframe) {
  const iframeRect = iframe.getBoundingClientRect();
  let best = null;
  let current = iframe.parentElement;

  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const rect = current.getBoundingClientRect();
    if (rect.width >= window.innerWidth * 0.9) break;
    if (rect.right < window.innerWidth - 220) break;

    const chrome = rect.width - iframeRect.width;
    const panelLike =
      rect.width >= 200 &&
      rect.height >= 180 &&
      rect.left <= iframeRect.left + 12 &&
      rect.right >= iframeRect.right - 12 &&
      chrome >= -8 &&
      chrome <= 220;

    if (panelLike) {
      best = current;
    } else if (best) {
      break;
    }

    current = current.parentElement;
  }

  return best;
}

function findPanels() {
  const panels = [];
  for (const iframe of document.querySelectorAll("iframe")) {
    if (!isAddonIframe(iframe)) continue;
    const panel = findPanelContainer(iframe);
    if (panel) panels.push(panel);
  }

  const unique = [...new Set(panels)];
  return unique.filter(
    (panel) =>
      !unique.some((other) => other !== panel && other.contains(panel)),
  );
}

function horizontalChrome(el) {
  const style = getComputedStyle(el);
  return [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ].reduce((sum, value) => {
    const parsed = parseFloat(value);
    return sum + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

function siblingRailWidth(child) {
  const parent = child.parentElement;
  if (!parent) return 0;
  let sum = 0;
  for (const sibling of parent.children) {
    if (sibling === child || sibling.classList.contains(HANDLE_CLASS)) continue;
    const rect = sibling.getBoundingClientRect();
    if (rect.width >= 32 && rect.width <= 100 && rect.height >= 160) {
      sum += rect.width;
    }
  }
  return sum;
}

function measureChain(panel) {
  const chain = [];
  let child = panel;
  let parent = panel.parentElement;

  while (
    parent &&
    parent !== document.body &&
    parent !== document.documentElement
  ) {
    const parentRect = parent.getBoundingClientRect();
    const childRect = child.getBoundingClientRect();
    if (parentRect.width < 40 || parentRect.height < 40) break;
    if (parentRect.width >= window.innerWidth * 0.92) break;
    if (parentRect.right < window.innerWidth - 220) break;
    if (childRect.left - parentRect.left > 48) break;

    const extra = Math.round(
      siblingRailWidth(child) + horizontalChrome(parent),
    );
    chain.push({ el: parent, child, extra });
    child = parent;
    parent = parent.parentElement;
  }

  return chain;
}

function buildGridTemplate(parent, child, childPx) {
  const computed = getComputedStyle(parent);
  if (computed.display !== "grid" && computed.display !== "inline-grid")
    return null;
  const tracks = computed.gridTemplateColumns.split(/\s+/).filter(Boolean);
  const index = [...parent.children].indexOf(child);
  if (index < 0 || tracks.length !== parent.children.length) return null;
  if (!tracks.every((track) => track.endsWith("px"))) return null;
  const next = tracks.slice();
  next[index] = `${Math.round(childPx)}px`;
  return next.join(" ");
}

function lockMutations(fn) {
  state.mutationLock += 1;
  try {
    fn();
  } finally {
    queueMicrotask(() => {
      state.mutationLock -= 1;
    });
  }
}

function isColumnFlexItem(el) {
  const parent = el.parentElement;
  if (!parent) return false;
  const style = getComputedStyle(parent);
  if (style.display !== "flex" && style.display !== "inline-flex") return false;
  return (
    style.flexDirection === "column" || style.flexDirection === "column-reverse"
  );
}

function clearMainAxisLock(el) {
  el.style.removeProperty("flex");
  el.style.removeProperty("flex-basis");
  el.style.removeProperty("flex-grow");
  el.style.removeProperty("flex-shrink");
}

function setBoxWidth(el, px) {
  const rounded = Math.round(px);
  const value = `${rounded}px`;
  el.dataset.gcalWidth = String(rounded);
  el.style.setProperty("width", value, "important");
  el.style.setProperty("min-width", value, "important");
  el.style.setProperty("max-width", value, "important");
  el.style.setProperty("box-sizing", "border-box", "important");

  if (isColumnFlexItem(el)) {
    clearMainAxisLock(el);
    el.style.setProperty("align-self", "stretch", "important");
  } else {
    el.style.setProperty("flex", `0 0 ${value}`, "important");
    el.style.setProperty("flex-basis", value, "important");
    el.style.setProperty("flex-grow", "0", "important");
    el.style.setProperty("flex-shrink", "0", "important");
    el.style.removeProperty("align-self");
  }

  if (el instanceof HTMLIFrameElement) {
    el.style.setProperty("height", "100%", "important");
    el.style.setProperty("background-color", "transparent", "important");
  }
  watchElement(el);
}

function parentContentWidth(el) {
  const parent = el.parentElement;
  if (!parent) return 0;
  const style = getComputedStyle(parent);
  const pad =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  return Math.max(0, Math.round(parent.clientWidth - pad));
}

function setFillWidth(el) {
  const width = parentContentWidth(el);
  el.dataset.gcalFill = "1";
  if (width > 0) {
    const value = `${width}px`;
    el.style.setProperty("width", value, "important");
    el.style.setProperty("min-width", value, "important");
    el.style.setProperty("max-width", value, "important");
  }
  el.style.setProperty("box-sizing", "border-box", "important");
  clearMainAxisLock(el);
  el.style.setProperty("align-self", "stretch", "important");
  el.style.setProperty("justify-self", "stretch", "important");
  if (el instanceof HTMLIFrameElement) {
    el.style.setProperty("height", "100%", "important");
    el.style.setProperty("background-color", "transparent", "important");
  }
  watchElement(el);
}

function fillsParent(el) {
  const target = parentContentWidth(el);
  if (target <= 0) return true;
  return Math.abs(el.getBoundingClientRect().width - target) <= 2;
}

function clearSizing(el) {
  const raw = el.style.width.trim();
  const managed = el.dataset.gcalWidth ? `${el.dataset.gcalWidth}px` : "";
  const numeric = parseFloat(raw);
  const keepClosedWidth =
    raw &&
    raw !== managed &&
    !raw.endsWith("%") &&
    raw !== "auto" &&
    Number.isFinite(numeric) &&
    numeric < 80;

  delete el.dataset.gcalWidth;
  delete el.dataset.gcalFill;
  el.style.removeProperty("width");
  el.style.removeProperty("min-width");
  el.style.removeProperty("max-width");
  el.style.removeProperty("flex");
  el.style.removeProperty("flex-basis");
  el.style.removeProperty("flex-grow");
  el.style.removeProperty("flex-shrink");
  el.style.removeProperty("align-self");
  el.style.removeProperty("height");
  el.style.removeProperty("background-color");
  el.style.removeProperty("box-sizing");
  if (el.dataset.gcalSetGrid === "1") {
    el.style.removeProperty("grid-template-columns");
    delete el.dataset.gcalSetGrid;
  }
  if (el.dataset.gcalSetPosition === "1") {
    el.style.removeProperty("position");
    delete el.dataset.gcalSetPosition;
  }
  if (keepClosedWidth) el.style.width = raw;
  else if (el instanceof HTMLIFrameElement) {
    el.style.width = "100%";
    el.style.height = "100%";
  }
}

function releaseManaged(panel) {
  if (!(panel instanceof HTMLElement)) return;
  lockMutations(() => {
    const marked = new Set([
      ...panel.querySelectorAll("[data-gcal-width], [data-gcal-fill]"),
    ]);
    if (panel.dataset.gcalWidth) marked.add(panel);
    let parent = panel.parentElement;
    while (parent && parent.dataset.gcalWidth) {
      marked.add(parent);
      parent = parent.parentElement;
    }
    marked.forEach(clearSizing);
    panel.querySelector(`:scope > .${HANDLE_CLASS}`)?.remove();
    delete panel.dataset.gcalPanelResizer;
  });
}

function watchElement(el) {
  if (el.dataset.gcalWatching === "1") return;
  el.dataset.gcalWatching = "1";
  styleObserver.observe(el, {
    attributes: true,
    attributeFilter: ["style", "hidden", "aria-hidden"],
  });
}

function applyWidth(panel, requested, force = false) {
  const iframe = findPanelIframe(panel);
  const chain = measureChain(panel);
  const external = chain.reduce((sum, item) => sum + item.extra, 0);
  const contentWidth = clampContentWidth(requested, external);

  const fills = [];
  if (iframe) {
    let el = iframe;
    while (el && el !== panel) {
      fills.push(el);
      el = el.parentElement;
    }
  }

  let outer = contentWidth;
  const ancestorWrites = [];
  for (const item of chain) {
    const gridTemplate = buildGridTemplate(item.el, item.child, outer);
    outer += item.extra;
    ancestorWrites.push({ el: item.el, width: outer, gridTemplate });
  }

  const widthMatches =
    Math.abs(panel.getBoundingClientRect().width - contentWidth) <= 1.5 &&
    ancestorWrites.every(
      (write) =>
        Math.abs(write.el.getBoundingClientRect().width - write.width) <= 1.5,
    ) &&
    fills.every((el) => fillsParent(el));
  const columnFlexLocked = [
    panel,
    ...ancestorWrites.map((write) => write.el),
  ].some((el) => {
    if (!isColumnFlexItem(el)) return false;
    const basis = el.style.flexBasis.trim();
    return basis.endsWith("px") && parseFloat(basis) >= 80;
  });
  if (!force && widthMatches && !columnFlexLocked) return contentWidth;

  lockMutations(() => {
    setBoxWidth(panel, contentWidth);
    for (const el of [...fills].reverse()) setFillWidth(el);
    for (const write of ancestorWrites) {
      if (write.gridTemplate) {
        write.el.dataset.gcalSetGrid = "1";
        write.el.style.setProperty(
          "grid-template-columns",
          write.gridTemplate,
          "important",
        );
      }
      setBoxWidth(write.el, write.width);
    }
  });

  return contentWidth;
}

function updateAria(handle, contentWidth) {
  if (!handle) return;
  const max = clampContentWidth(Number.POSITIVE_INFINITY, 0);
  handle.setAttribute("aria-valuemin", String(Math.min(MIN_WIDTH, max)));
  handle.setAttribute("aria-valuemax", String(max));
  handle.setAttribute("aria-valuenow", String(Math.round(contentWidth)));
}

function placeHandle(handle, panel) {
  const rect = panel.getBoundingClientRect();
  const onLeftEdge = rect.left + rect.width / 2 >= window.innerWidth / 2;
  handle.dataset.edge = onLeftEdge ? "left" : "right";
  handle.style.setProperty("left", onLeftEdge ? "0" : "auto", "important");
  handle.style.setProperty("right", onLeftEdge ? "auto" : "0", "important");
}

function ensureHandle(panel) {
  if (getComputedStyle(panel).position === "static") {
    panel.style.setProperty("position", "relative", "important");
    panel.dataset.gcalSetPosition = "1";
  }
  panel.dataset.gcalPanelResizer = "1";

  let handle = panel.querySelector(`:scope > .${HANDLE_CLASS}`);
  if (!handle) {
    handle = document.createElement("div");
    handle.className = HANDLE_CLASS;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "サイドパネルの幅を変更");
    handle.title = "ドラッグして幅を変更";
    handle.addEventListener("mousedown", onHandleMouseDown);
    panel.appendChild(handle);
  }
  placeHandle(handle, panel);
  return handle;
}

function createOverlay() {
  destroyOverlay();
  const overlay = document.createElement("div");
  overlay.className = "resize-overlay";
  overlay.setAttribute("aria-hidden", "true");
  document.documentElement.appendChild(overlay);
  state.overlay = overlay;
}

function destroyOverlay() {
  state.overlay?.remove();
  state.overlay = null;
}

function onHandleMouseDown(event) {
  if (event.button !== 0) return;
  const handle = event.currentTarget;
  const panel = handle.parentElement;
  if (!(panel instanceof HTMLElement)) return;

  event.preventDefault();
  event.stopPropagation();

  const iframe = findPanelIframe(panel);
  const rect = panel.getBoundingClientRect();
  const iframeWidth = iframe
    ? iframe.getBoundingClientRect().width
    : rect.width;
  const internal = Math.max(
    0,
    Math.min(220, Math.round(rect.width - iframeWidth)),
  );
  const edge = handle.dataset.edge === "right" ? "right" : "left";

  state.dragging = true;
  state.drag = {
    panel,
    handle,
    edge,
    internal,
    external: measureChain(panel).reduce((sum, item) => sum + item.extra, 0),
    anchorContentRight: rect.right - internal,
    anchorContentLeft: rect.left + internal,
    width: iframe ? Math.round(iframeWidth) : Math.round(rect.width),
  };

  handle.classList.add("is-dragging");
  document.documentElement.classList.add("gcal-panel-resizer-dragging");
  createOverlay();
}

function onMouseMove(event) {
  const drag = state.drag;
  if (!state.dragging || !drag?.panel?.isConnected) return;
  event.preventDefault();

  const raw =
    drag.edge === "left"
      ? drag.anchorContentRight - event.clientX
      : event.clientX - drag.anchorContentLeft;
  const width = clampContentWidth(raw, drag.internal + drag.external);
  drag.width = applyWidth(drag.panel, width, true);
  placeHandle(drag.handle, drag.panel);
  updateAria(drag.handle, drag.width);
}

function swallowNextClick() {
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, true);
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

function endDrag() {
  if (!state.dragging) return;
  const drag = state.drag;
  state.dragging = false;
  state.drag = null;
  destroyOverlay();
  document.documentElement.classList.remove("gcal-panel-resizer-dragging");
  drag?.handle?.classList.remove("is-dragging");

  if (drag && Number.isFinite(drag.width) && drag.panel?.isConnected) {
    persistWidth(drag.width);
    updateAria(drag.handle, drag.width);
  }
  swallowNextClick();
}

function onMouseUp(event) {
  if (!state.dragging) return;
  event.preventDefault();
  endDrag();
}

function isCollapseValue(el) {
  if (!(el instanceof HTMLElement) || !el.dataset.gcalWidth) return false;
  const raw = el.style.width.trim();
  const managed = `${el.dataset.gcalWidth}px`;
  if (!raw || raw === managed || raw.endsWith("%") || raw === "auto")
    return false;
  const value = parseFloat(raw);
  return Number.isFinite(value) && value < 80;
}

function panelCollapsed(panel) {
  if (isCollapseValue(panel)) return true;
  for (const el of panel.querySelectorAll("[data-gcal-width]")) {
    if (isCollapseValue(el)) return true;
  }
  let parent = panel.parentElement;
  while (parent && parent.dataset.gcalWidth) {
    if (isCollapseValue(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function onStyleMutations(mutations) {
  if (state.dragging) return;

  let shouldScan = false;
  for (const mutation of mutations) {
    const el = mutation.target;
    if (!(el instanceof HTMLElement) || !el.dataset.gcalWidth) continue;

    if (el.hidden || el.getAttribute("aria-hidden") === "true") {
      releaseManaged(findResizeRoot(el));
      continue;
    }

    const raw = el.style.width.trim();
    const managed = `${el.dataset.gcalWidth}px`;

    if (state.mutationLock > 0 && (!raw || raw === managed)) continue;
    if (!raw || raw === managed) continue;

    const root = findResizeRoot(el);
    if (raw.endsWith("%") || raw === "auto") {
      shouldScan = true;
      continue;
    }

    const value = parseFloat(raw);
    if (Number.isFinite(value) && value < 80) {
      releaseManaged(root);
      continue;
    }
    shouldScan = true;
  }

  if (shouldScan) scheduleScan();
}

function findResizeRoot(el) {
  if (el.dataset.gcalPanelResizer === "1") return el;
  const nested = el.querySelector("[data-gcal-panel-resizer]");
  if (nested) return nested;
  let current = el.parentElement;
  while (current) {
    if (current.dataset.gcalPanelResizer === "1") return current;
    current = current.parentElement;
  }
  return el;
}

function releaseClosedPanels(openPanels) {
  const open = new Set(openPanels);
  for (const panel of document.querySelectorAll("[data-gcal-panel-resizer]")) {
    if (!open.has(panel)) releaseManaged(panel);
  }
}

function scan() {
  if (state.dragging || !state.storageReady || document.hidden) return;

  for (const panel of document.querySelectorAll("[data-gcal-panel-resizer]")) {
    if (panelCollapsed(panel)) releaseManaged(panel);
  }

  const panels = findPanels();
  releaseClosedPanels(panels);

  for (const panel of panels) {
    const handle = ensureHandle(panel);
    if (state.savedWidth == null) continue;
    const applied = applyWidth(panel, state.savedWidth);
    updateAria(handle, applied);
    if (applied + 1 < state.savedWidth) persistWidth(applied);
  }
}

function scheduleScan() {
  if (state.scanTimer) return;
  state.scanTimer = window.setTimeout(() => {
    state.scanTimer = 0;
    try {
      scan();
    } catch (error) {
      console.warn("[gcal-panel-resizer]", error);
    }
  }, 50);
}

function init() {
  if (window.__gcalPanelResizer) return;
  window.__gcalPanelResizer = true;

  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("blur", () => {
    if (state.dragging) endDrag();
  });
  window.addEventListener("resize", () => scheduleScan());
  window.addEventListener("scroll", () => scheduleScan(), true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const value = changes[STORAGE_KEY].newValue;
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    state.savedWidth = value;
    if (!state.dragging) scheduleScan();
  });

  const domObserver = new MutationObserver(() => scheduleScan());
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  loadSavedWidth(() => {
    scheduleScan();
    window.setInterval(() => {
      if (!document.hidden && !state.dragging) scheduleScan();
    }, 500);
  });
}

init();
