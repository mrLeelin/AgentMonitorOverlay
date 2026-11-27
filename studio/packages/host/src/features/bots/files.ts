import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BotInput } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import type { Store } from "../../store/store.js";

export const BOT_MEMORY_SUMMARY = "自动整理.md";
const temporaryRoots = new WeakMap<Store, string>();

function checked(path: string, kind: "directory" | "file") {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) throw new HostError("bad_request", "Bot 资料目录中存在无效文件或链接。");
  return stat;
}

function directory(store: Store, id: string, create = false) {
  if (!/^[\w-]{1,128}$/.test(id)) throw new HostError("bad_request", "Bot 编号无效。");
  let data = store.path === ":memory:" ? temporaryRoots.get(store) : dirname(store.path);
  if (!data && create) {
    data = mkdtempSync(join(tmpdir(), "amo-bot-files-"));
    temporaryRoots.set(store, data);
  }
  if (!data) return;
  const root = join(data, "bots");
  const bot = join(root, id);
  for (const path of create ? [root, bot, join(bot, "memory")] : [root, bot]) {
    if (!checked(path, "directory")) {
      if (!create) return;
      mkdirSync(path);
    }
  }
  return bot;
}

function read(path: string, limit: number) {
  const stat = checked(path, "file");
  if (!stat) return;
  if (stat.size > limit * 4) throw new HostError("bad_request", "Bot 资料文件过大。");
  const value = readFileSync(path, "utf8").replace(/^\uFEFF/u, "");
  if (value.length > limit) throw new HostError("bad_request", "Bot 资料文件过大。");
  return value;
}

function write(path: string, value: string, expected?: { text: string; limit: number }) {
  checked(path, "file");
  const temporary = join(dirname(path), `.amo-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: "utf8", flag: "wx" });
    if (expected && read(path, expected.limit) !== expected.text) throw new HostError("conflict", "Bot 资料文件已变化，请重新读取后再保存。");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readBotFiles(store: Store, id: string, input: BotInput): BotInput {
  const folder = directory(store, id);
  if (!folder) return input;
  return { ...input, purpose: read(join(folder, "SOUL.md"), 8000) ?? input.purpose, memory: read(join(folder, "MEMORY.md"), 32_000) ?? input.memory };
}

export function ensureBotFiles(store: Store, id: string, input: BotInput) {
  const folder = directory(store, id, true)!;
  for (const [name, text] of [["SOUL.md", input.purpose], ["MEMORY.md", input.memory]] as const) {
    const path = join(folder, name);
    if (!checked(path, "file")) write(path, text);
  }
  return folder;
}

/** Roll back changed files if writing the other document or committing the configuration fails. */
export function updateBotFiles<T>(store: Store, id: string, input: BotInput, previous: BotInput | undefined, commit: () => T): T {
  const folder = ensureBotFiles(store, id, previous ?? input);
  const undo: Array<{ path: string; text: string; written: string; limit: number }> = [];
  try {
    for (const [name, value, before, limit] of [["SOUL.md", input.purpose, previous?.purpose, 8000], ["MEMORY.md", input.memory, previous?.memory, 32_000]] as const) {
      if (before === undefined || value === before) continue;
      const path = join(folder, name);
      write(path, value, { text: before, limit });
      undo.push({ path, text: before, written: value, limit });
    }
    return commit();
  } catch (error) {
    if (previous) for (const { path, text, written, limit } of undo.reverse()) {
      // A local editor can replace the file while the Host is saving. Preserve that edit even during rollback.
      if (read(path, limit) === written) write(path, text, { text: written, limit });
    }
    else rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

export function removeBotFiles<T>(store: Store, id: string, commit: () => T): T {
  const folder = directory(store, id);
  if (!folder) return commit();
  const trash = join(dirname(folder), `.deleted-${randomUUID()}`);
  renameSync(folder, trash);
  let result: T;
  try { result = commit(); }
  catch (error) { renameSync(trash, folder); throw error; }
  rmSync(trash, { recursive: true, force: true });
  return result;
}

function noteName(name: unknown): string {
  if (typeof name !== "string" || !/^[\p{L}\p{N}_-][\p{L}\p{N} _.-]{0,74}\.md$/iu.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\./iu.test(name)) {
    throw new HostError("bad_request", "请输入有效的 Markdown 文件名，例如 审查笔记.md。");
  }
  return name;
}

export function listBotNotes(folder: string) {
  return readdirSync(join(folder, "memory"), { withFileTypes: true }).filter((file) => file.isFile() && /\.md$/iu.test(file.name))
    .map((file) => file.name).filter((name) => { try { noteName(name); return true; } catch { return false; } }).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function readBotNote(folder: string, name: unknown) {
  const text = read(join(folder, "memory", noteName(name)), 32_000);
  if (text === undefined) throw new HostError("not_found", "这份记忆文件已不存在。");
  return text;
}

export function writeBotNote(folder: string, name: unknown, text: unknown, expected: unknown) {
  const file = noteName(name);
  if (typeof text !== "string" || text.length > 32_000) throw new HostError("bad_request", "请检查记忆文件长度。");
  const path = join(folder, "memory", file);
  if (expected !== undefined && (read(path, 32_000) ?? null) !== expected) throw new HostError("conflict", "记忆文件已变化，请重新打开后再保存。");
  write(path, text);
  return file;
}
