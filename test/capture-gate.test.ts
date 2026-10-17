import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DECLINED_REASON,
  ENTRY_TOOLS,
  gateToolCall,
  isEntryWrite,
  NO_UI_REASON,
} from "../extensions/llm-wiki/lib/capture-gate.js";
import {
  appendWikiStatus,
  WIKI_STATUS_BLOCK,
  WIKI_STATUS_BLOCK_NO_CAPTURE,
} from "../extensions/llm-wiki/lib/inject.js";
import { buildSessionNotice, registerWikiObserve } from "../extensions/llm-wiki/lib/observation.js";
import { formatRecallContext, type RecallResult } from "../extensions/llm-wiki/lib/recall.js";
import { registerWikiRetro } from "../extensions/llm-wiki/lib/retro.js";
import { autoCaptureEnabled } from "../extensions/llm-wiki/lib/task-config.js";

const wiki = join(import.meta.dirname, "..", "tmp", "gate-vault", ".llm-wiki", "wiki");
const dirs = [wiki];

describe("autoCaptureEnabled", () => {
  it("defaults to OFF; only an explicit true turns it on", () => {
    expect(autoCaptureEnabled(undefined)).toBe(false);
    expect(autoCaptureEnabled({})).toBe(false);
    expect(autoCaptureEnabled({ autoCapture: false })).toBe(false);
    expect(autoCaptureEnabled({ autoCapture: true })).toBe(true);
  });
});

describe("isEntryWrite", () => {
  it("matches every entry tool by name", () => {
    for (const name of ENTRY_TOOLS) expect(isEntryWrite(name, {}, dirs)).toBe(true);
  });

  it("matches wiki_lint only with auto_fix", () => {
    expect(isEntryWrite("wiki_lint", { auto_fix: true }, dirs)).toBe(true);
    expect(isEntryWrite("wiki_lint", { auto_fix: false }, dirs)).toBe(false);
    expect(isEntryWrite("wiki_lint", {}, dirs)).toBe(false);
  });

  it("does not match reads or upkeep", () => {
    for (const name of [
      "wiki_recall",
      "wiki_search",
      "wiki_status",
      "wiki_rebuild_meta",
      "wiki_reindex",
      "wiki_log_event",
      "read",
    ]) {
      expect(isEntryWrite(name, {}, dirs)).toBe(false);
    }
  });

  it("matches write/edit by target path inside a wiki dir", () => {
    expect(isEntryWrite("write", { path: join(wiki, "entities", "a.md") }, dirs)).toBe(true);
    expect(isEntryWrite("write", { path: join(wiki, "..", "config.json") }, dirs)).toBe(false);
    expect(isEntryWrite("write", { path: "/elsewhere/a.md" }, dirs)).toBe(false);
    expect(
      isEntryWrite(
        "edit",
        { path: join(wiki, "a.md"), edits: [{ oldText: "a", newText: "b" }] },
        dirs,
      ),
    ).toBe(true);
    expect(isEntryWrite("edit", { path: "/elsewhere/a.md", edits: [] }, dirs)).toBe(false);
  });

  it("matches bash only when the command text names .llm-wiki", () => {
    expect(isEntryWrite("bash", { command: "sed -i 's/a/b/' ~/.llm-wiki/wiki/a.md" }, dirs)).toBe(
      true,
    );
    expect(isEntryWrite("bash", { command: "grep -r x ~/.llm-wiki" }, dirs)).toBe(true);
    expect(isEntryWrite("bash", { command: "ls /home" }, dirs)).toBe(false);
    // Documented limit: a command that reaches the vault without naming it.
    expect(isEntryWrite("bash", { command: 'cd "$V" && rm a.md' }, dirs)).toBe(false);
  });
});

describe("gateToolCall", () => {
  const call = { toolName: "wiki_retro", input: { slug: "s", title: "T", body: "B" } };
  const ui = (answer: boolean, seen: string[] = []) => ({
    hasUI: true,
    ui: {
      confirm: async (_title: string, message: string) => {
        seen.push(message);
        return answer;
      },
    },
  });

  it("does nothing when auto capture is ON", async () => {
    const seen: string[] = [];
    expect(await gateToolCall(call, ui(false, seen), true, dirs)).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("blocks with no UI", async () => {
    expect(await gateToolCall(call, { hasUI: false }, false, dirs)).toEqual({
      block: true,
      reason: NO_UI_REASON,
    });
    expect(await gateToolCall(call, undefined, false, dirs)).toEqual({
      block: true,
      reason: NO_UI_REASON,
    });
  });

  it("asks with the full input; declines block, approvals pass", async () => {
    const seen: string[] = [];
    const long = "x".repeat(5000);
    const big = { toolName: "wiki_observe", input: { title: "T", content: long } };
    expect(await gateToolCall(big, ui(false, seen), false, dirs)).toEqual({
      block: true,
      reason: DECLINED_REASON,
    });
    expect(seen[0]).toContain("Tool: wiki_observe");
    expect(seen[0]).toContain(long);
    expect(await gateToolCall(big, ui(true), false, dirs)).toBeUndefined();
  });

  it("never asks for non-entry calls", async () => {
    const seen: string[] = [];
    expect(
      await gateToolCall({ toolName: "wiki_search", input: {} }, ui(false, seen), false, dirs),
    ).toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

describe("capture prompts follow the setting", () => {
  it("system-prompt footer swaps without stacking", () => {
    const on = appendWikiStatus("base", true);
    expect(on.endsWith(WIKI_STATUS_BLOCK)).toBe(true);
    const off = appendWikiStatus(on, false);
    expect(off).toBe(`base\n\n${WIKI_STATUS_BLOCK_NO_CAPTURE}`);
    expect(appendWikiStatus(off, true)).toBe(`base\n\n${WIKI_STATUS_BLOCK}`);
    expect(WIKI_STATUS_BLOCK_NO_CAPTURE).not.toMatch(/wiki_observe|wiki_retro/);
  });

  it("tool wording carries no capture prompt when OFF", () => {
    const texts = (autoCapture: boolean) => {
      const tools: Array<{ description: string; promptGuidelines?: string[] }> = [];
      const pi = {
        registerTool: (t: (typeof tools)[number]) => tools.push(t),
      } as unknown as ExtensionAPI;
      registerWikiObserve(pi, undefined, undefined, { autoCapture });
      registerWikiRetro(pi, undefined, { autoCapture });
      return JSON.stringify(tools.map((t) => [t.description, t.promptGuidelines]));
    };
    expect(texts(false)).not.toMatch(/proactively|END of every|after non-trivial/);
    expect(texts(true)).toMatch(/proactively/);
    expect(texts(true)).toMatch(/END of every/);
  });

  it("session notice names no capture tool when OFF", () => {
    expect(buildSessionNotice(false)).not.toMatch(/wiki_observe|wiki_retro/);
    expect(buildSessionNotice(true)).toContain("wiki_observe");
  });

  it("recall footer drops 'Add new findings' when OFF", () => {
    const results = [
      { id: "concepts/a", title: "A", type: "concept", score: 9, preview: "p" },
    ] as unknown as RecallResult[];
    for (const linksOnly of [false, true]) {
      expect(formatRecallContext(results, { linksOnly, autoCapture: false })).not.toContain(
        "Add new findings",
      );
      expect(formatRecallContext(results, { linksOnly, autoCapture: true })).toContain(
        "Add new findings",
      );
    }
  });
});
