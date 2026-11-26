import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { importOrcaBot } from "./import-link.js";

const shareLink = "https://app.orca.dev/bots/share/test-share";
const downloadUrl = "https://storage.googleapis.com/test-bot/archive";

function fixtureArchive() {
  const files = {
    "dev.orca.bot-sharing/bot.json": JSON.stringify({ schemaVersion: 1, name: "分享审核员", purpose: "概述", memory: [{ topic: "review" }], tools: [{ url: "https://tool.invalid" }], permission: "full-auto", fast: true }),
    "SOUL.md": "阅读改动并报告证据。",
    "memory/review.md": "先检查项目约定。",
    "skills/example/SKILL.md": "不属于 Bot 草稿的内容",
  };
  return gzipSync(Buffer.concat([...Object.entries(files).flatMap(([path, body]) => {
    const header = Buffer.alloc(512);
    const bytes = Buffer.from(body);
    header.write(path);
    header.write(bytes.length.toString(8).padStart(11, "0"), 124);
    header[156] = 48;
    return [header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
  }), Buffer.alloc(1024)]));
}

function fixtureFetch({ download = downloadUrl, corrupt = false } = {}) {
  const archive = fixtureArchive();
  const version = { versionId: "version-1", archiveSha256: createHash("sha256").update(archive).digest("hex"), compressedBytes: archive.length };
  const fetched = new Uint8Array(archive);
  if (corrupt) fetched[0] = 0;
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ share: { version } }))
    .mockResolvedValueOnce(Response.json({ grant: { url: download }, version }))
    .mockResolvedValueOnce(new Response(fetched));
}

it("reads the pinned Orca share into portable draft fields", async () => {
  const fetcher = fixtureFetch();
  await expect(importOrcaBot(shareLink, fetcher)).resolves.toEqual({ name: "分享审核员", purpose: "阅读改动并报告证据。", memory: "## review\n\n先检查项目约定。" });
  expect(fetcher).toHaveBeenNthCalledWith(1, "https://share.onorca.dev/v1/bot-shares/test-share", expect.objectContaining({ redirect: "error" }));
  expect(fetcher).toHaveBeenNthCalledWith(2, "https://share.onorca.dev/v1/bot-shares/test-share/download-grants", expect.objectContaining({ method: "POST", body: '{"versionId":"version-1"}' }));
  expect(fetcher).toHaveBeenNthCalledWith(3, downloadUrl, expect.objectContaining({ redirect: "error" }));
});

it("rejects unrelated URLs and download grants outside the supported storage", async () => {
  const fetcher = fixtureFetch({ download: "https://127.0.0.1/bot" });
  await expect(importOrcaBot("https://app.orca.dev.example.com/bots/share/example", fetcher)).rejects.toThrow("请粘贴 Orca");
  expect(fetcher).not.toHaveBeenCalled();
  await expect(importOrcaBot(shareLink, fetcher)).rejects.toThrow("无法读取");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("surfaces missing shares and rejects a damaged archive", async () => {
  const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(importOrcaBot(shareLink, missing)).rejects.toThrow("找不到这个分享链接");
  await expect(importOrcaBot(shareLink, fixtureFetch({ corrupt: true }))).rejects.toThrow("无法读取");
});
