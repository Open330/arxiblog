import { parse, stringify } from "smol-toml";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

export const CONFIG_FILE = "arxiblog.toml";
export const DB_FILE = "arxiblog.db";
export const SITE_DIR = "_site";

export const DEFAULT_LLM_MODELS: Readonly<Record<string, string>> = {
  gemini: "gemini-3.1-flash-lite",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4-nano",
  "azure-openai": "gpt-5.4-nano",
};

export function defaultLlmModel(provider: string): string {
  return DEFAULT_LLM_MODELS[provider] || DEFAULT_LLM_MODELS.gemini;
}

export interface LLMConfig {
  provider: string; // "gemini" | "azure-openai" | "openai" | "anthropic"
  model: string;
  api_key: string;
  endpoint: string; // for Azure OpenAI
  /** Gemini free-tier key pool — rotated round-robin (무료 키 풀). */
  api_keys?: string[];
  /** Gemini paid fallback key, used when the free pool is rate-limited (유료 fallback). */
  api_key_paid?: string;
}

/** True if a usable LLM key is configured for the *selected* provider. */
export function hasLlmKey(c: LLMConfig): boolean {
  const present = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  if (c.provider === "gemini") {
    // Gemini supports a free-key pool and/or a paid fallback in addition to api_key.
    return present(c.api_key) || !!c.api_keys?.some(present) || present(c.api_key_paid);
  }
  // openai / anthropic / azure-openai authenticate with a single api_key.
  return present(c.api_key);
}

/**
 * A writing persona controls the voice/tone of the generated blog post.
 * `audience` and `style` are injected into the transform prompt.
 */
export interface Persona {
  name: string;
  description: string;
  audience: string; // who the post is written for
  style: string; // tone & formatting guidance injected into the prompt
}

/** Rate-limit settings for the public AI chat endpoint. */
export interface ChatConfig {
  enabled?: boolean; // false → chat endpoint returns a disabled message
  per_ip_per_hour?: number; // 0 = unlimited
  global_per_day?: number; // 0 = unlimited; protects the LLM free-tier quota
  max_in_flight?: number; // 0 = unlimited; bounds provider/socket bursts
  /** Trust CF-Connecting-IP / X-Forwarded-For for the client IP. Enable ONLY when
   * behind a trusted proxy (e.g. Cloudflare); otherwise clients can spoof per-IP limits. */
  trust_proxy?: boolean;
}

export interface ArxiblogConfig {
  project: { name: string; created: string; tagline?: string; url?: string };
  build: { output_dir: string };
  llm: LLMConfig;
  deploy: { target: string };
  personas?: Persona[];
  active_persona?: string;
  /** Default reading level for new posts: "beginner" | "intermediate" */
  default_level?: string;
  chat?: ChatConfig;
  /** Server-only settings (ignored by the static build). */
  server?: {
    /**
     * A fixed admin token for the token-gated /admin APIs. When set (≥16 chars)
     * it survives restarts so the /admin#token=… bookmark keeps working;
     * otherwise a fresh random token is generated on each server start.
     */
    admin_token?: string;
  };
  /** Optional generation features (default on). Each adds LLM cost per paper. */
  features?: {
    figures?: boolean; // fetch + explain paper figures
    translate_en?: boolean; // generate an English version of each post
    factcheck?: boolean; // verify structured claims + annotations against the source
  };
}

export const DEFAULT_CHAT: Required<ChatConfig> = {
  enabled: true,
  per_ip_per_hour: 30,
  global_per_day: 800,
  max_in_flight: 8,
  trust_proxy: false,
};

function nonNegativeInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

function getPersonasDir(): string {
  // personas/ lives at the package root, one level above src/
  return join(dirname(dirname(import.meta.path)), "personas");
}

export function loadBuiltinPersonas(): Persona[] {
  const dir = getPersonasDir();
  if (!existsSync(dir)) return [];
  const personas: Persona[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Persona;
      if (p && p.name) personas.push(p);
    } catch {
      // Skip a malformed persona file rather than crashing every command.
      console.warn(`\x1b[33m⚠ persona 파일을 건너뜁니다 (파싱 실패): ${f}\x1b[0m`);
    }
  }
  return personas;
}

export function getDefaultPersona(): Persona {
  const builtins = loadBuiltinPersonas();
  if (builtins.length > 0) return builtins[0];
  return {
    name: "friendly",
    description: "Warm, plain-language explainer for curious non-experts",
    audience: "교양 있는 일반 독자 (학계 비전공자, 개발자, 학생)",
    style: "친근하고 명료한 한국어. 비유와 일상 예시를 적극 활용하고, 전문용어는 풀어서 설명한다.",
  };
}

export function defaultConfig(name: string): ArxiblogConfig {
  const builtins = loadBuiltinPersonas();
  const personas = builtins.length > 0 ? builtins : [getDefaultPersona()];
  return {
    project: {
      name,
      created: new Date().toISOString().slice(0, 10),
      tagline: "어려운 논문을, 읽고 싶은 글로.",
    },
    build: { output_dir: SITE_DIR },
    llm: { provider: "gemini", model: defaultLlmModel("gemini"), api_key: "", endpoint: "" },
    deploy: { target: "gh-pages" },
    personas,
    active_persona: pickDefaultPersonaName(personas),
    default_level: "beginner",
    chat: { ...DEFAULT_CHAT },
  };
}

/** Prefer the documented default 'friendly'; fall back to the first available persona. */
function pickDefaultPersonaName(personas: Persona[]): string {
  return personas.find((p) => p.name === "friendly")?.name || personas[0]?.name || "friendly";
}

