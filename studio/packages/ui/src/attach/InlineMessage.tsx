import { Fragment, type ReactNode } from "react";
import type { MessageImage } from "@amo-studio/protocol";
import { inlineFileNote } from "./inlineResources.js";
import type { FileRefItem } from "./refs.js";
import { MessageFiles, MessageImages } from "./MessageAttachments.js";

/** The visible labels are plain Chinese for the model; the transcript resolves their numbered attachments. */
export function inlineMessage(text: string, images: readonly MessageImage[], files: readonly FileRefItem[], renderText: (text: string) => ReactNode) {
  const usedImages = new Set<number>();
  const usedFiles = new Set<FileRefItem>();
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(/【(图片|资源) (\d+)：[^】]*】|https?:\/\/[^\s<>（）【】，。；]+/g)) {
    const url = /^https?:\/\//i.test(match[0]) ? match[0] : null;
    const n = Number(match[2]);
    const image = match[1] === "图片" ? images[n - 1] : undefined;
    const file = match[1] === "资源" ? files.find((f) => f.note === inlineFileNote(n) || f.note?.startsWith(`${inlineFileNote(n)}；`)) : undefined;
    if (!image && !file && !url) continue;
    parts.push(<Fragment key={`text-${at}`}>{renderText(text.slice(at, match.index))}</Fragment>);
    const shownFile = file ? { ...file, note: file.note?.replace(/^文中资源 \d+(?:；)?/, "") || undefined } : null;
    let host = url;
    try { if (url) host = new URL(url).hostname; } catch { /* A malformed URL remains visible and inert below. */ }
    parts.push(url
      ? <button key={`url-${match.index}`} type="button" className="file-chip msg-url" title={url} onClick={() => { if (/^https?:\/\//i.test(url)) void window.amo?.openExternal?.(url); }}>↗ {host}</button>
      : image
      ? <MessageImages key={`image-${match.index}`} inline images={[image]} />
      : <MessageFiles key={`file-${match.index}`} inline files={[shownFile!]} />);
    if (image) usedImages.add(n - 1);
    if (file) usedFiles.add(file);
    at = match.index! + match[0].length;
  }
  parts.push(<Fragment key={`text-${at}`}>{renderText(text.slice(at))}</Fragment>);
  return { parts, images: images.filter((_, i) => !usedImages.has(i)), files: files.filter((f) => !usedFiles.has(f)) };
}
