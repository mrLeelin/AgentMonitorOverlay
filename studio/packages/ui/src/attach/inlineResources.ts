import { baseName, type FileRefItem, withFileRefs, splitFileRefItems } from "./refs.js";

export type InlineResource =
  | { kind: "image"; key: string; name: string }
  | { kind: "file"; ref: FileRefItem }
  | { kind: "url"; url: string; title?: string };

export interface ResourceSpan { token: string; start: number; end: number; resource: InlineResource }

/** Encoded data keeps brackets, Chinese names and Windows paths out of the token's delimiters. */
export function resourceToken(resource: InlineResource): string {
  return `[[amo:${resource.kind}:${encodeURIComponent(JSON.stringify(resource))}]]`;
}

export function resourceSpans(text: string): ResourceSpan[] {
  const out: ResourceSpan[] = [];
  for (const m of text.matchAll(/\[\[amo:(image|file|url):([^\]\r\n]+)\]\]/g)) {
    try {
      const r = JSON.parse(decodeURIComponent(m[2]!)) as InlineResource;
      if (!r || r.kind !== m[1]) continue;
      if (r.kind === "image" && !(typeof r.key === "string" && typeof r.name === "string")) continue;
      if (r.kind === "file" && !(r.ref && typeof r.ref.path === "string" && r.ref.path.trim())) continue;
      if (r.kind === "url" && !(typeof r.url === "string" && /^https?:\/\//i.test(r.url) && (!r.title || typeof r.title === "string"))) continue;
      out.push({ token: m[0], start: m.index!, end: m.index! + m[0].length, resource: r });
    } catch { /* A malformed token is ordinary text, never executable markup. */ }
  }
  return out;
}

export function urlResource(text: string, title?: string): string | null {
  const url = text.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return resourceToken({ kind: "url", url, ...(title ? { title } : {}) });
  } catch { return null; }
}

export const fileToken = (ref: FileRefItem): string => resourceToken({ kind: "file", ref });
export const imageToken = (image: { key: string; name: string }): string => resourceToken({ kind: "image", key: image.key, name: image.name });

/** Human-readable labels also let QuickStart and the task title use a draft without leaking internal tokens. */
export function resourceText(text: string): string {
  return replaceResources(text, (r) => r.kind === "image" ? `【图片：${r.name}】` : r.kind === "file" ? `【${baseName(r.ref.path)}】` : r.url);
}

/** A resource at the end of a sentence shouldn't become part of its automatically chosen task name. */
export function resourceTitle(text: string): string | undefined {
  const spans = resourceSpans(text);
  const first = spans[0]?.resource;
  if (!first) return undefined;
  const prose = replaceResources(text, () => "").trim();
  const fallback = first.kind === "image" ? first.name : first.kind === "file" ? baseName(first.ref.path) : first.title || first.url;
  return (prose || fallback).split(/\r?\n/)[0]!.slice(0, 100);
}

export function replaceResources(text: string, replace: (r: InlineResource, token: string) => string): string {
  let at = 0;
  let out = "";
  for (const s of resourceSpans(text)) {
    out += text.slice(at, s.start) + replace(s.resource, s.token);
    at = s.end;
  }
  return out + text.slice(at);
}

/** Numbered references remain correct when a remote Host rewrites file paths on the receiving computer. */
export const inlineFileNote = (n: number) => `文中资源 ${n}`;
const safeLabel = (s: string) => s.replace(/[\r\n【】]/g, " ");

export function resourceMessage(text: string, images: readonly { key: string; id?: string }[]): { text: string; ids: string[] } {
  const ids: string[] = [];
  const imageNumbers = new Map<string, number>();
  const files: FileRefItem[] = [];
  const fileNumbers = new Map<string, number>();
  const body = replaceResources(text, (r, token) => {
    if (r.kind === "url") return r.title ? `${r.title}（${r.url}）` : r.url;
    if (r.kind === "image") {
      const image = images.find((i) => i.key === r.key);
      if (!image?.id) throw new Error(`图片「${r.name}」尚未准备好，请重新添加或移除。`);
      if (!imageNumbers.has(r.key)) { ids.push(image.id); imageNumbers.set(r.key, ids.length); }
      return `【图片 ${imageNumbers.get(r.key)}：${safeLabel(r.name)}】`;
    }
    if (!fileNumbers.has(token)) {
      const n = files.length + 1;
      fileNumbers.set(token, n);
      files.push({ ...r.ref, note: `${inlineFileNote(n)}${r.ref.note ? `；${r.ref.note}` : ""}` });
    }
    return `【资源 ${fileNumbers.get(token)}：${safeLabel(baseName(r.ref.path))}】`;
  });
  return { text: withFileRefs(body, files), ids };
}

/** Taking an unanswered message back must restore its actual resources, not just the visible numbered labels. */
export function resourceDraft(message: string, images: readonly { id: string | null; path: string }[]) {
  const { text, refs } = splitFileRefItems(message);
  const restored: Array<{ key: string; name: string; id: string }> = [];
  const usedImages = new Set<number>();
  const usedFiles = new Set<FileRefItem>();
  const image = (n: number, name: string): string | null => {
    const source = images[n];
    if (!source?.id) return null;
    const item = { key: `restored-${source.id}`, id: source.id, name };
    restored.push(item);
    usedImages.add(n);
    return imageToken(item);
  };
  let draft = text.replace(/【(图片|资源) (\d+)：([^】]*)】/g, (whole, kind: string, number: string, name: string) => {
    const n = Number(number);
    if (kind === "图片") return image(n - 1, name) ?? whole;
    const ref = refs.find((r) => r.note === inlineFileNote(n) || r.note?.startsWith(`${inlineFileNote(n)}；`));
    if (!ref) return whole;
    usedFiles.add(ref);
    return fileToken({ ...ref, note: ref.note?.replace(/^文中资源 \d+(?:；)?/, "") || undefined });
  });
  const extra = [
    ...images.flatMap((i, n) => usedImages.has(n) ? [] : [image(n, baseName(i.path))].filter((s): s is string => !!s)),
    ...refs.filter((r) => !usedFiles.has(r)).map(fileToken),
  ];
  if (extra.length) draft += `${draft ? "\n" : ""}${extra.join(" ")}`;
  return { text: draft, images: restored };
}
