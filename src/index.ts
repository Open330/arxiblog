#!/usr/bin/env bun
import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import {
  CONFIG_FILE,
  DB_FILE,
  defaultConfig,
  findProjectRoot,
  hasLlmKey,
  loadConfig,
  saveConfig,
} from "./config";
import { Store } from "./store";

const C = {
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const program = new Command()
  .name("arxiblog")
  .description("📄→📝 arXiv 논문을 읽기 쉬운 블로그 글로 바꿔주는 도구")
  .version("0.1.0");

// ── init ──
program
  .command("init [name]")
  .description("새 arxiblog 프로젝트를 생성합니다")
  .action(async (name: string | undefined) => {
    const root = process.cwd();
    if (existsSync(join(root, CONFIG_FILE))) {
      console.log(C.yellow("이미 초기화된 프로젝트입니다."));
      return;
    }

    const p = await import("@clack/prompts");
    p.intro("📄→📝 arxiblog — 논문 읽기 블로그 만들기");

    const values = await p.group(
      {
        name: () =>
          p.text({
            message: "블로그 이름",
            placeholder: "Paper Notes",
            initialValue: name || "",
            validate: (v) => (!v?.trim() ? "이름을 입력해주세요" : undefined),
          }),
        provider: () =>
          p.select({
            message: "LLM 프로바이더",
            options: [
              { value: "gemini", label: "Google Gemini", hint: "무료 API key (aistudio.google.com)" },
              { value: "anthropic", label: "Anthropic Claude" },
              { value: "openai", label: "OpenAI" },
              { value: "azure-openai", label: "Azure OpenAI" },
            ],
          }),
        model: ({ results }: { results: { provider?: string } }) => {
          const def =
            results.provider === "gemini"
              ? "gemini-3.1-flash-lite-preview"
              : results.provider === "anthropic"
              ? "claude-sonnet-4-6"
              : results.provider === "openai"
              ? "gpt-5.4-nano"
              : "gpt-5.4-nano";
          return p.text({ message: "모델명", placeholder: def, initialValue: def });
        },
        apiKey: () => p.password({ message: "API Key", validate: (v) => (!v?.trim() ? "API Key를 입력해주세요" : undefined) }),
        endpoint: ({ results }: { results: { provider?: string } }) =>
          results.provider === "azure-openai"
            ? p.text({ message: "Azure Endpoint", placeholder: "https://..." })
            : Promise.resolve(""),
      },
      { onCancel: () => { p.cancel("취소되었습니다."); process.exit(0); } }
    );

    const config = defaultConfig(values.name as string);
    config.llm.provider = values.provider as string;
    config.llm.model = values.model as string;
    config.llm.api_key = values.apiKey as string;
    config.llm.endpoint = (values.endpoint as string) || "";
    saveConfig(root, config);

    const store = new Store(join(root, DB_FILE));
    store.close();

    p.outro(C.green(`✅ '${values.name}' 블로그가 생성되었습니다!`));
    console.log(`\n다음 단계:\n  ${C.blue("arxiblog add 2505.13447")}   ${C.dim("# arXiv 논문 추가")}\n  ${C.blue("arxiblog serve")}            ${C.dim("# 로컬에서 보기 (AI 챗 포함)")}\n`);
  });

// ── add ──
program
  .command("add <source>")
  .description("arXiv 논문(ID/URL)을 블로그 글로 변환합니다")
  .option("-l, --level <level>", "난이도: beginner | intermediate")
  .option("-p, --persona <name>", "글쓰기 페르소나 이름")
  .option("--no-build", "변환 후 사이트를 다시 빌드하지 않음")
  .action(async (source: string, opts: { level?: string; persona?: string; build?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);

    if (!hasLlmKey(config.llm)) {
      console.log(C.red("LLM API 키가 설정되지 않았습니다. arxiblog.toml의 [llm] api_key를 채워주세요."));
      process.exit(1);
    }

    const { addPaper } = await import("./pipeline/add");
    const store = new Store(join(root, DB_FILE));
    try {
      const result = await addPaper(store, config, source, {
        level: opts.level,
        persona: opts.persona,
        onProgress: (phase, detail) => {
          if (phase === "meta") console.log(C.blue(`📥 arXiv:${detail} 메타데이터를 가져오는 중...`));
          else if (phase === "pdf") console.log(C.blue("📄 본문(PDF)을 추출하는 중...") + `  ${C.dim(detail || "")}`);
          else if (phase === "transform") console.log(C.blue(`✍️  '${detail}' 페르소나로 글을 작성하는 중... ${C.dim("(시간이 걸릴 수 있어요)")}`));
        },
        onRetry: (a, m, d) => console.log(C.yellow(`   재시도 ${a}/${m} (${Math.round(d / 1000)}s 후)...`)),
      });

      console.log(C.green(`✅ "${result.title}"`));
      console.log(`   ${C.dim(`${result.annotationCount}개 용어 주석 · ${result.minutes}분 읽기 · /p/${result.slug}.html`)}`);
      console.log(
        C.dim(`   토큰 ${result.usage.totalTokens.toLocaleString()} · ~$${result.cost.toFixed(4)}`)
      );

      if (opts.build !== false) {
        const { buildSite } = await import("./build/renderer");
        const n = await buildSite(store, config, root);
        console.log(C.green(`🛠  사이트 빌드 완료 (${n}개 글). 'arxiblog serve'로 확인하세요.`));
      }
    } finally {
      store.close();
    }
  });

// ── build ──
program
  .command("build")
  .description("정적 블로그 사이트를 빌드합니다")
  .action(async () => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const { buildSite } = await import("./build/renderer");
      const n = await buildSite(store, config, root);
      console.log(C.green(`✅ ${n}개 글을 빌드했습니다 → ${config.build.output_dir}/`));
    } finally {
      store.close();
    }
  });

