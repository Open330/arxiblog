import { join, normalize, extname, sep } from "path";
import { existsSync, statSync } from "fs";
import { DB_FILE, loadConfig, saveConfig, DEFAULT_CHAT, hasLlmKey } from "./config";
import { Store } from "./store";
import { LLMClient } from "./llm-client";
import { answerQuestion, type ChatTurn } from "./pipeline/chat";
import { addPaper } from "./pipeline/add";
import { buildSite } from "./build/renderer";
import { renderAdminPage } from "./build/templates";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * In-memory sliding-window rate limiter for the public chat endpoint.
 * Guards both per-IP abuse and a global daily cap (to protect the LLM free quota).
 */
function makeChatLimiter() {
  const ipHits = new Map<string, number[]>();
  let day = Math.floor(Date.now() / 86_400_000);
  let dayCount = 0; // counts SUCCESSFUL answers only (protects the LLM quota)
  const rollover = (now: number) => {
    const today = Math.floor(now / 86_400_000);
    if (today !== day) { day = today; dayCount = 0; ipHits.clear(); }
  };
  return {
    /** Admission check. Counts the attempt against the per-IP window (abuse guard);
     *  the global/day cap is only checked here, never incremented (see noteSuccess). */
    gate(ip: string, perIpPerHour: number, globalPerDay: number): { ok: boolean; reason?: string } {
      const now = Date.now();
      rollover(now);
      if (globalPerDay > 0 && dayCount >= globalPerDay) {
        return { ok: false, reason: "오늘 전체 챗 사용량 한도에 도달했어요. 내일 다시 시도해 주세요." };
      }
      const recent = (ipHits.get(ip) || []).filter((t) => now - t < 3_600_000);
      if (perIpPerHour > 0 && recent.length >= perIpPerHour) {
        return { ok: false, reason: "잠시 후 다시 시도해 주세요. (시간당 질문 한도를 초과했어요)" };
      }
      recent.push(now);
      ipHits.set(ip, recent);
      if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < 3_600_000)) ipHits.delete(k);
      return { ok: true };
    },
    /** Call only after a real LLM answer was produced — charges the daily global cap. */
    noteSuccess() {
      rollover(Date.now());
      dayCount++;
    },
  };
}

function clientIp(
  req: Request,
  server: { requestIP?: (r: Request) => { address: string } | null } | undefined,
  trustProxy: boolean
): string {
  // Only trust forwarding headers behind a trusted proxy (e.g. Cloudflare); otherwise
  // clients could spoof them to dodge the per-IP limit. Default: socket address.
  if (trustProxy) {
    const fwd = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return server?.requestIP?.(req)?.address || "unknown";
}

function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const rootNorm = normalize(root);
  const full = normalize(join(root, decoded));
  if (full !== rootNorm && !full.startsWith(rootNorm + sep)) return null;
  return full;
}

export function startServer(projectRoot: string, port: number, host = "localhost"): void {
  const initialConfig = loadConfig(projectRoot);
  const siteDir = join(projectRoot, initialConfig.build.output_dir);
  const store = new Store(join(projectRoot, DB_FILE));
  const adminToken = crypto.randomUUID().replace(/-/g, "");

  const chatLimiter = makeChatLimiter();

  // Serialize add/settings/delete so concurrent writes + rebuilds don't race.
  let writeChain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  };

  const tokenOk = (req: Request, url: URL): boolean => {
    const t =
      url.searchParams.get("token") ||
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    return t === adminToken;
  };

  Bun.serve({
    port,
    hostname: host,
    idleTimeout: 255, // allow long LLM calls during /api/add
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // ── Admin page (form only; mutations require the token) ──
      if (path === "/admin" && req.method === "GET") {
        return new Response(renderAdminPage(loadConfig(projectRoot)), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── Public read APIs ──
      if (path === "/api/chat" && req.method === "POST") {
        const chatCfg = { ...DEFAULT_CHAT, ...(loadConfig(projectRoot).chat || {}) }; // re-read so config edits apply
        if (!chatCfg.enabled) {
          return Response.json({ answer: "이 사이트에서는 AI 챗이 꺼져 있어요." }, { status: 200 });
        }
        const gate = chatLimiter.gate(clientIp(req, server, chatCfg.trust_proxy), chatCfg.per_ip_per_hour, chatCfg.global_per_day);
        if (!gate.ok) return Response.json({ error: gate.reason }, { status: 429 });
        return handleChat(req, projectRoot, store, () => chatLimiter.noteSuccess());
      }
      if (path === "/api/posts" && req.method === "GET") {
        return Response.json({
          posts: store.listPosts().map((p) => ({
            slug: p.slug, title: p.title, arxiv_id: p.arxiv_id,
            reading_minutes: p.reading_minutes, persona: p.persona, level: p.level,
          })),
        });
      }

      // ── Token-gated admin APIs ──
      if (path === "/api/config" && req.method === "GET") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const c = loadConfig(projectRoot);
        return Response.json({
          provider: c.llm.provider, model: c.llm.model, endpoint: c.llm.endpoint,
          hasKey: hasLlmKey(c.llm), keyPool: (c.llm.api_keys || []).length, hasPaid: !!c.llm.api_key_paid,
          active_persona: c.active_persona, default_level: c.default_level,
          personas: (c.personas || []).map((p) => ({ name: p.name, description: p.description })),
        });
      }
      if (path === "/api/settings" && req.method === "POST") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return serialize(() => handleSettings(req, projectRoot));
      }
      if (path === "/api/add" && req.method === "POST") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return serialize(() => handleAdd(req, projectRoot, store));
      }
      if (path === "/api/delete" && req.method === "POST") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return serialize(() => handleDelete(req, projectRoot, store));
      }

      // ── Static files ──
      let pathname = path === "/" ? "/index.html" : path;
      let filePath = safeJoin(siteDir, pathname);
      if (!filePath) return new Response("Forbidden", { status: 403 });
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
      } else if (!existsSync(filePath) && !extname(filePath)) {
        if (existsSync(filePath + ".html")) filePath += ".html";
      }
      if (!existsSync(filePath)) {
        const notFound = join(siteDir, "404.html");
        if (existsSync(notFound)) {
          return new Response(Bun.file(notFound), {
            status: 404,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response("Not found", { status: 404 });
      }
      return new Response(Bun.file(filePath), {
        headers: { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" },
      });
    },
    error() {
      return new Response("Internal error", { status: 500 });
    },
  });

  const shown = host === "0.0.0.0" ? "localhost" : host;
  console.log(`\x1b[32m🚀 arxiblog 서버 실행 중:\x1b[0m http://${shown}:${port}`);
  if (host === "0.0.0.0") console.log(`   LAN: 같은 네트워크에서 http://<이-기기-IP>:${port}`);
  console.log(`\x1b[34m🔧 관리 페이지:\x1b[0m http://${shown}:${port}/admin?token=${adminToken}`);
  console.log(`   (정지: Ctrl+C)`);
}

