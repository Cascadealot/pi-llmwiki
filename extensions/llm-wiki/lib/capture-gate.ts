import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractMutationPaths } from "./guardrails.js";
import { autoCaptureEnabled, loadTaskConfig } from "./task-config.js";
import {
  getPersonalWikiPaths,
  getVaultPaths,
  isPathWithin,
  resolveProjectVaultRoot,
  resolveVaultPaths,
} from "./utils.js";

/**
 * Auto-capture approval gate.
 *
 * When `llm-wiki.autoCapture` is OFF (the default), every write to a wiki
 * entry waits for operator approval through `ctx.ui.confirm`. With no UI to
 * ask, the write is blocked. When ON, this gate does nothing.
 *
 * "Entry" means content the operator sees as wiki entries. Upkeep the
 * extension does by itself (metadata projections, QMD index, lint report,
 * event log) is not gated.
 *
 * Coverage, and its limits:
 * - Entry tools are matched by name; `wiki_lint` only when `auto_fix` is set.
 * - `write`/`edit` are matched by target path inside any vault's `wiki/`.
 * - `bash` is matched when the command text contains `.llm-wiki`. A command
 *   that reaches a vault without naming it (a variable, a script file, a prior
 *   `cd`) is NOT detected. Read-only commands that name it are gated too.
 */

/** Wiki tools whose calls create or change entries. */
export const ENTRY_TOOLS: ReadonlySet<string> = new Set([
  "wiki_observe",
  "wiki_retro",
  "wiki_ensure_page",
  "wiki_capture_source",
  "wiki_ingest",
  "wiki_capture_trajectory",
]);

/** Substring that marks a `bash` command as touching a vault. */
export const VAULT_DIR_MARKER = ".llm-wiki";

export const DECLINED_REASON = "Operator declined this wiki entry write (auto capture is OFF).";
export const NO_UI_REASON = "Auto capture is OFF and no operator is present to approve this write.";

/** Expand a leading `~` so home-relative tool paths resolve like the shell. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Every vault `wiki/` directory that applies to `cwd`: project + personal. */
export function vaultWikiDirs(cwd: string): string[] {
  const dirs = new Set<string>();
  const add = (fn: () => string) => {
    try {
      dirs.add(fn());
    } catch {
      // An unresolvable vault contributes nothing.
    }
  };
  add(() => resolveVaultPaths(cwd).wiki);
  add(() => getPersonalWikiPaths().wiki);
  const project = resolveProjectVaultRoot(cwd);
  if (project) add(() => getVaultPaths(project).wiki);
  return [...dirs];
}

function withinAny(dirs: string[], path: string): boolean {
  const target = expandHome(path);
  return dirs.some((dir) => {
    try {
      return isPathWithin(dir, target);
    } catch {
      return false;
    }
  });
}

/**
 * True when this tool call writes a wiki entry. Pure apart from path
 * resolution; `wikiDirs` is injected so tests need no real vault.
 */
export function isEntryWrite(toolName: string, input: unknown, wikiDirs: string[]): boolean {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  if (ENTRY_TOOLS.has(toolName)) return true;
  if (toolName === "wiki_lint") return record.auto_fix === true;

  if (toolName === "write") {
    return typeof record.path === "string" && withinAny(wikiDirs, record.path);
  }
  if (toolName === "edit") {
    return extractMutationPaths(input).some((path) => withinAny(wikiDirs, path));
  }
  if (toolName === "bash") {
    return typeof record.command === "string" && record.command.includes(VAULT_DIR_MARKER);
  }
  return false;
}

/** Text shown in the approval prompt: the tool and its full, untruncated input. */
export function describeEntryWrite(toolName: string, input: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    body = String(input);
  }
  return `Tool: ${toolName}\n\n${body}`;
}

interface GateCtx {
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
}

/**
 * Decide one tool call. Returns a block result, or undefined to let it run.
 * `autoCapture` and `wikiDirs` are resolved by the caller (live, per call).
 */
export async function gateToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateCtx | undefined,
  autoCapture: boolean,
  wikiDirs: string[],
): Promise<{ block: true; reason: string } | undefined> {
  if (autoCapture) return undefined;
  if (!isEntryWrite(event.toolName, event.input, wikiDirs)) return undefined;
  if (!ctx?.hasUI || !ctx.ui) return { block: true, reason: NO_UI_REASON };
  const approved = await ctx.ui.confirm(
    "Wiki entry write \u2014 approve?",
    describeEntryWrite(event.toolName, event.input),
  );
  return approved ? undefined : { block: true, reason: DECLINED_REASON };
}

/** Install the gate. The setting is read from disk on every call, so a toggle applies at once. */
export function installCaptureGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = process.cwd();
    const autoCapture = autoCaptureEnabled(loadTaskConfig(cwd));
    if (autoCapture) return undefined;
    return gateToolCall(
      { toolName: event.toolName, input: event.input },
      ctx,
      autoCapture,
      vaultWikiDirs(cwd),
    );
  });
}
