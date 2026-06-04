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

// ── Provider: Google Gemini (raw fetch, no SDK needed) ──

async function geminiComplete(
  config: LLMConfig,
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<ProviderResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.api_key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error (${resp.status}): ${err.slice(0, 200)}`);
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
  if (error instanceof Error && /\b(429|500|502|503|504)\b/.test(error.message)) return true;
  const status = (error as { status?: number })?.status;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMClient {
  private config: LLMConfig;
  private usage: UsageStats = { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _openaiClient: InstanceType<typeof import("openai").default> | null = null;
  private _anthropicClient: InstanceType<typeof import("@anthropic-ai/sdk").default> | null = null;
  private _azureClient: InstanceType<typeof import("openai").AzureOpenAI> | null = null;

  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  private async azureComplete(system: string, userMessage: string, maxTokens: number): Promise<ProviderResult> {
    if (!this._azureClient) {
      const { AzureOpenAI } = await import("openai");
      this._azureClient = new AzureOpenAI({
        endpoint: this.config.endpoint,
        apiKey: this.config.api_key,
        deployment: this.config.model,
        apiVersion: "2024-12-01-preview",
      });
    }
    const resp = await this._azureClient.chat.completions.create({
      model: this.config.model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    });
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

  private async openaiComplete(system: string, userMessage: string, maxTokens: number): Promise<ProviderResult> {
    const { default: OpenAI } = await import("openai");
    if (!this._openaiClient) {
      this._openaiClient = new OpenAI({ apiKey: this.config.api_key });
    }
    const resp = await this._openaiClient.chat.completions.create({
      model: this.config.model || "gpt-5.4-nano",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      max_completion_tokens: maxTokens,
    });
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

  private async anthropicComplete(system: string, userMessage: string, maxTokens: number): Promise<ProviderResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    if (!this._anthropicClient) {
      this._anthropicClient = new Anthropic({ apiKey: this.config.api_key });
    }
    const resp = await this._anthropicClient.messages.create({
      model: this.config.model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });
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

  async chatComplete(system: string, userMessage: string, maxTokens = 8192): Promise<string> {
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let result: ProviderResult;
        switch (this.config.provider) {
          case "gemini":
            result = await geminiComplete(this.config, system, userMessage, maxTokens);
            break;
          case "azure-openai":
            result = await this.azureComplete(system, userMessage, maxTokens);
            break;
          case "openai":
            result = await this.openaiComplete(system, userMessage, maxTokens);
            break;
          case "anthropic":
            result = await this.anthropicComplete(system, userMessage, maxTokens);
            break;
          default:
            throw new Error(`Unknown LLM provider: ${this.config.provider}`);
        }

        if (result.usage) {
          this.usage.totalCalls++;
          this.usage.promptTokens += result.usage.prompt_tokens || 0;
          this.usage.completionTokens += result.usage.completion_tokens || 0;
          this.usage.totalTokens += result.usage.total_tokens || 0;
        }
        return result.text;
      } catch (error) {
        if (isRetryableError(error) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
          this.onRetry?.(attempt + 1, MAX_RETRIES, delay);
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unreachable: retry loop exited without return or throw");
  }

  getUsageStats(): UsageStats {
    return { ...this.usage };
  }

  getEstimatedCost(): number {
    // Approximate pricing per 1M tokens
    const pricing: Record<string, { input: number; output: number }> = {
      gemini: { input: 0.075, output: 0.3 },
      "azure-openai": { input: 0.1, output: 0.4 },
      openai: { input: 2.5, output: 10.0 },
      anthropic: { input: 3.0, output: 15.0 },
    };
    const p = pricing[this.config.provider] || pricing["gemini"];
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
    console.log(`  예상 비용:  ~$${cost.toFixed(4)}`);
  }
}
