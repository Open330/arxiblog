// arxiblog client: theme, reading progress, TOC, annotations, chat, and search.
(function () {
  "use strict";

  // ── Theme toggle (persisted and announced) ──
  const root = document.documentElement;
  const themeBtn = document.getElementById("theme-toggle");
  const themeQuery = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");

  function resolvedTheme() {
    if (root.dataset.theme === "dark" || root.dataset.theme === "light") return root.dataset.theme;
    return themeQuery && themeQuery.matches ? "dark" : "light";
  }

  function syncThemeControl() {
    if (!themeBtn) return;
    const dark = resolvedTheme() === "dark";
    const label = dark ? "라이트 테마로 전환" : "다크 테마로 전환";
    themeBtn.setAttribute("aria-label", label);
    themeBtn.setAttribute("aria-pressed", String(dark));
    themeBtn.title = label;
    const icon = themeBtn.querySelector("[aria-hidden='true']");
    if (icon) icon.textContent = dark ? "☀" : "☾";
  }

  if (themeBtn) {
    syncThemeControl();
    themeBtn.addEventListener("click", function () {
      const next = resolvedTheme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("arxiblog-theme", next); } catch (_err) {}
      syncThemeControl();
    });
    if (themeQuery && themeQuery.addEventListener) {
      themeQuery.addEventListener("change", function () {
        if (!root.dataset.theme) syncThemeControl();
      });
    }
  }

  // Ensure every new-tab link is protected, including links originating in post markdown.
  document.querySelectorAll('a[target="_blank"]').forEach(function (link) {
    link.relList.add("noopener", "noreferrer");
    if (!link.getAttribute("aria-label")) {
      const label = (link.textContent || "외부 링크").trim();
      link.setAttribute("aria-label", label + "(새 탭)");
    }
  });

  // ── Reading progress bar ──
  const bar = document.getElementById("progress-bar");
  if (bar) {
    let progressFrame = 0;
    const updateProgress = function () {
      progressFrame = 0;
      const page = document.documentElement;
      const max = page.scrollHeight - page.clientHeight;
      const value = max > 0 ? Math.min(100, Math.max(0, (page.scrollTop / max) * 100)) : 0;
      bar.style.width = value + "%";
    };
    const requestProgress = function () {
      if (!progressFrame) progressFrame = requestAnimationFrame(updateProgress);
    };
    document.addEventListener("scroll", requestProgress, { passive: true });
    window.addEventListener("resize", requestProgress, { passive: true });
    updateProgress();
  }

  // ── TOC scroll-spy ──
  const tocLinks = Array.from(document.querySelectorAll(".toc a, .toc-mobile a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    const linksByHeading = new Map();
    for (const link of tocLinks) {
      let id = "";
      try { id = decodeURIComponent((link.getAttribute("href") || "").slice(1)); } catch (_err) {}
      const heading = id && document.getElementById(id);
      if (!heading) continue;
      const links = linksByHeading.get(heading) || [];
      links.push(link);
      linksByHeading.set(heading, links);
    }

    function setCurrentHeading(heading) {
      tocLinks.forEach(function (link) {
        link.classList.remove("active");
        link.removeAttribute("aria-current");
      });
      (linksByHeading.get(heading) || []).forEach(function (link) {
        link.classList.add("active");
        link.setAttribute("aria-current", "location");
      });
    }

    if (linksByHeading.size) {
      const visible = new Set();
      const spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        });
        const first = Array.from(linksByHeading.keys()).find(function (heading) {
          return visible.has(heading);
        });
        if (first) setCurrentHeading(first);
      }, { rootMargin: "-80px 0px -70% 0px" });
      linksByHeading.forEach(function (_links, heading) { spy.observe(heading); });
    }

    document.querySelectorAll(".toc-mobile a").forEach(function (link) {
      link.addEventListener("click", function () {
        const details = link.closest("details");
        if (details) details.open = false;
      });
    });
  }

  // ── Annotation popovers: mouse, touch, and keyboard ──
  const annotations = Array.from(document.querySelectorAll(".annot"));
  function setAnnotationOpen(annotation, open) {
    annotation.classList.toggle("open", open);
    annotation.setAttribute("aria-expanded", String(open));
  }
  annotations.forEach(function (annotation, index) {
    const popover = annotation.querySelector(".annot-pop");
    annotation.setAttribute("role", "button");
    annotation.setAttribute("aria-expanded", "false");
    if (popover) {
      if (!popover.id) popover.id = "annotation-" + (index + 1);
      popover.setAttribute("role", "tooltip");
      annotation.setAttribute("aria-describedby", popover.id);
    }
    annotation.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const willOpen = !annotation.classList.contains("open");
        annotations.forEach(function (other) { setAnnotationOpen(other, other === annotation && willOpen); });
      }
    });
  });
  document.addEventListener("click", function (event) {
    const target = event.target;
    const annotation = target && target.closest && target.closest(".annot");
    annotations.forEach(function (item) {
      if (item !== annotation) setAnnotationOpen(item, false);
    });
    if (annotation && !(target.closest && target.closest(".annot-pop"))) {
      setAnnotationOpen(annotation, !annotation.classList.contains("open"));
    }
  });

  // ── Chat dialog ──
  const toggle = document.getElementById("chat-toggle");
  const panel = document.getElementById("chat-panel");
  const closeBtn = document.getElementById("chat-close");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const log = document.getElementById("chat-log");
  const slug = document.body.getAttribute("data-slug");
  const history = [];
  let busy = false;
  let lastFocused = null;
  let closeChat = function () {};

  function focusableInPanel() {
    if (!panel) return [];
    return Array.from(panel.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(function (element) { return !element.hidden; });
  }

  function openChat() {
    if (!panel) return;
    if (panel.hidden) {
      lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panel.hidden = false;
      document.body.classList.add("chat-open");
      if (toggle) toggle.setAttribute("aria-expanded", "true");
    }
    requestAnimationFrame(function () { if (input) input.focus(); });
  }

  closeChat = function () {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove("chat-open");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    const returnTarget = lastFocused && document.contains(lastFocused) ? lastFocused : toggle;
    lastFocused = null;
    if (returnTarget) returnTarget.focus();
  };

  if (toggle) toggle.addEventListener("click", openChat);
  if (closeBtn) closeBtn.addEventListener("click", closeChat);
  if (panel) {
    panel.addEventListener("keydown", function (event) {
      if (event.key !== "Tab") return;
      const focusable = focusableInPanel();
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    const openAnnotations = annotations.filter(function (annotation) {
      return annotation.classList.contains("open");
    });
    openAnnotations.forEach(function (annotation) { setAnnotationOpen(annotation, false); });
    if (panel && !panel.hidden) {
      event.preventDefault();
      closeChat();
    } else if (openAnnotations.length && openAnnotations[0] instanceof HTMLElement) {
      openAnnotations[0].focus();
    }
  });

  if (input && form) {
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 140) + "px";
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  }

  function addMessage(role, message) {
    if (!log) return null;
    const item = document.createElement("div");
    item.className = "chat-msg " + role;
    item.setAttribute("aria-label", role === "user" ? "나" : "AI");
    item.textContent = message;
    log.appendChild(item);
    log.scrollTop = log.scrollHeight;
    return item;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function inlineMd(escaped) {
    var codes = [];
    var s = escaped.replace(/`([^`]+)`/g, function (_m, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return "<code>" + codes[i] + "</code>"; });
    return s;
  }

  // Minimal, safe markdown: escapes first, then renders bold/italic/code and
  // bullet/numbered lists. Chat answers arrive as markdown but were shown raw.
  function renderMarkdown(src) {
    var lines = String(src == null ? "" : src).replace(/\r/g, "").split("\n");
    var html = "", listType = null, para = [];
    function inline(x) { return inlineMd(escapeHtml(x)); }
    function flushPara() { if (para.length) { html += "<p>" + para.join("<br>") + "</p>"; para = []; } }
    function closeList() { if (listType) { html += "</" + listType + ">"; listType = null; } }
    for (var idx = 0; idx < lines.length; idx++) {
      var line = lines[idx].trim();
      if (!line) { flushPara(); closeList(); continue; }
      var h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) { flushPara(); closeList(); html += '<p class="chat-h"><strong>' + inline(h[1]) + "</strong></p>"; continue; }
      var ul = line.match(/^[-*\u2022]\s+(.*)$/);
      var ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ul) { flushPara(); if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; } html += "<li>" + inline(ul[1]) + "</li>"; }
      else if (ol) { flushPara(); if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; } html += "<li>" + inline(ol[1]) + "</li>"; }
      else { closeList(); para.push(inline(line)); }
    }
    flushPara(); closeList();
    return html;
  }

  // Turn "근거 N" (incl. "근거 1, 4") into buttons that reveal the matching source.
  function linkifyCites(html) {
    return html.replace(/근거\s*(\d+(?:\s*,\s*\d+)*)/g, function (_m, nums) {
      return nums.split(/\s*,\s*/).map(function (n) {
        return '<button type="button" class="cite-ref" data-ref="' + n + '">근거 ' + n + "</button>";
      }).join(", ");
    });
  }

  function wireCites(bubble) {
    bubble.querySelectorAll(".cite-ref").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var n = parseInt(btn.getAttribute("data-ref"), 10);
        var details = bubble.querySelector(".chat-sources");
        if (!details || !n) return;
        details.open = true;
        var target = details.querySelectorAll(".chat-source")[n - 1];
        if (!target) return;
        target.scrollIntoView({ block: "nearest" });
        target.classList.add("cite-flash");
        setTimeout(function () { target.classList.remove("cite-flash"); }, 1200);
      });
    });
  }

  function renderSources(bubble, sources) {
    if (!bubble || !Array.isArray(sources) || sources.length === 0) return;
    const details = document.createElement("details");
    details.className = "chat-sources";
    const summary = document.createElement("summary");
    summary.textContent = "원문 근거 " + sources.length + "곳";
    details.appendChild(summary);
    sources.forEach(function (source, index) {
      if (!source || typeof source.text !== "string") return;
      const quote = document.createElement("blockquote");
      quote.className = "chat-source";
      quote.setAttribute("data-ref", String(index + 1));
      if (source.section) {
        const cite = document.createElement("cite");
        cite.className = "chat-source-section";
        cite.textContent = source.section;
        quote.appendChild(cite);
      }
      const p = document.createElement("p");
      p.textContent = source.text;
      quote.appendChild(p);
      details.appendChild(quote);
    });
    bubble.appendChild(details);
    if (log) log.scrollTop = log.scrollHeight;
  }

  function setChatBusy(nextBusy) {
    busy = nextBusy;
    if (log) log.setAttribute("aria-busy", String(nextBusy));
    if (form) form.setAttribute("aria-busy", String(nextBusy));
    if (input) {
      input.readOnly = nextBusy;
      input.setAttribute("aria-disabled", String(nextBusy));
    }
    const submit = form && form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = nextBusy;
    document.querySelectorAll(".ask-chip").forEach(function (chip) { chip.disabled = nextBusy; });
  }

  function removeTurn(turn) {
    const index = history.lastIndexOf(turn);
    if (index >= 0) history.splice(index, 1);
  }

  function showRetry(messageElement, message, question) {
    if (!messageElement) return;
    messageElement.classList.remove("chat-typing");
    messageElement.classList.add("chat-error");
    messageElement.setAttribute("role", "alert");
    messageElement.textContent = message + " ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "chat-retry";
    retry.textContent = "다시 시도";
    retry.addEventListener("click", function () {
      messageElement.remove();
      send(question, false);
    });
    messageElement.appendChild(retry);
  }

  // Render a completed answer bubble: markdown + interactive citations + sources.
  function finalizeAnswer(bubble, answer, sources) {
    if (!bubble) return;
    bubble.classList.remove("chat-typing", "streaming");
    var hasSources = !!(sources && Array.isArray(sources) && sources.length);
    var rendered = renderMarkdown(answer);
    bubble.innerHTML = hasSources ? linkifyCites(rendered) : rendered;
    bubble.classList.add("md");
    renderSources(bubble, sources);
    if (hasSources) wireCites(bubble);
  }

  async function send(question, renderUser) {
    const q = (question || "").trim();
    if (!q || busy || !form || !log || !slug) return;
    setChatBusy(true);
    if (renderUser !== false) addMessage("user", q);
    const userTurn = { role: "user", content: q };
    history.push(userTurn);
    const pending = addMessage("bot", "답변을 작성하고 있어요…");
    if (pending) pending.classList.add("chat-typing");

    try {
      const endpoint = new URL("../api/chat", window.location.href);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug, question: q, history: history.slice(0, -1) }),
      });
      var ctype = response.headers.get("content-type") || "";
      if (!response.ok) {
        removeTurn(userTurn);
        var edata = null;
        try { edata = await response.json(); } catch (_err) {}
        var serverMessage = edata && (edata.error || edata.answer);
        var fallback = response.status === 404
          ? "AI 질문은 arxiblog serve로 실행할 때 사용할 수 있어요."
          : response.status === 429
            ? "요청이 많아 잠시 답변할 수 없어요. 잠시 후 다시 시도해 주세요."
            : "답변을 가져오지 못했어요 (" + response.status + ").";
        showRetry(pending, serverMessage || fallback, q);
        return;
      }

      // Non-streaming JSON (chat disabled / no API key configured).
      if (ctype.indexOf("text/event-stream") === -1) {
        var jdata = null;
        try { jdata = await response.json(); } catch (_err) {}
        var janswer = jdata && typeof jdata.answer === "string" ? jdata.answer.trim() : "";
        if (!janswer) {
          removeTurn(userTurn);
          showRetry(pending, "비어 있는 답변을 받았어요.", q);
          return;
        }
        finalizeAnswer(pending, janswer, jdata && jdata.sources);
        history.push({ role: "assistant", content: janswer });
        return;
      }

      // Server-Sent Events: sources, then tokens as they generate, then done.
      if (pending) {
        pending.classList.remove("chat-typing");
        pending.classList.add("streaming");
        pending.textContent = "";
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buf = "", acc = "", srcs = null, streamErr = null;
      for (;;) {
        var piece = await reader.read();
        if (piece.done) break;
        buf += decoder.decode(piece.value, { stream: true });
        var sep;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          var frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          var ev = "message", dataStr = "";
          frame.split("\n").forEach(function (ln) {
            if (ln.indexOf("event:") === 0) ev = ln.slice(6).trim();
            else if (ln.indexOf("data:") === 0) dataStr += ln.slice(5).trim();
          });
          if (!dataStr) continue;
          var payload;
          try { payload = JSON.parse(dataStr); } catch (_err) { continue; }
          if (ev === "sources") srcs = payload;
          else if (ev === "token") {
            acc += payload;
            if (pending) pending.textContent = acc;
            log.scrollTop = log.scrollHeight;
          }
          else if (ev === "error") streamErr = (payload && payload.message) || "답변 중 오류가 발생했어요.";
        }
      }
      var answer = acc.trim();
      if (!answer) {
        removeTurn(userTurn);
        showRetry(pending, streamErr || "비어 있는 답변을 받았어요.", q);
        return;
      }
      finalizeAnswer(pending, answer, srcs);
      history.push({ role: "assistant", content: answer });
    } catch (_err) {
      removeTurn(userTurn);
      showRetry(pending, "서버에 연결할 수 없어요. 실행 상태를 확인해 주세요.", q);
    } finally {
      setChatBusy(false);
      log.scrollTop = log.scrollHeight;
    }
  }

  if (form && input) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const question = input.value.trim();
      if (!question || busy) return;
      input.value = "";
      input.style.height = "auto";
      send(question, true);
    });
  }

  document.querySelectorAll(".ask-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      openChat();
      send(chip.getAttribute("data-q"), true);
    });
  });

  // ── Select-to-ask ──
  const postBody = document.querySelector(".post-body");
  if (postBody && form) {
    const askButton = document.createElement("button");
    askButton.type = "button";
    askButton.className = "select-ask";
    askButton.textContent = "🤔 이 부분 물어보기";
    askButton.setAttribute("aria-label", "선택한 문장을 AI에게 질문하기");
    askButton.hidden = true;
    document.body.appendChild(askButton);
    let selectedText = "";

    const hideAsk = function () { askButton.hidden = true; };
    document.addEventListener("selectionchange", function () {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { hideAsk(); return; }
      const text = selection.toString().trim();
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      if (text.length < 8 || text.length > 600 || !ancestor || !postBody.contains(ancestor)) {
        hideAsk();
        return;
      }
      selectedText = text;
      const rect = range.getBoundingClientRect();
      askButton.style.top = window.scrollY + rect.top - 44 + "px";
      askButton.style.left = window.scrollX + rect.left + rect.width / 2 + "px";
      askButton.hidden = false;
    });
    askButton.addEventListener("mousedown", function (event) { event.preventDefault(); });
    askButton.addEventListener("click", function () {
      hideAsk();
      openChat();
      send('이 부분을 쉽게 풀어서 설명해줘:\n"' + selectedText + '"', true);
      const selection = document.getSelection();
      if (selection) selection.removeAllRanges();
    });
    document.addEventListener("scroll", hideAsk, { passive: true });
    window.addEventListener("resize", hideAsk, { passive: true });
  }

  // ── Home search ──
  const search = document.getElementById("post-search");
  if (search) {
    const cards = Array.from(document.querySelectorAll("#cards .card"));
    const emptyMessage = document.getElementById("search-empty");
    const searchStatus = document.getElementById("search-status");
    const catFilter = document.getElementById("cat-filter");
    let activeCat = "";
    let announceTimer = 0;
    const normalize = function (value) {
      const text = String(value || "");
      return (text.normalize ? text.normalize("NFKC") : text).toLocaleLowerCase("ko-KR");
    };
    const filterCards = function () {
      const query = normalize(search.value.trim());
      let shown = 0;
      cards.forEach(function (card) {
        const searchHit = !query || normalize(card.getAttribute("data-search")).includes(query);
        const catHit =
          !activeCat || (" " + (card.getAttribute("data-cats") || "") + " ").indexOf(" " + activeCat + " ") >= 0;
        const hit = searchHit && catHit;
        card.hidden = !hit;
        if (hit) shown++;
      });
      if (emptyMessage) emptyMessage.hidden = shown !== 0;
      window.clearTimeout(announceTimer);
      announceTimer = window.setTimeout(function () {
        if (searchStatus) {
          searchStatus.textContent = query
            ? shown
              ? "검색 결과 " + shown + "개"
              : "검색 결과가 없습니다. 다른 검색어를 입력해 보세요."
            : "";
        }
      }, 120);
    };
    search.addEventListener("input", filterCards);
    search.addEventListener("search", filterCards);
    if (catFilter) {
      catFilter.addEventListener("click", function (event) {
        const chip = event.target.closest(".cat-chip");
        if (!chip) return;
        activeCat = chip.getAttribute("data-cat") || "";
        catFilter.querySelectorAll(".cat-chip").forEach(function (c) {
          const on = c === chip;
          c.classList.toggle("active", on);
          c.setAttribute("aria-pressed", on ? "true" : "false");
        });
        filterCards();
      });
    }
    search.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && search.value) {
        event.preventDefault();
        search.value = "";
        filterCards();
      }
    });
  }

  // ── Engagement: views + reactions + newsletter ──
  (function engagement() {
    function apiUrl(p) { try { return new URL("../api/" + p, window.location.href); } catch (_e) { return null; } }
    function fmt(n) { try { return Number(n).toLocaleString("ko-KR"); } catch (_e) { return String(n); } }

    var pageSlug = document.body.getAttribute("data-slug");
    var statsEl = document.getElementById("post-stats");
    var reactBtn = document.getElementById("react-btn");
    var reactCount = document.getElementById("react-count");

    function renderStats(s) {
      if (!s) return;
      if (statsEl && typeof s.views === "number") { statsEl.textContent = "조회 " + fmt(s.views); }
      if (reactCount && typeof s.reactions === "number") { reactCount.textContent = fmt(s.reactions); }
    }

    if (pageSlug && (statsEl || reactBtn)) {
      var viewUrl = apiUrl("view");
      if (viewUrl) {
        fetch(viewUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: pageSlug }),
          keepalive: true,
        }).then(function (r) { return r.ok ? r.json() : null; }).then(renderStats).catch(function () {});
      }

      var reactedKey = "arxiblog:reacted:" + pageSlug;
      var reacted = false;
      try { reacted = localStorage.getItem(reactedKey) === "1"; } catch (_e) {}
      if (reactBtn && reacted) { reactBtn.setAttribute("aria-pressed", "true"); reactBtn.classList.add("reacted"); }
      if (reactBtn) {
        reactBtn.addEventListener("click", function () {
          if (reactBtn.getAttribute("aria-pressed") === "true") return;
          reactBtn.setAttribute("aria-pressed", "true");
          reactBtn.classList.add("reacted");
          try { localStorage.setItem(reactedKey, "1"); } catch (_e) {}
          var reactUrl = apiUrl("react");
          if (!reactUrl) return;
          fetch(reactUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug: pageSlug }),
          }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
            if (d && typeof d.reactions === "number" && reactCount) { reactCount.textContent = fmt(d.reactions); }
          }).catch(function () {});
        });
      }
    }

    var subForm = document.getElementById("subscribe-form");
    var subStatus = document.getElementById("subscribe-status");
    var subEmail = document.getElementById("subscribe-email");
    if (subForm) {
      subForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var email = ((subEmail && subEmail.value) || "").trim();
        function setStatus(msg, kind) { if (subStatus) { subStatus.textContent = msg; subStatus.className = "subscribe-status" + (kind ? " " + kind : ""); } }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setStatus("유효한 이메일을 입력해 주세요.", "error"); return; }
        var subUrl = apiUrl("subscribe");
        if (!subUrl) return;
        setStatus("구독 중…", "");
        fetch(subUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: null }; }); })
          .then(function (res) {
            if (res.ok && res.d && res.d.ok) { setStatus("구독 완료! 새 글이 올라오면 알려드릴게요.", "ok"); subForm.reset(); }
            else { setStatus((res.d && res.d.error) || "구독에 실패했어요. 잠시 후 다시 시도해 주세요.", "error"); }
          }).catch(function () { setStatus("구독에 실패했어요. 잠시 후 다시 시도해 주세요.", "error"); });
      });
    }
  })();

})();
