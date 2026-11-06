import { useRef, useState } from "react";
import { lineSuffix } from "@amo-studio/protocol";
import { ResourceInput, type ResourceInputHandle, type ResourceInputProps } from "./ResourceInput.js";
import type { AttachmentsState } from "./useAttachments.js";
import { resourceSpans, urlResource } from "./inlineResources.js";
import { baseName } from "./refs.js";
import { Lightbox } from "./MessageAttachments.js";
import { viewFile, useFileLinks } from "../files/FileLinks.js";

/** The same input for a first message and a running conversation. Uploading never owns the text selection. */
export function AttachmentInput({ attach, ref, ...props }: Omit<ResourceInputProps, "resources" | "onPaste" | "onOpen" | "onRemove"> & { attach: AttachmentsState }) {
  const local = useRef<ResourceInputHandle>(null);
  const [open, setOpen] = useState<string | null>(null);
  const fileLinks = useFileLinks();
  const imageKeys = [...new Set(resourceSpans(props.value).flatMap((s) => s.resource.kind === "image" ? [s.resource.key] : []))];
  const resources = resourceSpans(props.value).map(({ token, resource: r }) => {
    if (r.kind === "image") {
      const image = attach.images.find((i) => i.key === r.key);
      return { token, kind: r.kind, label: `图片 ${imageKeys.indexOf(r.key) + 1} · ${r.name}`, preview: image?.preview || undefined, state: image?.state ?? "failed" as const, title: image?.error || r.name };
    }
    if (r.kind === "file") return { token, kind: r.kind, label: `${baseName(r.ref.path)}${lineSuffix(r.ref.startLine, r.ref.endLine)}`, title: `${r.ref.path}${lineSuffix(r.ref.startLine, r.ref.endLine)}${r.ref.note ? `\n${r.ref.note}` : ""}` };
    let host = r.url;
    try { host = new URL(r.url).hostname; } catch { /* Preserve a pasted draft as text even if its URL was edited. */ }
    return { token, kind: r.kind, label: r.title || host, title: r.url };
  });
  return <>
    <ResourceInput
      {...props}
      ref={(handle) => {
        local.current = handle;
        if (typeof ref === "function") ref(handle);
        else if (ref) ref.current = handle;
      }}
      resources={resources}
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
          e.preventDefault();
          attach.addDropped([...e.clipboardData.files]);
          return;
        }
        const token = urlResource(e.clipboardData.getData("text/plain") || e.clipboardData.getData("text/uri-list"));
        if (token) { e.preventDefault(); local.current?.insert(token); }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) return;
        const url = e.dataTransfer.getData("text/uri-list").split(/\r?\n/).find((s) => s && !s.startsWith("#")) || e.dataTransfer.getData("text/plain");
        const token = urlResource(url);
        if (token) { e.preventDefault(); e.stopPropagation(); local.current?.insert(token); }
      }}
      onOpen={(token) => {
        const resource = resourceSpans(token)[0]?.resource;
        if (resource?.kind === "image") {
          const image = attach.images.find((i) => i.key === resource.key);
          if (image?.preview) setOpen(image.preview);
        } else if (resource?.kind === "url") void window.amo?.openExternal?.(resource.url);
        else if (resource?.kind === "file") {
          const target = { file: { path: resource.ref.path }, ...(resource.ref.startLine ? { line: resource.ref.startLine, endLine: resource.ref.endLine ?? undefined } : {}) };
          // Draft attachments are local files even when the conversation itself is running on another device.
          if (fileLinks && !fileLinks.remote) fileLinks.open(target);
          else viewFile(target, null);
        }
      }}
    />
    {(attach.notice || attach.missingImage) && <span className="attach-notice" role="status">{attach.notice || "有图片已失效，请重新添加或移除。"}</span>}
    {open && <Lightbox src={open} onClose={() => setOpen(null)} />}
  </>;
}
