import type { Id, ToolFields, TurnState } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { RuntimeCore } from "../runtime.js";
import { classifyCommand, fileDiff, formatInput, head, shortPath, tail, textDiff } from "../items.js";

type RecordValue = Record<string, any>;
type Block = { itemId: Id; type: "agent" | "reasoning"; startedAt: number };

// Pi's low-level agent_end may be followed by retries or compaction. Only the runtime closes the Studio turn,
// after agent_settled; this class translates the content inside that turn.
export class PiTranscript {
  private turn: { itemId: Id; turnId: Id } | null = null;
  private readonly blocks = new Map<number, Block>();
  private readonly tools = new Map<string, Id>();
  private compaction: Id | null = null;
  private failure: string | undefined;

  constructor(private readonly core: RuntimeCore, private readonly sessionId: Id, private readonly cwd?: string) {}

  turnRef(): { turnId?: string } { return this.turn ? { turnId: this.turn.turnId } : {}; }
  turnItemId(): Id | null { return this.turn?.itemId ?? null; }
  failed(): string | undefined { return this.failure; }

  openTurn(): void {
    if (this.turn) return;
    const turnId = newId("t");
    const item = this.core.appendItem(this.sessionId, { type: "turn", turnId, state: "running", startedAt: this.core.now().toISOString() }, { method: "prompt", turnId });
    this.turn = { itemId: item.id, turnId };
    this.failure = undefined;
  }

  closeTurn(state: Exclude<TurnState, "running">, error?: string): void {
    this.finishBlocks();
    for (const itemId of this.tools.values()) this.core.updateItem(itemId, (it) => it.type === "tool" && it.status === "running" ? { ...it, status: "failed" } : it);
    this.tools.clear();
    if (this.compaction) this.core.updateItem(this.compaction, (it) => it.type === "compaction" && it.state === "running" ? { ...it, state: "failed", error: error || "压缩已中断" } : it);
    this.compaction = null;
    if (!this.turn) return;
    this.core.updateItem(this.turn.itemId, (it) => it.type === "turn" ? { ...it, state, endedAt: this.core.now().toISOString(), retry: undefined, ...(error ? { error } : {}) } : it);
    this.turn = null;
  }

  event(e: RecordValue): void {
    switch (e.type) {
      case "message_start":
        if (e.message?.role === "assistant") {
          this.finishBlocks();
          this.finalContent(e.message.content, true);
        }
        return;
      case "message_update": {
        const update = e.assistantMessageEvent;
        if (!update || !Number.isInteger(update.contentIndex)) return;
        const kind = String(update.type);
        if (!kind.startsWith("text_") && !kind.startsWith("thinking_")) return;
        const type = kind.startsWith("text_") ? "agent" : "reasoning";
        if (kind.endsWith("_start")) this.block(update.contentIndex, type);
        else if (kind.endsWith("_delta")) this.writeBlock(update.contentIndex, type, str(update.delta), true, true);
        else if (kind.endsWith("_end")) this.writeBlock(update.contentIndex, type, str(update.content), false);
        return;
      }
      case "message_end": {
        const message = e.message;
        if (message?.role !== "assistant") return;
        this.finalContent(message.content, false);
        this.finishBlocks();
        this.failure = message.stopReason === "error" || message.stopReason === "aborted" ? str(message.errorMessage) || (message.stopReason === "aborted" ? "Pi 的回复已中断" : "Pi 模型调用失败") : undefined;
        this.addUsage(message.usage);
        return;
      }
      case "tool_execution_start": {
        if (!e.toolCallId || this.tools.has(e.toolCallId)) return;
        const item = this.core.appendItem(this.sessionId, { type: "tool", ...describePiTool(str(e.toolName) || "tool", e.args, this.cwd), status: "running" }, { method: e.type, itemId: e.toolCallId, ...this.turnRef() });
        this.tools.set(e.toolCallId, item.id);
        return;
      }
      case "tool_execution_update":
      case "tool_execution_end": {
        const itemId = this.tools.get(e.toolCallId);
        if (!itemId) return;
        const ended = e.type === "tool_execution_end";
        const result = ended ? e.result : e.partialResult;
        const output = outputText(result);
        const exitCode = result?.details?.exitCode;
        this.core.updateItem(itemId, (it) => it.type === "tool" ? {
          ...it,
          ...(output !== undefined ? { detail: tail(output) } : {}),
          ...(ended ? { status: e.isError ? "failed" : "completed" } : {}),
          ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
          ...(typeof exitCode === "number" ? { exitCode } : {}),
        } : it);
        if (ended) this.tools.delete(e.toolCallId);
        return;
      }
      case "compaction_start":
      case "auto_compaction_start":
        if (!this.compaction) this.compaction = this.core.appendItem(this.sessionId, { type: "compaction", state: "running", trigger: e.reason === "manual" ? "manual" : "auto" }, { method: e.type, ...this.turnRef() }).id;
        return;
      case "compaction_end":
      case "auto_compaction_end": {
        const error = str(e.errorMessage) || (e.aborted ? "压缩已中断" : "");
        const result = e.result;
        // Some older versions emit the result without a matching start.
        const body = { type: "compaction" as const, state: result && !error ? "completed" as const : "failed" as const, trigger: e.reason === "manual" ? "manual" as const : "auto" as const, ...(num(result?.tokensBefore) !== undefined ? { beforeTokens: num(result.tokensBefore) } : {}), ...(num(result?.estimatedTokensAfter) !== undefined ? { afterTokens: num(result.estimatedTokensAfter) } : {}), ...(error ? { error } : {}) };
        if (this.compaction) this.core.updateItem(this.compaction, (it) => it.type === "compaction" ? { ...it, ...body } : it);
        else this.core.appendItem(this.sessionId, body, { method: e.type, ...this.turnRef() });
        this.compaction = null;
        return;
      }
      case "auto_retry_start":
      case "summarization_retry_scheduled":
        if (this.turn) this.core.updateItem(this.turn.itemId, (it) => it.type === "turn" ? { ...it, retry: { attempt: num(e.attempt) ?? 1, ...(num(e.maxAttempts) !== undefined ? { max: num(e.maxAttempts) } : {}), reason: str(e.errorMessage) || "Pi 正在重试" } } : it);
        return;
      case "auto_retry_end":
      case "summarization_retry_finished":
        if (e.type === "auto_retry_end" && e.success === false) this.failure = str(e.finalError) || this.failure || "Pi 重试失败";
        if (this.turn) this.core.updateItem(this.turn.itemId, (it) => it.type === "turn" ? { ...it, retry: undefined } : it);
        return;
    }
  }

