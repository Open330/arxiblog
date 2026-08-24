import { join, normalize, extname, sep } from "path";
import { existsSync, realpathSync, statSync } from "fs";
import {
  DB_FILE,
  loadConfig,
  saveConfig,
  DEFAULT_CHAT,
  defaultLlmModel,
  hasLlmKey,
  resolveBuildOutputDir,
} from "./config";
import { Store } from "./store";
import { LLMClient, LLMProviderError } from "./llm-client";
import { answerQuestion, type ChatTurn } from "./pipeline/chat";
import { addPaper } from "./pipeline/add";
import { parseArxivId } from "./ingest/arxiv";
import { buildSite, type BuildStore } from "./build/renderer";
import { renderAdminPage } from "./build/templates";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
};

export const MAX_API_BODY_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 2_000;
const MAX_HISTORY_TURN_CHARS = 4_000;

class HttpRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Parse a small JSON object with consistent 400/413/415 failures. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type");
  if (contentType && !/^(?:application\/(?:[\w.+-]+\+)?json)(?:\s*;|$)/i.test(contentType)) {
    throw new HttpRequestError(415, "application/json 요청만 지원합니다.");
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) {
    throw new HttpRequestError(413, "요청 본문이 너무 큽니다.");
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_API_BODY_BYTES) {
    throw new HttpRequestError(413, "요청 본문이 너무 큽니다.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpRequestError(400, "올바른 JSON 요청 본문이 필요합니다.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRequestError(400, "JSON 객체 요청 본문이 필요합니다.");
  }
  return parsed as Record<string, unknown>;
}

export function jsonError(
  error: unknown,
  report: (errorName: string) => void = (errorName) =>
    console.error(`[arxiblog] unexpected request failure: ${errorName}`)
): Response {
  if (error instanceof HttpRequestError) {
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (error instanceof LLMProviderError) {
    return Response.json(
      { error: error.message },
      {
        status: error.httpStatus,
        headers: {
          "Cache-Control": "no-store",
          ...(error.httpStatus === 429 ? { "Retry-After": "60" } : {}),
        },
      }
    );
  }
  // Parser/SQLite errors can contain config lines, file paths, or upstream
  // payloads. Keep details out of the response and even the private log text.
  report(error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { Allow: allow, "Cache-Control": "no-store" } }
  );
}

