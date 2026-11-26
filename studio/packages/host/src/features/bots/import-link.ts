import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { BotDraftContent } from "@amo-studio/protocol";
import { z } from "zod";
import { HostError } from "../../core/shared.js";

const ORCA_CLOUD = "https://share.onorca.dev";
const MAX_COMPRESSED = 16 * 1024 * 1024;
const MAX_EXPANDED = 34 * 1024 * 1024;
const BOT_MANIFEST = "dev.orca.bot-sharing/bot.json";
const blockSize = 512;
const expand = promisify(gunzip);
const shareVersion = z.object({
  versionId: z.string().regex(/^[\w-]{1,128}$/u),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  compressedBytes: z.number().int().positive().max(MAX_COMPRESSED),
});
const botManifest = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  purpose: z.string().optional(),
  memory: z.array(z.object({ topic: z.string().regex(/^[a-z0-9-]{1,64}$/u) })).max(64).default([]),
});

/** Read portable text fields into a draft. No files from the archive are extracted or executed. */
async function readDraft(archive: Buffer): Promise<BotDraftContent> {
  const bytes = await expand(archive, { maxOutputLength: MAX_EXPANDED });
  const text = (start: number, end: number) => bytes.toString("utf8", start, end).split("\0", 1)[0]!.trim();
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + blockSize <= bytes.length;) {
    const name = text(offset, offset + 100);
    if (!name) break;
    const prefix = text(offset + 345, offset + 500);
    const path = prefix ? `${prefix}/${name}` : name;
    const octal = text(offset + 124, offset + 136);
    const length = Number.parseInt(octal, 8);
    const start = offset + blockSize;
    const next = start + Math.ceil(length / blockSize) * blockSize;
    if (!/^[0-7]+$/u.test(octal) || next > bytes.length) throw new Error("Invalid Bot archive");
    if (path === BOT_MANIFEST || path === "SOUL.md" || /^memory\/[a-z0-9-]+\.md$/u.test(path)) {
      const type = bytes[offset + 156];
      if ((type !== 0 && type !== 48) || files.has(path)) throw new Error("Invalid Bot archive entry");
      files.set(path, bytes.subarray(start, start + length));
    }
    offset = next;
  }
  const manifest = botManifest.parse(JSON.parse(files.get(BOT_MANIFEST)?.toString("utf8") ?? ""));
  const purpose = files.get("SOUL.md")?.toString("utf8").trim() || manifest.purpose?.trim() || "";
  const memory = manifest.memory.flatMap(({ topic }) => {
    const note = files.get(`memory/${topic}.md`)?.toString("utf8").trim();
    return note ? [`## ${topic}\n\n${note}`] : [];
  }).join("\n\n");
  if (purpose.length > 8000 || memory.length > 32_000) throw new HostError("bad_request", "分享中的职责或记忆超出 AMO 的长度上限，请改用 Markdown 文件导入。");
  return { name: manifest.name.slice(0, 40), purpose, memory };
}

async function readResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) throw new Error("Bot share is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Orca v1.4 public share protocol. Only its public API and the HTTPS storage it grants are contacted. */
export async function importOrcaBot(input: unknown, fetcher = fetch): Promise<BotDraftContent> {
  const link = typeof input === "string" && input.length <= 2048 ? URL.parse(input.trim()) : null;
  const id = link && /^\/bots\/share\/([\w-]{1,128})\/?$/u.exec(link.pathname)?.[1];
  if (!link || !id || !["https://app.orca.dev", "https://app.onorca.dev", ORCA_CLOUD].includes(link.origin) || link.username || link.password) {
    throw new HostError("bad_request", "请粘贴 Orca 的 Bot 分享链接。");
  }
  const url = `${ORCA_CLOUD}/v1/bot-shares/${id}`;
  const init: RequestInit = { signal: AbortSignal.timeout(15_000), redirect: "error" };
  async function fetchShare(path: string, options: RequestInit = {}) {
    const response = await fetcher(path, { ...init, ...options });
    if (response.ok) return response;
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new HostError("not_found", "找不到这个分享链接，链接可能已撤回。");
    if (response.status === 409) throw new HostError("conflict", "分享版本有变化，请重新继续。");
    throw new Error(`Orca responded with HTTP ${response.status}`);
  }
  try {
    const json = async (response: Response): Promise<unknown> => JSON.parse((await readResponse(response, 512 * 1024)).toString("utf8")) as unknown;
    const { share: { version } } = z.object({ share: z.object({ version: shareVersion }) }).parse(await json(await fetchShare(url)));
    const grant = z.object({ grant: z.object({ url: z.string() }), version: shareVersion }).parse(await json(await fetchShare(`${url}/download-grants`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId: version.versionId }),
    })));
    const download = new URL(grant.grant.url);
    const fromStorage = download.hostname === "storage.googleapis.com" || download.hostname.endsWith(".storage.googleapis.com");
    if (download.protocol !== "https:" || download.port || download.username || download.password || (!fromStorage && download.origin !== ORCA_CLOUD)) throw new Error("Unexpected Bot storage");
    if (grant.version.versionId !== version.versionId || grant.version.archiveSha256 !== version.archiveSha256 || grant.version.compressedBytes !== version.compressedBytes) throw new Error("Bot share version changed");
    const archive = await readResponse(await fetchShare(download.href), version.compressedBytes);
    if (archive.byteLength !== version.compressedBytes || createHash("sha256").update(archive).digest("hex") !== version.archiveSha256) throw new Error("Bot share integrity check failed");
    return await readDraft(archive);
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError("bad_request", "无法读取 Orca Bot 分享。请核对链接，或稍后重试。");
  }
}