  private block(index: number, type: Block["type"]): Block {
    const existing = this.blocks.get(index);
    if (existing?.type === type) return existing;
    if (existing) this.core.updateItem(existing.itemId, (it) => it.type === "agent" ? { ...it, markdown: "", streaming: false } : it.type === "reasoning" ? { ...it, text: "", streaming: false } : it);
    const body = type === "agent" ? { type, markdown: "", streaming: true } : { type, text: "", streaming: true };
    const item = this.core.appendItem(this.sessionId, body, { method: "message_update", ...this.turnRef() });
    const block = { itemId: item.id, type, startedAt: this.core.now().getTime() };
    this.blocks.set(index, block);
    return block;
  }

  private writeBlock(index: number, type: Block["type"], text: string, streaming: boolean, append = false): void {
    const block = this.block(index, type);
    this.core.updateItem(block.itemId, (it) => it.type === "agent" ? { ...it, markdown: (append ? it.markdown : "") + text, streaming } : it.type === "reasoning" ? { ...it, text: (append ? it.text : "") + text, streaming, ...(!streaming ? { durationMs: this.core.now().getTime() - block.startedAt } : {}) } : it);
  }

  private finalContent(content: unknown, streaming: boolean): void {
    if (!Array.isArray(content)) return;
    const seen = new Set<number>();
    content.forEach((value: RecordValue, index) => {
      if (value?.type !== "text" && value?.type !== "thinking") return;
      seen.add(index);
      this.writeBlock(index, value.type === "text" ? "agent" : "reasoning", str(value.type === "text" ? value.text : value.thinking), streaming);
    });
    if (!streaming) for (const [index, block] of this.blocks) if (!seen.has(index)) this.writeBlock(index, block.type, "", false);
  }

  private finishBlocks(): void {
    for (const block of this.blocks.values()) this.core.updateItem(block.itemId, (it) => it.type === "agent" || it.type === "reasoning" ? { ...it, streaming: false, ...(it.type === "reasoning" ? { durationMs: this.core.now().getTime() - block.startedAt } : {}) } : it);
    this.blocks.clear();
  }

  private addUsage(usage: RecordValue | undefined): void {
    if (!this.turn || !usage) return;
    const cachedInput = num(usage.cacheRead) ?? 0;
    const input = (num(usage.input) ?? 0) + cachedInput + (num(usage.cacheWrite) ?? 0);
    const output = num(usage.output) ?? 0;
    this.core.updateItem(this.turn.itemId, (it) => it.type === "turn" ? { ...it, usage: { ...it.usage, input: (it.usage?.input ?? 0) + input, cachedInput: (it.usage?.cachedInput ?? 0) + cachedInput, output: (it.usage?.output ?? 0) + output, reasoning: it.usage?.reasoning ?? 0, context: input + output } } : it);
  }
}

function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function outputText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return undefined;
  const content = (result as RecordValue).content;
  if (!Array.isArray(content)) return undefined;
  return content.map((block) => block?.type === "text" ? str(block.text) : block?.type === "image" ? "（图片结果）" : "").filter(Boolean).join("\n");
}

export function describePiTool(name: string, raw: unknown, cwd?: string): Omit<ToolFields, "status"> {
  const args = raw && typeof raw === "object" ? raw as RecordValue : {};
  const path = shortPath(str(args.path) || str(args.file_path), cwd);
  const input = formatInput(raw);
  const common = { name, ...(input ? { input } : {}) };
  if (name === "bash") {
    const command = str(args.command);
    const guess = classifyCommand(command);
    return { ...common, kind: guess?.kind ?? "command", summary: guess?.target || command || name, input: head(command), ...(cwd ? { cwd } : {}) };
  }
  if (name.startsWith("mcp__")) return { ...common, kind: "mcp", summary: name.split("__").slice(1).join(" · ") };
  if (name === "read") return { ...common, kind: "read", summary: path || name };
  if (name === "grep" || name === "find") return { ...common, kind: "search", summary: [str(args.pattern), path].filter(Boolean).join(" · ") || name };
  if (name === "ls") return { ...common, kind: "list", summary: path || "." };
  if (name === "edit" || name === "write") {
    const before = str(args.oldText), after = str(name === "edit" ? args.newText : args.content);
    return { ...common, kind: "edit", summary: path || name, ...(path ? { files: [fileDiff(path, name === "write" ? "add" : "update", textDiff(before, after))] } : {}) };
  }
  return { ...common, kind: "other", summary: str(args.description) || path || name };
}
