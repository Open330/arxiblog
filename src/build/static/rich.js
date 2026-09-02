// Offline post enhancements. Each renderer fails independently so raw LaTeX
// and Mermaid source remain readable if a browser cannot execute one library.
(function () {
  "use strict";

  if (typeof window.renderMathInElement === "function") {
    try {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    } catch (error) {
      console.error("KaTeX rendering failed", error);
    }
  }

  const diagrams = document.querySelectorAll("pre.mermaid");
  if (diagrams.length && window.mermaid) {
    const dark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    Promise.resolve().then(function () {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        fontFamily: "Pretendard, sans-serif",
      });
      return window.mermaid.run({ nodes: diagrams });
    }).then(function () {
      diagrams.forEach(enhanceMermaid);
    }).catch(function (error) {
      console.error("Mermaid rendering failed", error);
    });
  }

  // Wrap a rendered Mermaid <svg> in a fit-to-width, pan/zoom viewport (à la
  // GitHub) so large diagrams no longer blow out the page layout. Degrades to the
  // raw source when rendering failed (no <svg>).
  function enhanceMermaid(pre) {
    const svg = pre.querySelector("svg");
    if (!svg || !pre.parentNode) return;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const natW = (vb && vb.width) || rect.width || 800;
    const natH = (vb && vb.height) || rect.height || 480;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.width = natW + "px";
    svg.style.height = natH + "px";
    svg.style.maxWidth = "none";

    const viewport = document.createElement("div");
    viewport.className = "mermaid-viewport";
    const canvas = document.createElement("div");
    canvas.className = "mermaid-canvas";
    const controls = document.createElement("div");
    controls.className = "mermaid-controls";
    function mkBtn(label, title) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title;
      b.setAttribute("aria-label", title);
      controls.appendChild(b); return b;
    }
    const bIn = mkBtn("+", "확대");
    const bOut = mkBtn("\u2212", "축소");
    const bReset = mkBtn("\u21BA", "원래 크기");
    const bFull = mkBtn("\u26F6", "전체 화면");
    const hint = document.createElement("div");
    hint.className = "mermaid-hint";
    hint.textContent = "스크롤로 확대 · 드래그로 이동";

    pre.parentNode.insertBefore(viewport, pre);
    canvas.appendChild(svg);
    viewport.appendChild(canvas);
    viewport.appendChild(controls);
    viewport.appendChild(hint);
    pre.remove();

    let scale = 1, tx = 0, ty = 0, fit = 1;
    const clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
    function apply() { canvas.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")"; }
    function fitView() {
      const vw = viewport.clientWidth || natW;
      fit = Math.min(vw / natW, 1);
      const cap = Math.min(window.innerHeight * 0.7, 560);
      viewport.style.height = Math.max(140, Math.min(natH * fit, cap)) + "px";
      scale = fit;
      tx = Math.max(0, (vw - natW * scale) / 2);
      ty = Math.max(0, (viewport.clientHeight - natH * scale) / 2);
      apply();
    }
    function zoomAt(cx, cy, factor) {
      const next = clamp(scale * factor, fit * 0.6, fit * 8 + 0.001);
      const k = next / scale;
      tx = cx - (cx - tx) * k;
      ty = cy - (cy - ty) * k;
      scale = next; apply();
    }
    bIn.addEventListener("click", function () { zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.25); });
    bOut.addEventListener("click", function () { zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / 1.25); });
    bReset.addEventListener("click", fitView);
    bFull.addEventListener("click", function () {
      viewport.classList.toggle("mermaid-fs");
      bFull.textContent = viewport.classList.contains("mermaid-fs") ? "\u2715" : "\u26F6";
      requestAnimationFrame(fitView);
    });

    viewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    let dragging = false, sx = 0, sy = 0;
    viewport.addEventListener("pointerdown", function (e) {
      // Let clicks on the control buttons through — capturing the pointer here would
      // steal their click event.
      if (e.target && e.target.closest && e.target.closest(".mermaid-controls")) return;
      // On touch, only hijack the gesture once zoomed in so page scroll still works.
      if (e.pointerType !== "mouse" && scale <= fit * 1.02) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("grabbing");
    });
    viewport.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      tx += e.clientX - sx; ty += e.clientY - sy; sx = e.clientX; sy = e.clientY; apply();
    });
    function endDrag() { dragging = false; viewport.classList.remove("grabbing"); }
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
    viewport.addEventListener("dblclick", function (e) {
      const r = viewport.getBoundingClientRect();
      if (scale > fit * 1.02) fitView(); else zoomAt(e.clientX - r.left, e.clientY - r.top, 2);
    });

    let resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (!viewport.classList.contains("mermaid-fs")) fitView(); }, 150);
    });
    fitView();
  }
})();
