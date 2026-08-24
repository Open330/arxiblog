import { describe, expect, test } from "bun:test";
import { parsePdfInWorker } from "./arxiv";

type Listener = ((event: MessageEvent<unknown>) => void) | null;

class FakeWorker {
  onmessage: Listener = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(private mode: "success" | "hang") {}

  postMessage(): void {
    if (this.mode === "success") {
      queueMicrotask(() =>
        this.onmessage?.({ data: { ok: true, text: "extracted text" } } as MessageEvent)
      );
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("PDF worker isolation", () => {
  test("returns worker output and terminates the worker", async () => {
    const worker = new FakeWorker("success");
    const result = await parsePdfInWorker(
      Buffer.from("fake"),
      100,
      () => worker as unknown as Worker
    );
    expect(result).toBe("extracted text");
    expect(worker.terminated).toBe(true);
  });

  test("terminates a hung parser at the deadline and falls back to empty text", async () => {
    const worker = new FakeWorker("hang");
    const started = performance.now();
    const result = await parsePdfInWorker(
      Buffer.from("fake"),
      10,
      () => worker as unknown as Worker
    );
    expect(result).toBe("");
    expect(worker.terminated).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("loads the real parser worker and safely rejects malformed PDF bytes", async () => {
    const result = await parsePdfInWorker(Buffer.from("not a PDF"), 5_000);
    expect(result).toBe("");
  });
});
