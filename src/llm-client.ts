import type { LLMConfig } from "./config";

// Token usage tracking
export interface UsageStats {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

type ProviderResult = {
  text: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

type Fetch = typeof globalThis.fetch;

export interface LLMClientOptions {
  /** Maximum wall-clock time for one provider request. */
  requestTimeoutMs?: number;
  /** Maximum wall-clock time for the complete call, including retries/backoff. */
  deadlineMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  /** Test hook; production callers should use the global fetch implementation. */
  fetch?: Fetch;
  /** Test hook for deterministic retry jitter. */
  random?: () => number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_DEADLINE_MS = 75_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 2_000;

const PROVIDER_NAMES: Record<string, string> = {
  gemini: "Gemini",
  "azure-openai": "Azure OpenAI",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number
  ) {
    // Deliberately omit the response body: providers can echo prompts or other
    // sensitive request context in error payloads.
    super(`${provider} HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

class ProviderTimeoutError extends Error {
  readonly code = "LLM_TIMEOUT";

  constructor(
    readonly provider: string,
    readonly timeoutMs: number
  ) {
    super(`${provider} request timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

class ProviderQuotaError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} quota exhausted`);
    this.name = "ProviderQuotaError";
  }
}

/** A deliberately sanitized provider failure that is safe for an API client. */
export class LLMProviderError extends Error {
  constructor(message: string, readonly httpStatus: 429 | 502 | 504) {
    super(message);
    this.name = "LLMProviderError";
  }
}

function positiveNumber(value: number | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) return fallback;
  return value;
}

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] || provider;
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof ProviderHttpError) return error.status;
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.name === "APIConnectionTimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    /\b(?:timed?\s*out|timeout)\b/i.test(error.message)
  );
}

function safeProviderError(provider: string, error: unknown, deadlineMs: number): LLMProviderError {
  const name = providerName(provider);
  if (error instanceof ProviderQuotaError) {
    return new LLMProviderError(
      `${name} 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.`,
      429
    );
  }
  if (isTimeoutError(error)) {
    return new LLMProviderError(
      `${name} 요청이 전체 시간 제한(${Math.ceil(deadlineMs / 1000)}초)을 초과했습니다. 잠시 후 다시 시도해 주세요.`,
      504
    );
  }
  const status = errorStatus(error);
  if (status !== undefined) {
    return new LLMProviderError(
      `${name} 요청에 실패했습니다 (HTTP ${status}). 잠시 후 다시 시도해 주세요.`,
      502
    );
  }
  return new LLMProviderError(`${name} 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.`, 502);
}

// ── Provider: Google Gemini (raw fetch, no SDK needed) ──

async function geminiComplete(
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  maxTokens: number,
  signal: AbortSignal,
  fetchImpl: Fetch
): Promise<ProviderResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal,
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 },
    }),
  });

  if (!resp.ok) {
    throw new ProviderHttpError("gemini", resp.status);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const candidates = data.candidates as
    | Array<{ content: { parts: Array<{ text: string }> } }>
    | undefined;
  const text = candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  const usage = data.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    | undefined;
  return {
    text,
    usage: usage
      ? {
          prompt_tokens: usage.promptTokenCount || 0,
          completion_tokens: usage.candidatesTokenCount || 0,
          total_tokens: usage.totalTokenCount || 0,
        }
      : undefined,
  };
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  const status = errorStatus(error);
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;
  return false;
}

/** Quota/rate-limit error → try the next Gemini key rather than waiting. */
function isQuotaError(error: unknown): boolean {
  if (error instanceof ProviderQuotaError) return true;
  if (error instanceof Error && (/\b429\b/.test(error.message) || /RESOURCE_EXHAUSTED|quota/i.test(error.message)))
    return true;
  return errorStatus(error) === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMClient {
  private config: LLMConfig;
  private readonly requestTimeoutMs: number;
  private readonly deadlineMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly fetchImpl: Fetch;
  private readonly random: () => number;
  private usage: UsageStats = { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _openaiClient: InstanceType<typeof import("openai").default> | null = null;
  private _anthropicClient: InstanceType<typeof import("@anthropic-ai/sdk").default> | null = null;
  private _azureClient: InstanceType<typeof import("openai").AzureOpenAI> | null = null;

  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;

  // Gemini key pool: free keys rotated round-robin, paid key as last resort.
  private geminiFree: string[] = [];
  private geminiPaid = "";
  private rr = 0;
  private cooldown = new Map<string, number>(); // key → epoch ms until usable again

  constructor(config: LLMConfig, options: LLMClientOptions = {}) {
    this.config = config;
    this.requestTimeoutMs = positiveNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.deadlineMs = positiveNumber(options.deadlineMs, DEFAULT_DEADLINE_MS);
    this.maxRetries = Math.floor(positiveNumber(options.maxRetries, DEFAULT_MAX_RETRIES, true));
    this.baseRetryDelayMs = positiveNumber(
      options.baseRetryDelayMs,
      DEFAULT_BASE_RETRY_DELAY_MS,
      true
    );
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.random = options.random || Math.random;
    const free = [...(config.api_keys || []), ...(config.api_key ? [config.api_key] : [])];
    // de-dup while preserving order
    this.geminiFree = [...new Set(free.filter(Boolean))];
    this.geminiPaid = config.api_key_paid || "";
  }

  /** Gemini call with free-key rotation and paid fallback on quota exhaustion. */
  private async geminiWithFallback(
    system: string,
    user: string,
    maxTokens: number,
    signal: AbortSignal
  ): Promise<ProviderResult> {
    const now = Date.now();
    const n = this.geminiFree.length;
    const candidates: string[] = [];
    for (let i = 0; i < n; i++) candidates.push(this.geminiFree[(this.rr + i) % n]);
    if (n > 0) this.rr = (this.rr + 1) % n; // spread load across calls

    if (candidates.length === 0 && !this.geminiPaid) {
      throw new Error("Gemini API 키가 설정되지 않았습니다.");
    }

    // The paid key is a quota fallback, not a general availability fallback.
    // A free-key timeout/5xx goes to the outer backoff loop so a transient
    // provider outage can never silently turn into a billable request.
    for (const key of candidates) {
      if ((this.cooldown.get(key) || 0) > now) continue;
      try {
        return await geminiComplete(key, this.config.model, system, user, maxTokens, signal, this.fetchImpl);
      } catch (e) {
        if (isQuotaError(e)) {
          this.cooldown.set(key, Date.now() + 60_000); // rest this key for 60s
          continue; // an explicitly exhausted free key allows the next free key
        }
        throw e;
      }
    }

    // Every configured free key is either quota-exhausted or still in the
    // cooldown created by a previous quota response. Only now may paid run.
    if (this.geminiPaid) {
      try {
        return await geminiComplete(
          this.geminiPaid,
          this.config.model,
          system,
          user,
          maxTokens,
          signal,
          this.fetchImpl
        );
      } catch (error) {
        if (isQuotaError(error)) throw new ProviderQuotaError("gemini");
        throw error;
      }
    }
    throw new ProviderQuotaError("gemini");
  }

  private async azureComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ProviderResult> {
    if (!this._azureClient) {
      const { AzureOpenAI } = await import("openai");
      this._azureClient = new AzureOpenAI({
        endpoint: this.config.endpoint,
        apiKey: this.config.api_key,
        deployment: this.config.model,
        apiVersion: "2024-12-01-preview",
      });
    }
    const resp = await this._azureClient.chat.completions.create(
      {
        model: this.config.model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
      },
      { signal, timeout: timeoutMs, maxRetries: 0 }
    );
    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage
        ? {
            prompt_tokens: resp.usage.prompt_tokens || 0,
            completion_tokens: resp.usage.completion_tokens || 0,
            total_tokens: resp.usage.total_tokens || 0,
          }
        : undefined,
    };
  }

  private async openaiComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ProviderResult> {
    if (!this._openaiClient) {
      const { default: OpenAI } = await import("openai");
      this._openaiClient = new OpenAI({ apiKey: this.config.api_key });
    }
    const resp = await this._openaiClient.chat.completions.create(
      {
        model: this.config.model || "gpt-5.4-nano",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
        max_completion_tokens: maxTokens,
      },
      { signal, timeout: timeoutMs, maxRetries: 0 }
    );
    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage
        ? {
            prompt_tokens: resp.usage.prompt_tokens || 0,
            completion_tokens: resp.usage.completion_tokens || 0,
            total_tokens: resp.usage.total_tokens || 0,
          }
        : undefined,
    };
  }

  private async anthropicComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ProviderResult> {
    if (!this._anthropicClient) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this._anthropicClient = new Anthropic({ apiKey: this.config.api_key });
    }
    const resp = await this._anthropicClient.messages.create(
      {
        model: this.config.model || "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal, timeout: timeoutMs, maxRetries: 0 }
    );
    const content = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    return {
      text: content,
      usage: resp.usage
        ? {
            prompt_tokens: resp.usage.input_tokens || 0,
            completion_tokens: resp.usage.output_tokens || 0,
            total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
          }
        : undefined,
    };
  }

  private track(result: ProviderResult): string {
    // A provider can omit token metadata on a valid response. The successful
    // call still happened even when its token/cost figures are unavailable.
    this.usage.totalCalls++;
    if (result.usage) {
      this.usage.promptTokens += result.usage.prompt_tokens || 0;
      this.usage.completionTokens += result.usage.completion_tokens || 0;
      this.usage.totalTokens += result.usage.total_tokens || 0;
    }
    return result.text;
  }

  /**
   * Race the provider against a wall-clock timer as a final safety net. The SDK
   * timeout and AbortSignal normally stop network I/O; Promise.race also keeps a
   * buggy transport that ignores abort from holding the caller indefinitely.
   */
  private async runAttempt(
    provider: string,
    deadline: number,
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<ProviderResult>
  ): Promise<ProviderResult> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new ProviderTimeoutError(provider, this.deadlineMs);

    const timeoutMs = Math.max(1, Math.min(this.requestTimeoutMs, remainingMs));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ProviderTimeoutError(provider, timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation(controller.signal, timeoutMs), timeout]);
    } catch (error) {
      if (controller.signal.aborted || isTimeoutError(error)) {
        throw error instanceof ProviderTimeoutError
          ? error
          : new ProviderTimeoutError(provider, timeoutMs);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private completeAttempt(
    system: string,
    userMessage: string,
    maxTokens: number,
    deadline: number
  ): Promise<ProviderResult> {
    const provider = this.config.provider;
    return this.runAttempt(provider, deadline, (signal, timeoutMs) => {
      switch (provider) {
        case "gemini":
          return this.geminiWithFallback(system, userMessage, maxTokens, signal);
        case "azure-openai":
          return this.azureComplete(system, userMessage, maxTokens, signal, timeoutMs);
        case "openai":
          return this.openaiComplete(system, userMessage, maxTokens, signal, timeoutMs);
        case "anthropic":
          return this.anthropicComplete(system, userMessage, maxTokens, signal, timeoutMs);
        default:
          throw new Error(`Unknown LLM provider: ${provider}`);
      }
    });
  }

  async chatComplete(system: string, userMessage: string, maxTokens = 8192): Promise<string> {
    const provider = this.config.provider;
    if (!PROVIDER_NAMES[provider]) throw new Error(`Unknown LLM provider: ${provider}`);
    const deadline = Date.now() + this.deadlineMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return this.track(await this.completeAttempt(system, userMessage, maxTokens, deadline));
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= this.maxRetries) break;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const delay = this.baseRetryDelayMs * Math.pow(2, attempt) + this.random() * 1000;
        this.onRetry?.(attempt + 1, this.maxRetries, Math.min(delay, remainingMs));
        if (delay >= remainingMs) {
          await sleep(remainingMs);
          lastError = new ProviderTimeoutError(provider, this.deadlineMs);
          break;
        }
        await sleep(delay);
      }
    }
    throw safeProviderError(provider, lastError, this.deadlineMs);
  }

  getUsageStats(): UsageStats {
    return { ...this.usage };
  }

  getEstimatedCost(): number {
    // Approximate standard text pricing per 1M tokens. Exact defaults are
    // model-specific; custom model/provider fallbacks remain reference values.
    const modelPricing: Record<string, { input: number; output: number }> = {
      "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
      "gpt-5.4-nano": { input: 0.2, output: 1.25 },
      "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    };
    const providerFallback: Record<string, { input: number; output: number }> = {
      gemini: { input: 0.25, output: 1.5 },
      "azure-openai": { input: 0.1, output: 0.4 },
      openai: { input: 2.5, output: 10.0 },
      anthropic: { input: 3.0, output: 15.0 },
    };
    const p = modelPricing[this.config.model] || providerFallback[this.config.provider] || providerFallback.gemini;
    return (
      (this.usage.promptTokens / 1_000_000) * p.input +
      (this.usage.completionTokens / 1_000_000) * p.output
    );
  }

  printUsageSummary(): void {
    const u = this.usage;
    const cost = this.getEstimatedCost();
    console.log(`\x1b[34m📊 LLM 사용량 (${this.config.provider}/${this.config.model}):\x1b[0m`);
    console.log(`  호출 횟수:  ${u.totalCalls}회`);
    console.log(`  입력 토큰:  ${u.promptTokens.toLocaleString()}`);
    console.log(`  출력 토큰:  ${u.completionTokens.toLocaleString()}`);
    console.log(`  총 토큰:    ${u.totalTokens.toLocaleString()}`);
    console.log(`  참고용 예상 비용:  ~$${cost.toFixed(4)} (실제 청구액과 다를 수 있음)`);
  }
}
