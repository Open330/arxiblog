type PdfWorkerRequest = {
  bytes: ArrayBuffer;
  maxChars: number;
};

type PdfWorkerResponse =
  | { ok: true; text: string }
  | { ok: false; error: string };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PdfWorkerRequest>) => void) | null;
  postMessage: (message: PdfWorkerResponse) => void;
};

workerScope.onmessage = async (event) => {
  try {
    let pdfParseModule: Record<string, unknown>;
    try {
      // pdf-parse@1.x's package entry has a debug side effect; prefer its library
      // entry and retain the package entry only as a compatibility fallback.
      pdfParseModule = await import("pdf-parse/lib/pdf-parse.js");
    } catch {
      pdfParseModule = await import("pdf-parse");
    }
    const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (
      bytes: Buffer
    ) => Promise<{ text?: string }>;
    const parsed = await pdfParse(Buffer.from(event.data.bytes));
    workerScope.postMessage({
      ok: true,
      text: (parsed.text || "").slice(0, Math.max(0, event.data.maxChars)),
    });
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.name : "PdfParseError",
    });
  }
};
