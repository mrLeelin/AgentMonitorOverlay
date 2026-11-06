import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FILE_MARK_MIME, lineSuffix, parseFileMarkDrag, type MessageImage } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { attachable, attachmentUrl, uploadAttachment } from "../lib/attachments.js";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";
import type { FileRefItem } from "./refs.js";
import { fileToken, imageToken, resourceSpans, resourceDraft } from "./inlineResources.js";

// What the composer holds besides its text: images pasted or dropped in (uploaded at once, sent by id) and file
// references (paths, sent as a block at the end of the message).

export interface PendingImage {
  key: string;
  name: string;
  /** A local object URL, so the thumbnail shows before the upload ends. */
  preview: string;
  state: "uploading" | "ready" | "failed";
  /** The attachment id once uploaded. */
  id?: string;
  error?: string;
}

/** What `take()` hands over for sending, and `restore()` puts back if sending failed. */
export interface ComposerAttachments {
  images: PendingImage[];
  files: string[];
  /** The files as sent: marked ones (S12-D) with their range and note. */
  refs: FileRefItem[];
}

/**
 * The real path of a dropped or picked file (Electron's webUtils, through the preload); "" in a plain browser or for
 * a file that only exists in memory. Read from window.amo without widening its shared type.
 */
export function pathOfFile(file: File): string {
  const bridge = window.amo as { pathForFile?(file: File): string } | undefined;
  try {
    return bridge?.pathForFile?.(file) ?? "";
  } catch {
    return "";
  }
}

/** Whether a drag carries files (from Explorer, or another app). */
export const dragHasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
/** Whether a drag carries a mark from the marks window (S12-D). */
export const dragHasMark = (e: DragEvent) => [...e.dataTransfer.types].includes(FILE_MARK_MIME);

/** A chip's key: the path, plus the lines for a marked range (the same file can be referenced at two ranges). */
export const refKey = (r: FileRefItem) => `${r.path}${lineSuffix(r.startLine, r.endLine)}`;

const IMAGE_CACHE = "amo.inlineImages";
function cachedImages(): Record<string, { id: string; name: string }> {
  const stored = readStoredJson(IMAGE_CACHE);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, { id: string; name: string }] => {
    const v = entry[1] as { id?: unknown; name?: unknown } | null;
    return !!v && typeof v.id === "string" && /^att-[\da-f-]{36}$/.test(v.id) && typeof v.name === "string";
  }));
}

function rememberImage(key: string, image: { id: string; name: string }): void {
  // Only ids and names are kept; no bearer tokens or temporary object URLs are written to disk.
  const entries = Object.entries({ ...cachedImages(), [key]: image }).slice(-1000);
  writeStoredJson(IMAGE_CACHE, Object.fromEntries(entries));
  window.dispatchEvent(new Event("amo:inline-image-ready"));
}

