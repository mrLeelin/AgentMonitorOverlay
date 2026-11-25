import { ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES, composeAnnotationRefs, type MessageImage } from "@amo-studio/protocol";
import { copyText, type HostLink } from "../host/client.js";
import { attachable, attachmentUrl } from "../lib/attachments.js";
import { rawFileUrl } from "../lib/openin.js";
import { MESSAGE_URL_PATTERN, imageToken, resourceDraft, resourceSpans, urlResource } from "./inlineResources.js";
import { baseName, formatFileRef, withFileRefs, type FileRefItem } from "./refs.js";

interface MessageSource {
  text: string;
  refs: readonly FileRefItem[];
  images: readonly MessageImage[];
  annotations: Parameters<typeof composeAnnotationRefs>[1];
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

async function messageFormats({ text, refs, images, annotations }: MessageSource, link: HostLink | null, workspaceId?: string, remote?: boolean) {
  // Reuse the composer conversion so numbered references and standalone attachments keep their original positions.
  const draft = resourceDraft(withFileRefs(text, refs), images.map((image, index) => ({ path: image.path, id: String(index) })));
  const imageBlobs = await Promise.all(images.map(async (image) => {
    if (!link || (!image.id && remote)) throw new Error("图片源不可用");
    const url = image.id ? attachmentUrl(link, image.id) : rawFileUrl(link, { path: image.path, workspaceId });
    const response = await fetch(url);
    if (!response.ok) throw new Error("读取图片失败");
    const blob = await response.blob();
    if (!attachable(blob)) throw new Error("图片无法复制");
    return blob;
  }));
  const dataUrls = await Promise.all(imageBlobs.map(asDataUrl));
  const imageIndex = new Map(draft.images.map((image) => [image.key, image.id]));
  const html = document.createElement("div");
  html.dataset.amoMessage = "1";
  let plain = "";
  const appendText = (value: string) => {
    plain += value;
    for (const [i, line] of value.split(/\r?\n/).entries()) {
      if (i) html.append(document.createElement("br"));
      let at = 0;
      for (const match of line.matchAll(MESSAGE_URL_PATTERN)) {
        const url = match[0];
        const start = match.index!;
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.textContent = url;
        html.append(line.slice(at, start), anchor);
        at = start + url.length;
      }
      html.append(line.slice(at));
    }
  };
  let at = 0;
  for (const span of resourceSpans(draft.text)) {
    appendText(draft.text.slice(at, span.start));
    const r = span.resource;
    if (r.kind === "image") {
      const index = imageIndex.get(r.key);
      const src = index === undefined ? undefined : dataUrls[Number(index)];
      if (!src) throw new Error("图片源不可用");
      const img = document.createElement("img");
      img.dataset.amoImage = index!;
      img.setAttribute("src", src);
      img.alt = r.name;
      html.append(img);
    } else if (r.kind === "file") {
      const file = document.createElement("span");
      file.dataset.amoFile = span.token;
      file.textContent = baseName(r.ref.path);
      html.append(file);
      plain += formatFileRef(r.ref);
    } else appendText(r.url);
    at = span.end;
  }
  appendText(draft.text.slice(at));
  if (annotations.length) appendText(`${draft.text ? "\n\n" : ""}${composeAnnotationRefs("", annotations)}`);
  const png = imageBlobs[0] && await asPng(imageBlobs[0]);
  return { text: plain.trim(), html: html.outerHTML, png };
}

export async function copySentMessage(source: MessageSource, link: HostLink | null, workspaceId?: string, remote?: boolean): Promise<void> {
  if (!source.refs.length && !source.images.length) return copyText(composeAnnotationRefs(source.text, source.annotations));
  const formats = messageFormats(source, link, workspaceId, remote);
  if (window.amo?.copyMessage) {
    const { text, html, png } = await formats;
    return window.amo.copyMessage({ text, html, ...(png ? { png: new Uint8Array(await png.arrayBuffer()) } : {}) });
  }
  // Promise-valued formats reserve the clipboard during the click, before fetching the source images.
  await navigator.clipboard.write([new ClipboardItem({
    "text/plain": formats.then(({ text }) => new Blob([text], { type: "text/plain" })),
    "text/html": formats.then(({ html }) => new Blob([html], { type: "text/html" })),
    ...(source.images.length ? { "image/png": formats.then(({ png }) => png!) } : {}),
  })]);
}

/** Accept only our own structure, and decode embedded image bytes without loading anything from pasted HTML. */
export function readSentMessage(html: string): { text: string; images: File[] } | null {
  if (!html.includes("data-amo-message")) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const message = template.content.querySelector('[data-amo-message="1"]');
  if (!message) return null;
  const files: File[] = [];
  const imageKeys = new Map<string, string>();
  let text = "";
  for (const node of message.childNodes) {
    if (!(node instanceof HTMLElement)) { text += node.textContent ?? ""; continue; }
    if (node.tagName === "BR") { text += "\n"; continue; }
    if (node instanceof HTMLImageElement) {
      const imageId = node.dataset.amoImage;
      if (imageId === undefined) return null;
      const name = node.alt || "图片";
      let key = imageKeys.get(imageId);
      if (key === undefined) {
        const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(node.getAttribute("src") ?? "");
        if (!match || !(ATTACHMENT_MIMES as readonly string[]).includes(match[1]!) || match[2]!.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return null;
        try {
          const decoded = atob(match[2]!);
          if (!decoded.length || decoded.length > MAX_ATTACHMENT_BYTES) return null;
          const bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < bytes.length; i++) bytes[i] = decoded.charCodeAt(i);
          key = String(files.length);
          imageKeys.set(imageId, key);
          files.push(new File([bytes], name, { type: match[1] }));
        } catch { return null; }
      }
      text += imageToken({ key, name });
      continue;
    }
    const token = node.dataset.amoFile;
    const file = token ? resourceSpans(token)[0] : undefined;
    if (file?.resource.kind === "file" && file.token === token) { text += token; continue; }
    const url = node instanceof HTMLAnchorElement ? urlResource(node.getAttribute("href") ?? "") : null;
    text += url || node.textContent || "";
  }
  return text ? { text, images: files } : null;
}
