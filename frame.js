"use strict";

if (window.top !== window) {
  let scheduled = 0;
  let applying = false;

  function stretchElement(el) {
    el.style.setProperty("width", "100%", "important");
    el.style.setProperty("max-width", "none", "important");
    el.style.setProperty("margin-right", "0", "important");
    el.style.setProperty("align-self", "stretch", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
  }

  function stretch() {
    if (applying || !document.body) return;
    const view = document.documentElement.clientWidth;
    if (view < 160) return;

    applying = true;
    try {
      stretchElement(document.documentElement);
      stretchElement(document.body);

      for (const el of document.body.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        const gap = view - rect.right;
        if (gap < 24) continue;
        if (rect.left > 32) continue;
        if (rect.height < 20) continue;
        if (rect.width < view * 0.35) continue;
        stretchElement(el);
      }
    } finally {
      applying = false;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      stretch();
    }, 50);
  }

  stretch();
  new MutationObserver(() => {
    if (!applying) schedule();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  window.addEventListener("resize", schedule);
}
