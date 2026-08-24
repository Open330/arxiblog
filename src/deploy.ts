import { existsSync } from "fs";
import { resolveBuildOutputDir, type ArxiblogConfig } from "./config";

type PublishFn = (dir: string, opts: Record<string, unknown>, cb: (err?: Error) => void) => void;

export async function deploy(config: ArxiblogConfig, projectRoot: string): Promise<void> {
  // Use the same confinement as build/serve: a typo such as `../` must never
  // publish unrelated files outside the arxiblog project.
  const outputDir = resolveBuildOutputDir(projectRoot, config.build.output_dir);
  if (!existsSync(outputDir)) {
    throw new Error("빌드 결과가 없습니다. 먼저 'arxiblog build'를 실행하세요.");
  }

  const target = config.deploy.target || "gh-pages";

  if (target === "gh-pages") {
    // gh-pages ships no type declarations; treat the module as untyped.
    const ghpages = (await import("gh-pages")) as unknown as {
      default?: { publish: PublishFn };
      publish?: PublishFn;
    };
    const publish = ghpages.default?.publish ?? ghpages.publish;
    if (!publish) throw new Error("gh-pages 모듈을 불러오지 못했습니다.");
    await new Promise<void>((resolve, reject) => {
      publish(outputDir, { dotfiles: true }, (err?: Error) => (err ? reject(err) : resolve()));
    });
    console.log("\x1b[32m✅ GitHub Pages에 배포했습니다.\x1b[0m");
  } else if (target === "vercel") {
    const proc = Bun.spawn(["npx", "vercel", "deploy", "--prod", outputDir], { stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) throw new Error("Vercel 배포에 실패했습니다.");
    console.log("\x1b[32m✅ Vercel에 배포했습니다.\x1b[0m");
  } else {
    throw new Error(`알 수 없는 배포 대상: ${target}`);
  }
}
