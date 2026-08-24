import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const roots: string[] = [];

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
  roots.push(root);
  return new Store(join(root, "engage.db"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engagement stats", () => {
  test("unseen slugs report zeroed stats", () => {
    const store = freshStore();
    expect(store.getStats("never-written")).toEqual({ views: 0, reactions: 0 });
    store.close();
  });

  test("views and reactions accumulate independently per slug", () => {
    const store = freshStore();
    store.incrementView("a");
    store.incrementView("a");
    store.incrementView("b");
    expect(store.getStats("a").views).toBe(2);
    expect(store.getStats("b").views).toBe(1);
    expect(store.getStats("a").reactions).toBe(0);
    store.close();
  });

  test("incrementReaction returns the running total", () => {
    const store = freshStore();
    expect(store.incrementReaction("paper")).toBe(1);
    expect(store.incrementReaction("paper")).toBe(2);
    expect(store.getStats("paper")).toEqual({ views: 0, reactions: 2 });
    store.close();
  });

  test("stats survive a reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "arxiblog-engage-"));
    roots.push(root);
    const path = join(root, "persist.db");
    const first = new Store(path);
    first.incrementView("keep");
    first.incrementReaction("keep");
    first.close();

    const reopened = new Store(path);
    expect(reopened.getStats("keep")).toEqual({ views: 1, reactions: 1 });
    reopened.close();
  });
});

describe("newsletter subscribers", () => {
  test("subscribing is idempotent and case/space-insensitive at the caller boundary", () => {
    const store = freshStore();
    store.addSubscriber("reader@example.com");
    store.addSubscriber("reader@example.com");
    expect(store.countSubscribers()).toBe(1);
    store.addSubscriber("other@example.com");
    expect(store.countSubscribers()).toBe(2);
    store.close();
  });
});