async function handleChat(
  req: Request,
  projectRoot: string,
  store: Store,
  onSuccess: () => void
): Promise<Response> {
  try {
    const body = (await req.json()) as { slug?: string; question?: string; history?: ChatTurn[] };
    const slug = (body.slug || "").trim();
    const question = (body.question || "").trim();
    if (!slug || !question) return Response.json({ error: "slug과 question이 필요합니다." }, { status: 400 });

    const config = loadConfig(projectRoot);
    if (!hasLlmKey(config.llm) || config.llm.provider === "demo") {
      return Response.json(
        { answer: "LLM API 키가 설정되어 있지 않아 채팅을 사용할 수 없어요. 관리 페이지에서 키를 넣어주세요." },
        { status: 200 }
      );
    }
    const post = store.getPost(slug);
    if (!post) return Response.json({ error: "글을 찾을 수 없습니다." }, { status: 404 });
    const llm = new LLMClient(config.llm);
    const answer = await answerQuestion(llm, store, post, question, body.history || []);
    const u = llm.getUsageStats();
    store.addUsageLog(null, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, llm.getEstimatedCost());
    onSuccess(); // charge the daily global quota only for a real answer
    return Response.json({ answer });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function handleAdd(req: Request, projectRoot: string, store: Store): Promise<Response> {
  try {
    const body = (await req.json()) as { source?: string; level?: string; persona?: string };
    const source = (body.source || "").trim();
    if (!source) return Response.json({ error: "arXiv ID 또는 URL이 필요합니다." }, { status: 400 });
    const config = loadConfig(projectRoot);
    if (!hasLlmKey(config.llm)) return Response.json({ error: "LLM API 키가 설정되지 않았습니다." }, { status: 400 });

    const result = await addPaper(store, config, source, { level: body.level, persona: body.persona });
    await buildSite(store, config, projectRoot);
    return Response.json({
      ok: true, slug: result.slug, title: result.title, arxiv_id: result.arxivId,
      annotations: result.annotationCount, minutes: result.minutes,
      tokens: result.usage.totalTokens, cost: result.cost,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function handleSettings(req: Request, projectRoot: string): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<{
      provider: string; model: string; api_key: string; endpoint: string;
      active_persona: string; default_level: string;
    }>;
    const config = loadConfig(projectRoot);
    if (body.provider) config.llm.provider = body.provider;
    if (body.model) config.llm.model = body.model;
    if (typeof body.api_key === "string" && body.api_key.trim()) config.llm.api_key = body.api_key.trim();
    if (typeof body.endpoint === "string") config.llm.endpoint = body.endpoint;
    if (body.active_persona) config.active_persona = body.active_persona;
    if (body.default_level) config.default_level = body.default_level;
    saveConfig(projectRoot, config);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function handleDelete(req: Request, projectRoot: string, store: Store): Promise<Response> {
  try {
    const body = (await req.json()) as { slug?: string };
    const slug = (body.slug || "").trim();
    if (!slug) return Response.json({ error: "slug이 필요합니다." }, { status: 400 });
    if (!store.getPost(slug)) return Response.json({ error: "글을 찾을 수 없습니다." }, { status: 404 });
    store.deletePost(slug);
    await buildSite(store, loadConfig(projectRoot), projectRoot);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