// ── serve ──
program
  .command("serve")
  .description("로컬 서버를 실행합니다 (AI 챗 포함)")
  .option("-p, --port <port>", "포트", "8000")
  .option("-H, --host <host>", "바인딩 호스트 (LAN 공개는 0.0.0.0)", "localhost")
  .option("--no-build", "실행 전 빌드하지 않음")
  .action(async (opts: { port: string; host: string; build?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);

    if (opts.build !== false) {
      const store = new Store(join(root, DB_FILE));
      try {
        const { buildSite } = await import("./build/renderer");
        await buildSite(store, config, root);
      } finally {
        store.close();
      }
    }

    const port = parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.log(C.red(`잘못된 포트: ${opts.port}`));
      process.exit(1);
    }
    const host = opts.host || "localhost";
    if (host !== "localhost" && host !== "127.0.0.1") {
      console.log(
        C.yellow(
          `⚠ ${host} 로 바인딩합니다 — LAN의 누구나 접속/AI 챗(유료 LLM 호출) 사용 가능합니다. 신뢰된 내부망에서만 사용하세요.`
        )
      );
    }
    const { startServer } = await import("./server");
    startServer(root, port, host);
  });

// ── list ──
program
  .command("list")
  .description("작성된 글 목록을 보여줍니다")
  .action(async () => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      const posts = store.listPosts();
      if (!posts.length) {
        console.log(C.dim("아직 글이 없습니다. 'arxiblog add <arxiv-id>'로 추가하세요."));
        return;
      }
      for (const p of posts) {
        console.log(`${C.green(p.title)}`);
        console.log(`  ${C.dim(`arXiv:${p.arxiv_id} · ${p.reading_minutes}분 · /p/${p.slug}.html`)}`);
      }
      console.log(C.dim(`\n총 ${posts.length}개 글`));
    } finally {
      store.close();
    }
  });

// ── remove ──
program
  .command("remove <slug>")
  .description("글을 삭제합니다")
  .action(async (slug: string) => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      if (!store.getPost(slug)) {
        console.log(C.yellow(`'${slug}' 글을 찾을 수 없습니다.`));
        return;
      }
      store.deletePost(slug);
      console.log(C.green(`삭제했습니다: ${slug}`));
    } finally {
      store.close();
    }
  });

// ── status ──
program
  .command("status")
  .description("프로젝트 상태를 보여줍니다")
  .action(async () => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const usage = store.getUsageSummary();
      console.log(C.blue(`📄 ${config.project.name}`));
      console.log(`  글 개수:    ${store.countPosts()}`);
      console.log(`  LLM:        ${config.llm.provider}/${config.llm.model}`);
      console.log(`  페르소나:   ${config.active_persona}`);
      console.log(`  API 키:     ${config.llm.api_key ? "설정됨" : C.yellow("미설정")}`);
      console.log(C.dim(`\n  누적 호출 ${usage.totalCalls}회 · ${usage.totalTokens.toLocaleString()} 토큰 · ~$${usage.totalCost.toFixed(4)}`));
    } finally {
      store.close();
    }
  });

// ── deploy ──
program
  .command("deploy")
  .description("사이트를 배포합니다 (GitHub Pages / Vercel)")
  .option("-t, --target <target>", "gh-pages | vercel")
  .action(async (opts: { target?: string }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    if (opts.target) config.deploy.target = opts.target;
    const { deploy } = await import("./deploy");
    await deploy(config, root);
  });

program.parseAsync().catch((err) => {
  console.error(C.red(`오류: ${err.message}`));
  process.exit(1);
});
