import { parse, stringify } from "smol-toml";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";

export const CONFIG_FILE = "arxiblog.toml";
export const DB_FILE = "arxiblog.db";
export const SITE_DIR = "_site";

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

/** True if any usable LLM key is configured (single, pool, or paid fallback). */
export function hasLlmKey(c: LLMConfig): boolean {
  return !!(c.api_key || (c.api_keys && c.api_keys.length) || c.api_key_paid);
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
}

export interface ArxiblogConfig {
  project: { name: string; created: string; tagline?: string };
  build: { output_dir: string };
  llm: LLMConfig;
  deploy: { target: string };
  personas?: Persona[];
  active_persona?: string;
  /** Default reading level for new posts: "beginner" | "intermediate" */
  default_level?: string;
  chat?: ChatConfig;
}

export const DEFAULT_CHAT: Required<ChatConfig> = {
  enabled: true,
  per_ip_per_hour: 30,
  global_per_day: 800,
};

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
    llm: { provider: "gemini", model: "gemini-3.1-flash-lite-preview", api_key: "", endpoint: "" },
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
  Bun.write(join(root, CONFIG_FILE), stringify(ordered));
}

export function loadConfig(root: string): ArxiblogConfig {
  const content = readFileSync(join(root, CONFIG_FILE), "utf-8");
  const raw = parse(content) as Partial<ArxiblogConfig> & Record<string, unknown>;
  if (!raw.llm) {
    raw.llm = { provider: "gemini", model: "gemini-3.1-flash-lite-preview", api_key: "", endpoint: "" };
  }
  if (!raw.personas || !raw.personas.length) {
    const builtins = loadBuiltinPersonas();
    raw.personas = builtins.length > 0 ? builtins : [getDefaultPersona()];
  }
  if (!raw.active_persona) {
    raw.active_persona = pickDefaultPersonaName(raw.personas);
  }
  return raw as ArxiblogConfig;
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