/** Minimal liveness response for process/tunnel supervisors; exposes no config. */
export function healthResponse(method: string): Response {
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  return new Response(method === "HEAD" ? null : JSON.stringify({ status: "ok" }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * SQLite-backed limiter. Supplying the application's Store makes quotas durable
 * across restarts and shared by multiple server processes. The clock-only
 * overload is retained for callers/tests that used the old factory signature.
 */
export function makeChatLimiter(store: Store, now?: () => number): ReturnType<typeof createChatLimiter>;
export function makeChatLimiter(now?: () => number): ReturnType<typeof createChatLimiter>;
export function makeChatLimiter(storeOrNow?: Store | (() => number), injectedNow?: () => number) {
  const store = storeOrNow instanceof Store ? storeOrNow : new Store(":memory:");
  const now = typeof storeOrNow === "function" ? storeOrNow : (injectedNow || (() => Date.now()));
  return createChatLimiter(store, now);
}

function createChatLimiter(store: Store, now: () => number) {
  return {
    /** Admission and reservation happen in one cross-process transaction. */
    gate(ip: string, perIpPerHour: number, globalPerDay: number, maxInFlight = 0): {
      ok: boolean;
      reason?: string;
      retryAfterSeconds?: number;
      finish?: (success: boolean) => void;
    } {
      const reservation = store.reserveChatQuota(ip, perIpPerHour, globalPerDay, now(), maxInFlight);
      if (!reservation.ok) {
        return {
          ok: false,
          reason: reservation.reason === "global"
            ? "오늘 전체 챗 사용량 한도에 도달했어요. 내일 다시 시도해 주세요."
            : reservation.reason === "concurrency"
              ? "질문이 몰리고 있어요. 잠시 후 다시 시도해 주세요."
              : "잠시 후 다시 시도해 주세요. (시간당 질문 한도를 초과했어요)",
          retryAfterSeconds: reservation.reason === "concurrency" ? 10 : 60,
        };
      }
      let finished = false;
      return {
        ok: true,
        finish(success: boolean) {
          if (finished) return;
          finished = true;
          store.settleChatQuota(reservation.reservationId, success, now());
        },
      };
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

function confinedRealPath(root: string, filePath: string): string | null {
  try {
    const rootReal = realpathSync(root);
    const fileReal = realpathSync(filePath);
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) return null;
    return fileReal;
  } catch {
    return null;
  }
}

export function startServer(projectRoot: string, port: number, host = "localhost"): void {
  const initialConfig = loadConfig(projectRoot);
  const siteDir = resolveBuildOutputDir(projectRoot, initialConfig.build.output_dir);
  const store = new Store(join(projectRoot, DB_FILE));
  const adminToken = crypto.randomUUID().replace(/-/g, "");

  const chatLimiter = makeChatLimiter(store);

  // Lightweight in-memory guards for the public engagement endpoints.
  const viewSeen = new Set<string>(); // `${ip}|${slug}|${day}` — one view per IP/post/day
  const reactSeen = new Set<string>(); // `${ip}|${slug}` — one reaction per IP/post
  const engageHits = new Map<string, number[]>(); // per-IP flood guard
  const engageOk = (ip: string): boolean => {
    const now = Date.now();
    const recent = (engageHits.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 120) return false; // 120 engagement req / IP / min
    recent.push(now);
    engageHits.set(ip, recent);
    if (engageHits.size > 5000)
      for (const [k, v] of engageHits) if (!v.some((t) => now - t < 60_000)) engageHits.delete(k);
    return true;
  };

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
    maxRequestBodySize: MAX_API_BODY_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // ── Unauthenticated liveness probe (no configuration/DB details) ──
      if (path === "/healthz") return healthResponse(req.method);

      // ── Admin page (form only; mutations require the token) ──
      if (path === "/admin" && req.method === "GET") {
        return new Response(renderAdminPage(loadConfig(projectRoot)), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (path === "/admin") return methodNotAllowed("GET");

      // ── Public read APIs ──
      if (path === "/api/chat" && req.method === "POST") {
        const chatCfg = { ...DEFAULT_CHAT, ...(loadConfig(projectRoot).chat || {}) }; // re-read so config edits apply
        if (!chatCfg.enabled) {
          return Response.json({ answer: "이 사이트에서는 AI 챗이 꺼져 있어요." }, { status: 200 });
        }
        const gate = chatLimiter.gate(
          clientIp(req, server, chatCfg.trust_proxy),
          chatCfg.per_ip_per_hour,
          chatCfg.global_per_day,
          chatCfg.max_in_flight
        );
        if (!gate.ok) return Response.json(
          { error: gate.reason },
          {
            status: 429,
            headers: {
              "Cache-Control": "no-store",
              "Retry-After": String(gate.retryAfterSeconds || 60),
            },
          }
        );
        let success = false;
        try {
          return await handleChat(req, projectRoot, store, () => { success = true; });
        } finally {
          gate.finish?.(success);
        }
      }
      if (path === "/api/chat") return methodNotAllowed("POST");
      if (path === "/api/posts" && req.method === "GET") {
        return Response.json({
          posts: store.listPosts().map((p) => ({
            slug: p.slug, title: p.title, arxiv_id: p.arxiv_id,
            reading_minutes: p.reading_minutes, persona: p.persona, level: p.level,
          })),
        }, { headers: { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
      }
      if (path === "/api/posts") return methodNotAllowed("GET");

      // ── Engagement (public, abuse-guarded, best-effort) ──
      const engIp = () => clientIp(req, server, !!initialConfig.chat?.trust_proxy);
      if (path === "/api/view" && req.method === "POST") {
        const ip = engIp();
        if (!engageOk(ip)) return Response.json({ views: 0, reactions: 0 }, { status: 429 });
        try {
          const { slug } = (await req.json()) as { slug?: string };
          if (slug && store.getPost(slug)) {
            const key = `${ip}|${slug}|${new Date(Date.now()).toISOString().slice(0, 10)}`;
            if (!viewSeen.has(key)) { viewSeen.add(key); store.incrementView(slug); }
            return Response.json(store.getStats(slug));
          }
        } catch { /* ignore */ }
        return Response.json({ views: 0, reactions: 0 });
      }
      if (path === "/api/view") return methodNotAllowed("POST");
      if (path === "/api/react" && req.method === "POST") {
        const ip = engIp();
        if (!engageOk(ip)) return Response.json({ error: "잠시 후 다시 시도해 주세요." }, { status: 429 });
        try {
          const { slug } = (await req.json()) as { slug?: string };
          if (!slug || !store.getPost(slug)) return Response.json({ error: "글을 찾을 수 없습니다." }, { status: 404 });
          const key = `${ip}|${slug}`;
          const reactions = reactSeen.has(key) ? store.getStats(slug).reactions : (reactSeen.add(key), store.incrementReaction(slug));
          return Response.json({ reactions });
        } catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
      }
      if (path === "/api/react") return methodNotAllowed("POST");
      if (path === "/api/stats" && req.method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        return Response.json(store.getStats(slug), { headers: { "Cache-Control": "no-cache" } });
      }
      if (path === "/api/stats") return methodNotAllowed("GET");
      if (path === "/api/subscribe" && req.method === "POST") {
        const ip = engIp();
        if (!engageOk(ip)) return Response.json({ error: "잠시 후 다시 시도해 주세요." }, { status: 429 });
        try {
          const { email } = (await req.json()) as { email?: string };
          const e = (email || "").trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 200) {
            return Response.json({ error: "유효한 이메일을 입력해 주세요." }, { status: 400 });
          }
          store.addSubscriber(e);
          return Response.json({ ok: true });
        } catch (err) { return Response.json({ error: (err as Error).message }, { status: 500 }); }
      }
      if (path === "/api/subscribe") return methodNotAllowed("POST");

      // ── Token-gated admin APIs ──
      if (path === "/api/config" && req.method === "GET") {
        if (!tokenOk(req, url)) return Response.json(
          { error: "unauthorized" },
          { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } }
        );
        const c = loadConfig(projectRoot);
        return Response.json({
          provider: c.llm.provider, model: c.llm.model, endpoint: c.llm.endpoint,
          hasKey: hasLlmKey(c.llm), keyPool: (c.llm.api_keys || []).length, hasPaid: !!c.llm.api_key_paid,
          active_persona: c.active_persona, default_level: c.default_level,
          personas: (c.personas || []).map((p) => ({ name: p.name, description: p.description })),
        }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }
      if (path === "/api/config") return methodNotAllowed("GET");
      if (path === "/api/settings" && req.method === "POST") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return serialize(() => handleSettings(req, projectRoot));
      }
      if (path === "/api/settings") return methodNotAllowed("POST");
      if (path === "/api/add" && req.method === "POST") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return serialize(() => handleAdd(req, projectRoot, store));
      }
      if (path === "/api/add") return methodNotAllowed("POST");
      if (path === "/api/delete" && req.method === "POST") {
        if (!tokenOk(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return serialize(() => handleDelete(req, projectRoot, store));
      }
      if (path === "/api/delete") return methodNotAllowed("POST");
      if (path.startsWith("/api/")) {
        return Response.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      }

      // ── Static files ──
      if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET, HEAD");
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
          return new Response(req.method === "HEAD" ? null : Bun.file(notFound), {
            status: 404,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      }
      const confined = confinedRealPath(siteDir, filePath);
      if (!confined) return new Response("Forbidden", { status: 403 });
      const extension = extname(confined).toLowerCase();
      return new Response(req.method === "HEAD" ? null : Bun.file(confined), {
        headers: {
          "Content-Type": MIME[extension] || "application/octet-stream",
          "Cache-Control": [".html", ".json", ".css", ".js"].includes(extension) ? "no-cache" : "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    error() {
      return new Response("Internal error", { status: 500 });
    },
  });

  const shown = host === "0.0.0.0" ? "localhost" : host;
  console.log(`\x1b[32m🚀 arxiblog 서버 실행 중:\x1b[0m http://${shown}:${port}`);
  if (host === "0.0.0.0") console.log(`   LAN: 같은 네트워크에서 http://<이-기기-IP>:${port}`);
  // A URL fragment is never sent to the server/proxy, so the bearer token does
  // not enter Cloudflare or access logs on the initial admin-page request.
  console.log(`\x1b[34m🔧 관리 페이지:\x1b[0m http://${shown}:${port}/admin#token=${adminToken}`);
  console.log(`   (정지: Ctrl+C)`);
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxChars: number
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpRequestError(400, `${key}는 문자열이어야 합니다.`);
  const trimmed = value.trim();
  if (trimmed.length > maxChars) throw new HttpRequestError(400, `${key}가 너무 깁니다.`);
  return trimmed;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpRequestError(400, `${key}는 boolean이어야 합니다.`);
  return value;
}

async function handleChat(
  req: Request,
  projectRoot: string,
  store: Store,
  onSuccess: () => void
): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const slug = optionalString(body, "slug", 120) || "";
    const question = optionalString(body, "question", MAX_QUESTION_CHARS) || "";
    if (!slug || !question) return Response.json({ error: "slug과 question이 필요합니다." }, { status: 400 });

    const rawHistory = body.history ?? [];
    if (!Array.isArray(rawHistory)) throw new HttpRequestError(400, "history는 배열이어야 합니다.");
    const history: ChatTurn[] = rawHistory.slice(-6).map((turn) => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
        throw new HttpRequestError(400, "history 항목 형식이 올바르지 않습니다.");
      }
      const role = (turn as Record<string, unknown>).role;
      const content = (turn as Record<string, unknown>).content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
        throw new HttpRequestError(400, "history 항목 형식이 올바르지 않습니다.");
      }
      if (content.length > MAX_HISTORY_TURN_CHARS) {
        throw new HttpRequestError(400, "history 항목이 너무 깁니다.");
      }
      return { role, content };
    });

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
    const { answer, sources } = await answerQuestion(llm, store, post, question, history);
    onSuccess(); // charge quota as soon as the paid/upstream answer was produced
    const u = llm.getUsageStats();
    store.addUsageLog(null, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, llm.getEstimatedCost());
    return Response.json({ answer, sources });
  } catch (e) {
    return jsonError(e);
  }
}

async function handleAdd(req: Request, projectRoot: string, store: Store): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const source = optionalString(body, "source", 512) || "";
    const level = optionalString(body, "level", 32);
    const persona = optionalString(body, "persona", 100);
    if (!source) return Response.json({ error: "arXiv ID 또는 URL이 필요합니다." }, { status: 400 });
    try {
      parseArxivId(source);
    } catch (error) {
      throw new HttpRequestError(400, (error as Error).message);
    }
    if (level && level !== "beginner" && level !== "intermediate") {
      throw new HttpRequestError(400, "level은 beginner 또는 intermediate여야 합니다.");
    }
    const config = loadConfig(projectRoot);
    if (!hasLlmKey(config.llm)) return Response.json({ error: "LLM API 키가 설정되지 않았습니다." }, { status: 400 });
    if (persona && !(config.personas || []).some((item) => item.name === persona)) {
      throw new HttpRequestError(400, `알 수 없는 persona입니다: ${persona}`);
    }

    const result = await addPaper(store, config, source, { level, persona });
    await buildSite(store, config, projectRoot);
    return Response.json({
      ok: true, slug: result.slug, title: result.title, arxiv_id: result.arxivId,
      annotations: result.annotationCount, minutes: result.minutes,
      tokens: result.usage.totalTokens, cost: result.cost,
    });
  } catch (e) {
    return jsonError(e);
  }
}

export async function handleSettings(req: Request, projectRoot: string): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const provider = optionalString(body, "provider", 40);
    const model = optionalString(body, "model", 200);
    const apiKey = optionalString(body, "api_key", 16_384);
    const endpoint = optionalString(body, "endpoint", 2_048);
    const activePersona = optionalString(body, "active_persona", 100);
    const defaultLevel = optionalString(body, "default_level", 32);
    const clearApiKeys = optionalBoolean(body, "clear_api_keys") || false;
    const config = loadConfig(projectRoot);
    if (provider && !["gemini", "openai", "anthropic", "azure-openai"].includes(provider)) {
      throw new HttpRequestError(400, `지원하지 않는 provider입니다: ${provider}`);
    }
    if (activePersona && !(config.personas || []).some((item) => item.name === activePersona)) {
      throw new HttpRequestError(400, `알 수 없는 persona입니다: ${activePersona}`);
    }
    if (defaultLevel && defaultLevel !== "beginner" && defaultLevel !== "intermediate") {
      throw new HttpRequestError(400, "default_level은 beginner 또는 intermediate여야 합니다.");
    }
    if (clearApiKeys && apiKey) {
      throw new HttpRequestError(400, "API Key 저장과 전체 삭제를 동시에 요청할 수 없습니다.");
    }
    const providerChanged = !!provider && provider !== config.llm.provider;
    const previousModel = config.llm.model;
    if (providerChanged) {
      // api_key is a legacy shared field. Never carry a credential across
      // providers: doing so could send an OpenAI key to Google (or vice versa).
      config.llm.api_key = "";
      config.llm.api_keys = [];
      config.llm.api_key_paid = "";
      config.llm.endpoint = "";
      // A model identifier almost never belongs to two providers. Reset first
      // so an API client that resends the old form value cannot save an
      // immediately broken provider/model combination.
      config.llm.model = defaultLlmModel(provider);
    }
    if (provider) config.llm.provider = provider;
    if (model && (!providerChanged || model !== previousModel)) config.llm.model = model;
    if (clearApiKeys) {
      config.llm.api_key = "";
      config.llm.api_keys = [];
      config.llm.api_key_paid = "";
    } else if (apiKey) {
      config.llm.api_key = apiKey;
    }
    if (endpoint !== undefined && (!providerChanged || provider === "azure-openai")) {
      config.llm.endpoint = endpoint;
    }
    if (activePersona) config.active_persona = activePersona;
    if (defaultLevel) config.default_level = defaultLevel;
    saveConfig(projectRoot, config);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

async function handleDelete(req: Request, projectRoot: string, store: Store): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const slug = optionalString(body, "slug", 120) || "";
    if (!slug) return Response.json({ error: "slug이 필요합니다." }, { status: 400 });
    if (!store.getPost(slug)) return Response.json({ error: "글을 찾을 수 없습니다." }, { status: 404 });
    // Build the post-less site before mutating SQLite. If rendering fails, both
    // the database and the last-known-good static site still contain the post,
    // so the user can safely retry instead of ending up in a split-brain state.
    const remaining = store.listPosts().filter((post) => post.slug !== slug);
    const buildView: BuildStore = {
      listPosts: () => remaining,
      getAnnotations: (postId) => store.getAnnotations(postId),
    };
    await buildSite(buildView, loadConfig(projectRoot), projectRoot);
    store.deletePost(slug);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
