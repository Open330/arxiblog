import type { ArxiblogConfig } from "../config";
import type { Store } from "../store";
import { fetchArxivListing } from "../ingest/arxiv";
import { addPaper } from "./add";

export interface DigestOptions {
  categories: string[];
  count: number;
  level?: string;
  persona?: string;
  onProgress?: (msg: string) => void;
}

export interface DigestResult {
  arxivId: string;
  title: string;
  skipped?: boolean; // already in the store, not re-fetched
  error?: string; // addPaper threw; the rest continue
}

/** arXiv asks for ~3s spacing between requests; keep the batch polite (429 방지). */
const DIGEST_DELAY_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the latest arXiv listing for the given categories and turn the first
 * `count` NOT-yet-imported papers into blog posts. Already-stored papers are
 * skipped (recorded), per-paper failures are caught and recorded, and the batch
 * continues. Does NOT rebuild the static site — the caller does that once.
 */
export async function runDigest(
  store: Store,
  config: ArxiblogConfig,
  opts: DigestOptions
): Promise<DigestResult[]> {
  const count = Math.max(1, Math.floor(opts.count));
  const progress = opts.onProgress || (() => {});

  // Over-fetch so already-imported papers can be skipped without falling short.
  const listing = await fetchArxivListing(opts.categories, count * 3);
  if (listing.length === 0) {
    progress("arXiv 목록을 가져오지 못했습니다.");
    return [];
  }

  const results: DigestResult[] = [];
  let processed = 0; // papers we actually attempted to add
  for (const item of listing) {
    if (processed >= count) break;

    if (store.getPaperByArxivId(item.arxivId)) {
      results.push({ arxivId: item.arxivId, title: item.title, skipped: true });
      continue;
    }

    // Space out the network-heavy addPaper calls; no delay before the first.
    if (processed > 0) await sleep(DIGEST_DELAY_MS);
    processed++;

    progress(`(${processed}/${count}) arXiv:${item.arxivId} 처리 중...`);
    try {
      const result = await addPaper(store, config, item.arxivId, {
        level: opts.level,
        persona: opts.persona,
      });
      results.push({ arxivId: item.arxivId, title: result.title });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ arxivId: item.arxivId, title: item.title, error: message });
      progress(`   ⚠ arXiv:${item.arxivId} 실패: ${message}`);
    }
  }

  if (processed === 0) progress("새로 추가할 논문이 없습니다 (목록이 모두 이미 있음).");
  return results;
}
