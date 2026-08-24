import { describe, expect, mock, test } from "bun:test";
import type { LLMConfig } from "./config";
import { LLMClient } from "./llm-client";

type RequestOptions = {
  signal?: AbortSignal | null;
  timeout?: number;
  maxRetries?: number;
};

function config(provider: string, overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider,
    model: "test-model",
    api_key: "test-secret-key",
    endpoint: "https://example.test",
    ...overrides,
  };
}

function fastOptions(fetchImpl?: typeof fetch) {
  return {
    requestTimeoutMs: 20,
    deadlineMs: 100,
    maxRetries: 0,
    baseRetryDelayMs: 0,
    random: () => 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

function openAIResponse(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}

describe("LLMClient provider smoke tests", () => {
  test("Gemini succeeds through an in-process fake transport and tracks usage", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-secret-key");
      return Response.json({
        candidates: [{ content: { parts: [{ text: "deterministic " }, { text: "answer" }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      });
    });
    const fakeFetch = fetchMock as unknown as typeof fetch;
    const client = new LLMClient(config("gemini"), fastOptions(fakeFetch));

    await expect(client.chatComplete("system", "question", 64)).resolves.toBe("deterministic answer");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(client.getUsageStats()).toEqual({
      totalCalls: 1,
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
  });

  test("default model cost estimates use current model-specific rates", async () => {
    const geminiFetch = mock(async () => Response.json({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }));
    const gemini = new LLMClient(
      config("gemini", { model: "gemini-3.1-flash-lite" }),
      fastOptions(geminiFetch as unknown as typeof fetch)
    );
    await gemini.chatComplete("system", "question", 64);
    expect(gemini.getEstimatedCost()).toBeCloseTo((2 * 0.25 + 3 * 1.5) / 1_000_000, 12);

    const openai = new LLMClient(config("openai", { model: "gpt-5.4-nano" }), fastOptions());
    (openai as unknown as { _openaiClient: unknown })._openaiClient = {
      chat: { completions: { create: mock(async () => openAIResponse("ok")) } },
    };
    await openai.chatComplete("system", "question", 64);
    expect(openai.getEstimatedCost()).toBeCloseTo((2 * 0.2 + 3 * 1.25) / 1_000_000, 12);
  });

  test("OpenAI, Azure OpenAI, and Anthropic pass abort and timeout controls to their SDKs", async () => {
    const seen: RequestOptions[] = [];
    const openAICreate = mock(async (_body: unknown, options?: RequestOptions) => {
      seen.push(options || {});
      return openAIResponse("openai-ok");
    });
    const azureCreate = mock(async (_body: unknown, options?: RequestOptions) => {
      seen.push(options || {});
      return openAIResponse("azure-ok");
    });
    const anthropicCreate = mock(async (_body: unknown, options?: RequestOptions) => {
      seen.push(options || {});
      return {
        content: [{ type: "text", text: "anthropic-ok" }],
        usage: { input_tokens: 4, output_tokens: 6 },
      };
    });

    const openAI = new LLMClient(config("openai"), fastOptions());
    const azure = new LLMClient(config("azure-openai"), fastOptions());
    const anthropic = new LLMClient(config("anthropic"), fastOptions());
    (openAI as unknown as { _openaiClient: unknown })._openaiClient = {
      chat: { completions: { create: openAICreate } },
    };
    (azure as unknown as { _azureClient: unknown })._azureClient = {
      chat: { completions: { create: azureCreate } },
    };
    (anthropic as unknown as { _anthropicClient: unknown })._anthropicClient = {
      messages: { create: anthropicCreate },
    };

    await expect(openAI.chatComplete("system", "user")).resolves.toBe("openai-ok");
    await expect(azure.chatComplete("system", "user")).resolves.toBe("azure-ok");
    await expect(anthropic.chatComplete("system", "user")).resolves.toBe("anthropic-ok");
    expect(seen).toHaveLength(3);
    for (const options of seen) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(20);
      expect(options.maxRetries).toBe(0);
    }
  });
});

describe("LLMClient failure and deadline behavior", () => {
  test("HTTP errors expose provider/status but neither response details nor API keys", async () => {
    const fetchMock = mock(
      async () => new Response("test-secret-key: upstream diagnostic payload", { status: 400 })
    );
    const fakeFetch = fetchMock as unknown as typeof fetch;
    const client = new LLMClient(config("gemini"), fastOptions(fakeFetch));

    const error = await captureError(client.chatComplete("system", "private prompt"));
    expect(error.message).toContain("Gemini");
    expect(error.message).toContain("HTTP 400");
    expect(error.message).not.toContain("test-secret-key");
    expect(error.message).not.toContain("upstream diagnostic");
    expect(error.message).not.toContain("private prompt");
    expect((error as Error & { httpStatus?: number }).httpStatus).toBe(502);
  });

  test("a retryable HTTP error succeeds on retry without SDK-internal retries", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return Response.json({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] });
    });
    const fakeFetch = fetchMock as unknown as typeof fetch;
    const client = new LLMClient(config("gemini"), {
      ...fastOptions(fakeFetch),
      maxRetries: 1,
    });
    const retries: number[] = [];
    client.onRetry = (attempt) => retries.push(attempt);

    await expect(client.chatComplete("system", "user")).resolves.toBe("recovered");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([1]);
    expect(client.getUsageStats()).toEqual({
      totalCalls: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  test("a transient free-key failure never activates the paid Gemini fallback", async () => {
    const keys: string[] = [];
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("x-goog-api-key") || "");
      if (keys.length === 1) return new Response("temporary", { status: 503 });
      return Response.json({ candidates: [{ content: { parts: [{ text: "free recovered" }] } }] });
    });
    const client = new LLMClient(config("gemini", { api_key_paid: "paid-secret-key" }), {
      ...fastOptions(fetchMock as unknown as typeof fetch),
      maxRetries: 1,
    });

    await expect(client.chatComplete("system", "user")).resolves.toBe("free recovered");
    expect(keys).toEqual(["test-secret-key", "test-secret-key"]);
    expect(keys).not.toContain("paid-secret-key");
  });

  test("the paid Gemini key is used only after free quota exhaustion", async () => {
    const keys: string[] = [];
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key") || "";
      keys.push(key);
      if (key !== "paid-secret-key") return new Response("quota", { status: 429 });
      return Response.json({ candidates: [{ content: { parts: [{ text: "paid fallback" }] } }] });
    });
    const client = new LLMClient(config("gemini", {
      api_keys: ["free-key-2"],
      api_key_paid: "paid-secret-key",
    }), fastOptions(fetchMock as unknown as typeof fetch));

    await expect(client.chatComplete("system", "user")).resolves.toBe("paid fallback");
    expect(keys).toEqual(["free-key-2", "test-secret-key", "paid-secret-key"]);
  });

  test("a hanging transport is aborted, retried, and bounded by one overall deadline", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = mock((_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      // Intentionally ignore abort to verify the caller-side Promise.race safety net.
      return new Promise<Response>(() => {});
    });
    const hangingFetch = fetchMock as unknown as typeof fetch;
    const client = new LLMClient(config("gemini"), {
      // Keep enough wall-clock slack for the full suite's parallel PDF/assets
      // work while still proving each hung attempt is aborted and bounded.
      requestTimeoutMs: 50,
      deadlineMs: 2_000,
      maxRetries: 2,
      baseRetryDelayMs: 0,
      random: () => 0,
      fetch: hangingFetch,
    });
    let retries = 0;
    client.onRetry = () => retries++;
    const started = performance.now();

    const error = await captureError(client.chatComplete("system", "user"));
    const elapsed = performance.now() - started;
    expect(error.message).toContain("Gemini");
    expect(error.message).toContain("시간 제한");
    expect(error.message).not.toContain("test-secret-key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries).toBe(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("SDK timeout errors are retryable and remain sanitized at the deadline", async () => {
    let calls = 0;
    const create = mock(async () => {
      calls++;
      const error = new Error("socket timeout; test-secret-key; raw provider body");
      error.name = "APIConnectionTimeoutError";
      throw error;
    });
    const client = new LLMClient(config("openai"), {
      requestTimeoutMs: 500,
      deadlineMs: 2_000,
      maxRetries: 2,
      baseRetryDelayMs: 0,
      random: () => 0,
    });
    (client as unknown as { _openaiClient: unknown })._openaiClient = {
      chat: { completions: { create } },
    };

    const error = await captureError(client.chatComplete("system", "user"));
    expect(calls).toBe(3);
    expect(error.message).toContain("OpenAI");
    expect(error.message).toContain("시간 제한");
    expect(error.message).not.toContain("test-secret-key");
    expect(error.message).not.toContain("raw provider body");
    expect((error as Error & { httpStatus?: number }).httpStatus).toBe(504);
  });
});
