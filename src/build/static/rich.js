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
    }).catch(function (error) {
      console.error("Mermaid rendering failed", error);
    });
  }
})();