export function useAttachments(link: HostLink, inline?: { text: string; insert(tokens: string): void }) {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  // Range and note of the marked files among `files`, by key.
  const [details, setDetails] = useState<ReadonlyMap<string, FileRefItem>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  // Uploads finish after the list may have changed; the latest list decides whether the result still belongs.
  const live = useRef(new Set<string>());
  const previews = useRef(new Map<string, string>());
  const forgetPreview = (key: string) => {
    const preview = previews.current.get(key);
    if (preview) URL.revokeObjectURL(preview);
    previews.current.delete(key);
    live.current.delete(key);
  };
  const insertion = useRef(inline?.insert);
  insertion.current = inline?.insert;
  const [, refreshImages] = useState(0);
  useEffect(() => {
    const ready = () => refreshImages((n) => n + 1);
    window.addEventListener("amo:inline-image-ready", ready);
    return () => window.removeEventListener("amo:inline-image-ready", ready);
  }, []);

  const addImages = useCallback(
    (list: readonly File[]) => {
      if (!list.length) return;
      const added = list.map((file) => ({ file, item: { key: `img-${crypto.randomUUID()}`, name: file.name || "图片", preview: URL.createObjectURL(file), state: "uploading" as const } }));
      for (const a of added) { live.current.add(a.item.key); previews.current.set(a.item.key, a.item.preview); }
      setImages((cur) => [...cur, ...added.map((a) => a.item)]);
      insertion.current?.(added.map((a) => imageToken(a.item)).join(" "));
      for (const { file, item } of added) {
        uploadAttachment(link, file)
          .then((att) => {
            if (insertion.current) rememberImage(item.key, { id: att.id, name: item.name });
            if (live.current.has(item.key)) setImages((cur) => cur.map((i) => (i.key === item.key ? { ...i, state: "ready", id: att.id } : i)));
          })
          .catch((err: unknown) =>
            live.current.has(item.key) && setImages((cur) => cur.map((i) => (i.key === item.key ? { ...i, state: "failed", error: err instanceof Error ? err.message : String(err) } : i))),
          );
      }
    },
    [link],
  );

  const addFiles = useCallback((paths: readonly string[]) => {
    const clean = paths.map((p) => p.trim()).filter(Boolean);
    if (clean.length) setFiles((cur) => [...new Set([...cur, ...clean])]);
    if (clean.length) insertion.current?.(clean.map((path) => fileToken({ path })).join(" "));
  }, []);

  /** Marked files (S12-D): chips that carry their range and note. */
  const addRefs = useCallback((refs: readonly FileRefItem[]) => {
    const clean = refs.filter((r) => r.path.trim());
    if (!clean.length) return;
    setDetails((cur) => {
      const next = new Map(cur);
      for (const r of clean) next.set(refKey(r), r);
      return next;
    });
    setFiles((cur) => [...new Set([...cur, ...clean.map(refKey)])]);
    insertion.current?.(clean.map(fileToken).join(" "));
  }, []);

  /** Images become thumbnails; other files (and images too big or of another type) become path references. */
  const addDropped = useCallback(
    (list: readonly File[]) => {
      const pics = list.filter(attachable);
      const others = list.filter((f) => !attachable(f));
      addImages(pics);
      const paths = others.map(pathOfFile);
      addFiles(paths);
      const missing = paths.filter((p) => !p).length;
      setNotice(missing ? `有 ${missing} 个文件拿不到路径，没有加入引用` : null);
    },
    [addImages, addFiles],
  );

  const removeImage = (key: string) => {
    forgetPreview(key);
    setImages((cur) => cur.filter((i) => i.key !== key));
  };
  const removeFile = (path: string) => setFiles((cur) => cur.filter((p) => p !== path));
  const refOf = (key: string): FileRefItem => details.get(key) ?? { path: key };
  // Keep removed uploads alive until this draft goes: Undo may bring their tokens back. Only resources still in
  // the text block sending, so deleting a failed/slow upload immediately unblocks the composer.
  const spans = inline ? resourceSpans(inline.text) : [];
  const selectedKeys = new Set(spans.flatMap((s) => s.resource.kind === "image" ? [s.resource.key] : []));
  const cache = inline ? cachedImages() : {};
  const selectedImages: PendingImage[] = inline ? [...selectedKeys].map((key) => {
    const current = images.find((i) => i.key === key);
    if (current) return current;
    const saved = cache[key];
    if (saved) return { key, name: saved.name, id: saved.id, preview: attachmentUrl(link, saved.id), state: "ready" };
    const name = spans.find((s) => s.resource.kind === "image" && s.resource.key === key)?.resource;
    return { key, name: name?.kind === "image" ? name.name : "图片", preview: "", state: "failed", error: "图片已失效，请重新添加" };
  }) : images;
  const selectedRefs = inline ? spans.flatMap((s) => s.resource.kind === "file" ? [s.resource.ref] : []) : files.map(refOf);
  const missingImage = selectedImages.some((i) => i.state === "failed" && !i.preview);

  /** Hands everything over for sending and empties the composer (the previews stay valid until `release`). */
  const take = (): ComposerAttachments => {
    const out = { images: selectedImages, files: selectedRefs.map(refKey), refs: selectedRefs };
    for (const image of images) {
      if (selectedImages.some((i) => i.key === image.key)) continue;
      forgetPreview(image.key);
    }
    setImages([]);
    setFiles([]);
    setNotice(null);
    return out;
  };
  const restore = (a: ComposerAttachments) => {
    for (const i of a.images) live.current.add(i.key);
    setImages((cur) => [...a.images.map((i) => i.id ? { ...i, preview: attachmentUrl(link, i.id) } : i), ...cur]);
    if (insertion.current) {
      setFiles((cur) => [...new Set([...cur, ...a.files])]);
      setDetails((cur) => new Map([...cur, ...a.refs.map((r) => [refKey(r), r] as const)]));
    } else addRefs(a.refs);
  };
  const release = (a: ComposerAttachments) => {
    for (const i of a.images) {
      forgetPreview(i.key);
    }
  };
  const reset = useCallback(() => {
    // Cleanup also runs on unmount, when React no longer evaluates queued state updaters.
    for (const key of [...previews.current.keys()]) forgetPreview(key);
    setImages([]);
    live.current.clear();
    setFiles([]);
    setDetails(new Map());
    setNotice(null);
  }, []);
  useEffect(() => reset, [reset]);

  return {
    images: selectedImages,
    files: inline ? [...new Set(selectedRefs.map(refKey))] : files,
    notice,
    empty: !selectedImages.length && !selectedRefs.length && !missingImage,
    uploading: selectedImages.some((i) => i.state === "uploading"),
    failed: missingImage || selectedImages.some((i) => i.state === "failed"),
    missingImage,
    restoreMessage(text: string, images: readonly MessageImage[]): string {
      const draft = resourceDraft(text, images);
      for (const image of draft.images) rememberImage(image.key, { id: image.id, name: image.name });
      return draft.text;
    },
    addImages,
    addFiles,
    addRefs,
    refOf: (key: string) => selectedRefs.find((r) => refKey(r) === key) ?? refOf(key),
    addDropped,
    removeImage,
    removeFile,
    take,
    restore,
    release,
    reset,
    /**
     * Ctrl+V: a screenshot (or copied image) is attached; files copied in Explorer are taken like a drop. Text still
     * pastes as usual.
     */
    onPaste(e: ClipboardEvent) {
      const pasted = [...e.clipboardData.files];
      if (!pasted.length) return;
      if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
      addDropped(pasted);
    },
    onDragOver(e: DragEvent): boolean {
      if (!dragHasFiles(e) && !dragHasMark(e)) return false;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return true;
    },
    onDrop(e: DragEvent): boolean {
      const mark = dragHasMark(e) ? parseFileMarkDrag(e.dataTransfer.getData(FILE_MARK_MIME)) : null;
      if (mark) {
        e.preventDefault();
        addRefs([{ path: mark.path, startLine: mark.startLine, endLine: mark.endLine, note: mark.note }]);
        return true;
      }
      if (!e.dataTransfer.files.length) return false;
      e.preventDefault();
      addDropped([...e.dataTransfer.files]);
      return true;
    },
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;
