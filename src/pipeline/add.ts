import type { ArxiblogConfig } from "../config";
import { getActivePersona } from "../config";
import type { Store } from "../store";
import { LLMClient, type UsageStats } from "../llm-client";
import { parseArxivId, fetchArxivMeta, fetchArxivFullText } from "../ingest/arxiv";
import { transformToBlog, postSlug, estimateReadingMinutes } from "./transform";

export interface AddResult {
  slug: string;
  title: string;
  arxivId: string;
  annotationCount: number;
  minutes: number;
  usage: UsageStats;
  cost: number;
}

export interface AddOptions {
  level?: string;
  persona?: string;
  onProgress?: (phase: string, detail?: string) => void;
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
}

/**
 * Fetch an arXiv paper, transform it into a blog post, and persist paper + post +
 * annotations. Shared by the CLI (`arxiblog add`) and the web admin (`POST /api/add`).
 * Does NOT rebuild the static site — callers do that separately.
 */
export async function addPaper(
  store: Store,
  config: ArxiblogConfig,
  source: string,
  opts: AddOptions = {}
): Promise<AddResult> {
  if (!config.llm.api_key) throw new Error("LLM API 키가 설정되지 않았습니다.");

  const cfg = opts.persona ? { ...config, active_persona: opts.persona } : config;
  const persona = getActivePersona(cfg);
  const level = opts.level || config.default_level || "beginner";
  const progress = opts.onProgress || (() => {});

  const arxivId = parseArxivId(source);
  progress("meta", arxivId);
  const meta = await fetchArxivMeta(arxivId);

  progress("pdf", meta.title);
  const rawText = await fetchArxivFullText(meta.pdfUrl);

  const paper = store.upsertPaper({
    arxiv_id: meta.arxivId,
    title: meta.title,
    authors: meta.authors.join(", "),
    abstract: meta.abstract,
    categories: meta.categories.join(", "),
    published: meta.published,
    abs_url: meta.absUrl,
    pdf_url: meta.pdfUrl,
    raw_text: rawText,
  });

  progress("transform", persona.name);
  const llm = new LLMClient(config.llm);
  if (opts.onRetry) llm.onRetry = opts.onRetry;
  const blog = await transformToBlog(llm, meta, rawText, persona, level);

  const slug = postSlug(meta, blog.title);
  const minutes = estimateReadingMinutes(blog.content);
  const post = store.upsertPost({
    paper_id: paper.id,
    slug,
    title: blog.title,
    subtitle: blog.subtitle,
    tldr: blog.tldr,
    takeaways: blog.takeaways,
    level: blog.level,
    reading_minutes: minutes,
    content: blog.content,
    persona: persona.name,
  });
  store.replaceAnnotations(post.id, blog.annotations);

  const usage = llm.getUsageStats();
  const cost = llm.getEstimatedCost();
  store.addUsageLog(paper.id, usage.totalCalls, usage.promptTokens, usage.completionTokens, usage.totalTokens, cost);

  return {
    slug,
    title: blog.title,
    arxivId: meta.arxivId,
    annotationCount: blog.annotations.length,
    minutes,
    usage,
    cost,
  };
}
