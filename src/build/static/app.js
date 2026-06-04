// arxiblog client: theme toggle, reading progress, TOC scroll-spy,
// annotation popovers (touch/keyboard), and the AI chat sidebar.
(function () {
  "use strict";

  // ── Theme toggle (persisted) ──
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      const root = document.documentElement;
      const current =
        root.dataset.theme ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("arxiblog-theme", next); } catch (e) {}
    });
  }

  // ── Reading progress bar ──
  const bar = document.getElementById("progress-bar");
  if (bar) {
    const onScroll = function () {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      bar.style.width = max > 0 ? (h.scrollTop / max) * 100 + "%" : "0%";
    };
    document.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ── TOC scroll-spy ──
  const tocLinks = Array.from(document.querySelectorAll(".toc a, .toc-mobile a"));
  if (tocLinks.length) {
    const map = new Map();
    for (const a of tocLinks) {
      const id = decodeURIComponent((a.getAttribute("href") || "").slice(1));
      const el = document.getElementById(id);
      if (el) map.set(el, a);
    }
    if (map.size) {
      const spy = new IntersectionObserver(
        function (entries) {
          for (const e of entries) {
            if (e.isIntersecting) {
              tocLinks.forEach((l) => l.classList.remove("active"));
              const link = map.get(e.target);
              if (link) link.classList.add("active");
            }
          }
        },
        { rootMargin: "-80px 0px -70% 0px" }
      );
      map.forEach((_link, el) => spy.observe(el));
    }
  }

  // ── Annotation popovers: hover via CSS; click/tap + Esc for touch & a11y ──
  document.addEventListener("click", function (e) {
    const annot = e.target.closest && e.target.closest(".annot");
    document.querySelectorAll(".annot.open").forEach(function (el) {
      if (el !== annot) el.classList.remove("open");
    });
    if (annot && !(e.target.closest && e.target.closest(".annot-pop"))) {
      annot.classList.toggle("open");
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      document.querySelectorAll(".annot.open").forEach((el) => el.classList.remove("open"));
      closeChat();
    }
  });

  // ── Chat sidebar ──
  const toggle = document.getElementById("chat-toggle");
  const panel = document.getElementById("chat-panel");
  const closeBtn = document.getElementById("chat-close");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const log = document.getElementById("chat-log");
  const slug = document.body.getAttribute("data-slug");
  const history = [];

  function openChat() { if (panel) { panel.hidden = false; setTimeout(() => input && input.focus(), 50); } }
  function closeChat() { if (panel) panel.hidden = true; }
  if (toggle) toggle.addEventListener("click", openChat);
  if (closeBtn) closeBtn.addEventListener("click", closeChat);

  if (input) {
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 140) + "px";
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
  }

  function addMsg(role, text) {
    const div = document.createElement("div");
    div.className = "chat-msg " + role;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  let busy = false;
  async function send(q) {
    q = (q || "").trim();
    if (!q || busy) return;
    busy = true;
    addMsg("user", q);
    history.push({ role: "user", content: q });
    const typing = addMsg("bot", "…");
    typing.classList.add("chat-typing");
    const btn = form && form.querySelector("button");
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug, question: q, history: history.slice(0, -1) }),
      });
      if (!resp.ok) {
        let serverMsg = "";
        try { const ej = await resp.json(); serverMsg = ej.error || ej.answer || ""; } catch (e2) {}
        typing.classList.remove("chat-typing");
        typing.textContent =
          serverMsg ||
          (resp.status === 404
            ? "채팅은 로컬 `arxiblog serve` 모드에서만 동작합니다."
            : "오류가 발생했습니다 (" + resp.status + ").");
        return;
      }
      const data = await resp.json();
      const answer = (data && data.answer) || "답변을 생성하지 못했습니다.";
      typing.classList.remove("chat-typing");
      typing.textContent = answer;
      history.push({ role: "assistant", content: answer });
    } catch (err) {
      typing.classList.remove("chat-typing");
      typing.textContent = "연결할 수 없습니다. `arxiblog serve` 로 실행 중인지 확인하세요.";
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const q = (input.value || "").trim();
      if (!q) return;
      input.value = "";
      input.style.height = "auto";
      send(q);
    });
  }

  // Suggested-question chips → open chat and ask
  document.querySelectorAll(".ask-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      openChat();
      send(chip.getAttribute("data-q"));
    });
  });

  // ── Select-to-ask: highlight text in the post → floating "ask" button ──
  const postBody = document.querySelector(".post-body");
  if (postBody && form) {
    const askBtn = document.createElement("button");
    askBtn.className = "select-ask";
    askBtn.textContent = "🤔 이 부분 물어보기";
    askBtn.hidden = true;
    document.body.appendChild(askBtn);
    let selectedText = "";

    const hideAsk = () => { askBtn.hidden = true; };
    document.addEventListener("selectionchange", function () {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) { hideAsk(); return; }
      const text = sel.toString().trim();
      const anchor = sel.anchorNode;
      if (text.length < 8 || text.length > 600 || !anchor || !postBody.contains(anchor.parentNode)) {
        hideAsk();
        return;
      }
      selectedText = text;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      askBtn.style.top = window.scrollY + rect.top - 44 + "px";
      askBtn.style.left = window.scrollX + rect.left + rect.width / 2 + "px";
      askBtn.hidden = false;
    });
    askBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    askBtn.addEventListener("click", function () {
      hideAsk();
      openChat();
      send('이 부분을 쉽게 풀어서 설명해줘:\n"' + selectedText + '"');
      const sel = document.getSelection(); if (sel) sel.removeAllRanges();
    });
    document.addEventListener("scroll", hideAsk, { passive: true });
  }

  // ── Home search: filter cards ──
  const search = document.getElementById("post-search");
  if (search) {
    const cards = Array.from(document.querySelectorAll("#cards .card"));
    const emptyMsg = document.getElementById("search-empty");
    search.addEventListener("input", function () {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      cards.forEach(function (c) {
        const hit = !q || (c.getAttribute("data-search") || "").includes(q);
        c.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      if (emptyMsg) emptyMsg.hidden = shown !== 0;
    });
  }
})();