export function getActivePersona(config: ArxiblogConfig): Persona {
  const personas = config.personas?.length ? config.personas : [getDefaultPersona()];
  return personas.find((p) => p.name === config.active_persona) ?? personas[0];
}

export function saveConfig(root: string, config: ArxiblogConfig): void {
  // TOML attaches every bare key to the most recent table header, so top-level
  // scalars MUST be serialized before any [table]. Emit them first explicitly;
  // otherwise active_persona/default_level get swallowed by the last table and
  // are lost on the next load.
  const ordered: Record<string, unknown> = {};
  if (config.active_persona !== undefined) ordered.active_persona = config.active_persona;
  if (config.default_level !== undefined) ordered.default_level = config.default_level;
  ordered.project = config.project;
  ordered.build = config.build;
  ordered.llm = config.llm;
  ordered.deploy = config.deploy;
  if (config.chat) ordered.chat = config.chat;
  if (config.personas) ordered.personas = config.personas;
  const destination = join(root, CONFIG_FILE);
  const temporary = join(root, `.${CONFIG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    // The config contains API credentials. Write a complete, private temporary
    // file first, then atomically replace the old config so readers never see a
    // partially-written TOML document.
    writeFileSync(temporary, stringify(ordered), { encoding: "utf-8", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function loadConfig(root: string): ArxiblogConfig {
  const content = readFileSync(join(root, CONFIG_FILE), "utf-8");
  const raw = parse(content) as Partial<ArxiblogConfig> & Record<string, unknown>;

  // Deep-merge section defaults so older or hand-edited configs do not crash
  // commands merely because a newly introduced field/table is absent. Keep
  // these scalar defaults inline instead of calling defaultConfig(), which
  // would re-read every built-in persona file on each HTTP request.
  raw.project = {
    name: basename(resolve(root)),
    created: new Date().toISOString().slice(0, 10),
    tagline: "어려운 논문을, 읽고 싶은 글로.",
    ...(raw.project || {}),
  };
  raw.build = { output_dir: SITE_DIR, ...(raw.build || {}) };
  raw.llm = {
    provider: "gemini",
    model: defaultLlmModel("gemini"),
    api_key: "",
    endpoint: "",
    ...(raw.llm || {}),
  };
  // Google shut the preview endpoint down on 2026-05-25. Transparently map
  // projects created by earlier arxiblog releases to its stable replacement.
  if (raw.llm.provider === "gemini" && raw.llm.model === "gemini-3.1-flash-lite-preview") {
    raw.llm.model = defaultLlmModel("gemini");
  }
  raw.deploy = { target: "gh-pages", ...(raw.deploy || {}) };
  const chat = (raw.chat || {}) as ChatConfig;
  raw.chat = {
    enabled: typeof chat.enabled === "boolean" ? chat.enabled : DEFAULT_CHAT.enabled,
    per_ip_per_hour: nonNegativeInteger(chat.per_ip_per_hour, DEFAULT_CHAT.per_ip_per_hour, 100_000),
    global_per_day: nonNegativeInteger(chat.global_per_day, DEFAULT_CHAT.global_per_day, 10_000_000),
    max_in_flight: nonNegativeInteger(chat.max_in_flight, DEFAULT_CHAT.max_in_flight, 256),
    trust_proxy: typeof chat.trust_proxy === "boolean" ? chat.trust_proxy : DEFAULT_CHAT.trust_proxy,
  };
  const server = (raw.server || {}) as { admin_token?: unknown };
  raw.server = { admin_token: typeof server.admin_token === "string" ? server.admin_token.trim() : "" };
  const personas = raw.personas?.length
    ? raw.personas
    : (() => {
        const builtins = loadBuiltinPersonas();
        return builtins.length ? builtins : [getDefaultPersona()];
      })();
  raw.personas = personas;
  if (!raw.active_persona) {
    raw.active_persona = pickDefaultPersonaName(personas);
  }
  if (!raw.default_level) raw.default_level = "beginner";
  return raw as ArxiblogConfig;
}

/**
 * Resolve the generated-site directory without allowing a config typo (or a
 * symlinked parent) to escape the project and delete/serve unrelated files.
 */
export function resolveBuildOutputDir(root: string, configuredPath: string): string {
  if (typeof configuredPath !== "string" || !configuredPath.trim()) {
    throw new Error("build.output_dir는 비어 있지 않은 상대 경로여야 합니다.");
  }
  if (isAbsolute(configuredPath)) {
    throw new Error("build.output_dir는 프로젝트 내부의 상대 경로여야 합니다.");
  }

  const projectRoot = realpathSync(resolve(root));
  const outputDir = resolve(projectRoot, configuredPath);
  const rel = relative(projectRoot, outputDir);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("build.output_dir는 프로젝트 루트가 아닌 내부 디렉터리여야 합니다.");
  }

  // Resolve the nearest existing ancestor. This catches paths such as
  // `public/site` when `public` is a symlink to a directory outside the project.
  let ancestor = outputDir;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const effectiveOutput = resolve(realpathSync(ancestor), relative(ancestor, outputDir));
  const effectiveRel = relative(projectRoot, effectiveOutput);
  if (!effectiveRel || effectiveRel === ".." || effectiveRel.startsWith(`..${sep}`) || isAbsolute(effectiveRel)) {
    throw new Error("build.output_dir가 프로젝트 외부를 가리키는 심볼릭 링크를 통과합니다.");
  }

  return outputDir;
}

export function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) throw new Error(`No ${CONFIG_FILE} found. Run 'arxiblog init' first.`);
    dir = parent;
  }
}
