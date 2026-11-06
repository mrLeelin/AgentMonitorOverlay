import { useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type CSSProperties, type DragEventHandler, type KeyboardEvent, type Ref } from "react";
import "./resourceInput.css";
import { replaceResources } from "./inlineResources.js";

export const RESOURCE_CLIPBOARD_MIME = "application/x-amo-composer-text";

export interface InputResource {
  token: string;
  label: string;
  kind: "image" | "file" | "url";
  preview?: string;
  state?: "uploading" | "ready" | "failed";
  title?: string;
}

export interface ResourceInputHandle {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly value: string;
  insert(text: string): void;
}

export interface ResourceInputProps {
  ref?: Ref<ResourceInputHandle>;
  value: string;
  onChange(value: string): void;
  onSelect?(selection: { selectionStart: number }): void;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  onPaste?(event: ClipboardEvent<HTMLDivElement>): void;
  onDrop?: DragEventHandler<HTMLDivElement>;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  resources: readonly InputResource[];
  mentions?: readonly string[];
  onOpen?(token: string): void;
  onRemove?(token: string): void;
}

interface Snapshot { text: string; start: number; end: number }
const atomToken = (node: Node): string | undefined => node instanceof HTMLElement ? node.dataset.resourceToken : undefined;

/** Only text and our resource tokens are stored; pasted markup never becomes part of the draft. */
function readNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLElement && node.dataset.resourceTail !== undefined) return "";
  const token = atomToken(node);
  if (token !== undefined) return token;
  if (node.nodeName === "BR") return "\n";
  let out = "";
  for (const child of node.childNodes) {
    if ((child.nodeName === "DIV" || child.nodeName === "P") && out && !out.endsWith("\n")) out += "\n";
    out += readNode(child);
  }
  return out;
}

function selectionAt(root: HTMLElement, fallback: Snapshot): Snapshot {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return fallback;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return fallback;
  const offset = (node: Node, at: number, end: boolean) => {
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    const element = node instanceof Element ? node : node.parentElement;
    const atom = element?.closest<HTMLElement>("[data-resource-token]");
    if (atom && root.contains(atom)) {
      if (range.collapsed || end) prefix.setEndAfter(atom);
      else prefix.setEndBefore(atom);
    } else prefix.setEnd(node, at);
    return readNode(prefix.cloneContents()).length;
  };
  return { text: readNode(root), start: offset(range.startContainer, range.startOffset, false), end: offset(range.endContainer, range.endOffset, true) };
}

function setSelection(root: HTMLElement, start: number, end: number) {
  const point = (offset: number): [Node, number] => {
    let left = Math.max(0, offset);
    const walk = (node: Node): [Node, number] | null => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i]!;
        const token = atomToken(child);
        const length = readNode(child).length;
        if (token !== undefined) {
          if (left <= length) return [node, i + (left > length / 2 ? 1 : 0)];
        } else if (child.nodeType === Node.TEXT_NODE) {
          if (left <= length) return [child, left];
        } else if (child.nodeName === "BR") {
          if (left === 0) return [node, i];
        } else if (left <= length) {
          const found = walk(child);
          if (found) return found;
        }
        left -= length;
      }
      return null;
    };
    return walk(root) ?? [root, root.childNodes.length];
  };
  const [a, ai] = point(start);
  const [b, bi] = point(end);
  const range = document.createRange();
  range.setStart(a, ai);
  range.setEnd(b, bi);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Plain text offsets remain compatible with @, slash commands and template insertion. */
export function ResourceInput(props: ResourceInputProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const held = useRef<Snapshot>({ text: props.value, start: props.value.length, end: props.value.length });
  const history = useRef<Snapshot[]>([{ ...held.current }]);
  const historyAt = useRef(0);
  const composing = useRef(false);
  const signature = useRef("");
  const emitted = useRef<string | null>(null);

  function remember(next: Snapshot) {
    const current = history.current[historyAt.current]!;
    if (current.text === next.text) return;
    history.current = [...history.current.slice(0, historyAt.current + 1), { ...next }].slice(-150);
    historyAt.current = history.current.length - 1;
  }

  function track() {
    if (!root.current) return held.current;
    held.current = selectionAt(root.current, held.current);
    latest.current.onSelect?.({ selectionStart: held.current.start });
    return held.current;
  }

  function draw(text: string, selection: Snapshot, restore: boolean) {
    const el = root.current;
    if (!el) return;
    const scroll = el.scrollTop;
    const resources = [...latest.current.resources].filter((r) => r.token).sort((a, b) => b.token.length - a.token.length);
    const names = [...(latest.current.mentions ?? [])].sort((a, b) => b.length - a.length);
    const fragment = document.createDocumentFragment();
    const plain = (text: string) => {
      let at = 0;
      while (at < text.length) {
        const name = names.find((name) => text.startsWith(`@${name}`, at));
        if (name) {
          const span = document.createElement("span");
          span.className = "mention-token";
          span.textContent = `@${name}`;
          fragment.append(span);
          at += name.length + 1;
        } else {
          let end = text.indexOf("@", at + 1);
          if (end < 0) end = text.length;
          fragment.append(document.createTextNode(text.slice(at, end)));
          at = end;
        }
      }
    };
    let at = 0;
    while (at < text.length) {
      let next: InputResource | undefined;
      let pos = text.length;
      for (const resource of resources) {
        const index = text.indexOf(resource.token, at);
        if (index >= 0 && index < pos) { pos = index; next = resource; }
      }
      plain(text.slice(at, pos));
      if (!next) break;
      const atom = document.createElement("span");
      atom.className = `resource-atom resource-${next.kind}`;
      atom.contentEditable = "false";
      atom.dataset.resourceToken = next.token;
      atom.dataset.state = next.state ?? "ready";
      atom.title = next.title ?? next.label;
      atom.setAttribute("data-testid", "inline-resource");
      const open = document.createElement("button");
      open.type = "button";
      open.tabIndex = -1;
      open.className = "resource-open";
      open.dataset.resourceOpen = "";
      open.setAttribute("aria-label", next.kind === "image" ? `查看大图 ${next.label}` : `打开 ${next.label}`);
      if (next.preview) {
        const image = document.createElement("img");
        image.src = next.preview;
        image.alt = "";
        image.draggable = false;
        open.append(image);
      } else {
        const icon = document.createElement("span");
        icon.className = "resource-kind";
        icon.textContent = next.kind === "url" ? "↗" : next.kind === "image" ? "▧" : "▤";
        icon.setAttribute("aria-hidden", "true");
        open.append(icon);
      }
      const label = document.createElement("span");
      label.className = "resource-label";
      label.textContent = next.label;
      open.append(label);
      atom.append(open);
      if (next.state === "uploading" || next.state === "failed") {
        const state = document.createElement("span");
        state.className = "resource-state";
        state.textContent = next.state === "uploading" ? "上传中" : "失败";
        atom.append(state);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.tabIndex = -1;
      remove.className = "resource-remove";
      remove.dataset.resourceRemove = "";
      remove.textContent = "×";
      remove.disabled = !!latest.current.disabled;
      remove.setAttribute("aria-label", `移除 ${next.label}`);
      atom.append(remove);
      fragment.append(atom);
      at = pos + next.token.length;
    }
    // A final BR gives an empty last line (and a position after the last chip) a caret box.
    const tail = document.createElement("br");
    tail.dataset.resourceTail = "";
    fragment.append(tail);
    el.replaceChildren(fragment);
    el.dataset.empty = text ? "false" : "true";
    if (restore) setSelection(el, selection.start, selection.end);
    el.scrollTop = scroll;
  }

  function change(next: Snapshot) {
    held.current = next;
    emitted.current = next.text;
    remember(next);
    latest.current.onChange(next.text);
    latest.current.onSelect?.({ selectionStart: next.start });
  }

  function insert(text: string) {
    if (latest.current.disabled || !root.current) return;
    const before = track();
    history.current[historyAt.current] = { ...before };
    const nextText = before.text.slice(0, before.start) + text + before.text.slice(before.end);
    const next = { text: nextText, start: before.start + text.length, end: before.start + text.length };
    root.current.focus();
    draw(nextText, next, true);
    change(next);
  }

  function undo(direction: number) {
    const index = historyAt.current + direction;
    if (index < 0 || index >= history.current.length || latest.current.disabled) return;
    historyAt.current = index;
    const next = { ...history.current[index]! };
    held.current = next;
    emitted.current = next.text;
    draw(next.text, next, true);
    latest.current.onChange(next.text);
    latest.current.onSelect?.({ selectionStart: next.start });
  }

  useImperativeHandle(props.ref, () => ({
    focus() {
      const saved = { ...held.current };
      root.current?.focus();
      held.current = saved;
      if (root.current) setSelection(root.current, saved.start, saved.end);
    },
    setSelectionRange(start, end) {
      const length = latest.current.value.length;
      held.current = { text: latest.current.value, start: Math.min(length, Math.max(0, start)), end: Math.min(length, Math.max(start, end)) };
      if (root.current) setSelection(root.current, held.current.start, held.current.end);
      latest.current.onSelect?.({ selectionStart: held.current.start });
    },
    get selectionStart() { return track().start; },
    get selectionEnd() { return track().end; },
    get value() { return root.current ? readNode(root.current) : latest.current.value; },
    insert,
  }));

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || composing.current) return;
    const nextSignature = JSON.stringify([props.resources, props.mentions]);
    const current = readNode(el);
    const focused = document.activeElement === el;
    let selection = selectionAt(el, held.current);
    if (current !== props.value) {
      const ownChange = emitted.current === props.value;
      if (!ownChange) {
        // A picker or @ completion replaces text outside the DOM. Move the caret through that edit rather than
        // keeping its old numeric offset in the middle of the newly inserted name.
        let prefix = 0;
        while (prefix < current.length && prefix < props.value.length && current[prefix] === props.value[prefix]) prefix++;
        let suffix = 0;
        while (suffix < current.length - prefix && suffix < props.value.length - prefix && current[current.length - suffix - 1] === props.value[props.value.length - suffix - 1]) suffix++;
        const after = (offset: number) => offset < prefix ? offset : offset >= current.length - suffix ? offset + props.value.length - current.length : props.value.length - suffix;
        selection = { text: props.value, start: Math.max(0, after(selection.start)), end: Math.max(0, after(selection.end)) };
        if (!props.value) { history.current = [{ ...selection }]; historyAt.current = 0; }
        else remember(selection);
      }
    }
    if (current !== props.value || signature.current !== nextSignature || !el.childNodes.length) draw(props.value, selection, focused);
    signature.current = nextSignature;
    held.current = { ...selection, text: props.value };
    emitted.current = null;
  });

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (composing.current || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y") {
        event.preventDefault();
        undo(event.key.toLowerCase() === "y" || event.shiftKey ? 1 : -1);
        return;
      }
    }
    props.onKeyDown?.(event);
    if (event.defaultPrevented || props.disabled) return;
    if (event.key === "Enter") { event.preventDefault(); insert("\n"); return; }
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    const selected = track();
    if (selected.start !== selected.end) {
      // Native deletion can leave part of a noneditable chip selected (for example a drag that ends on its label).
      // Delete through the raw token model so a resource is always one unit, including in a mixed text selection.
      event.preventDefault();
      insert("");
      return;
    }
    let at = 0;
    for (const node of root.current?.childNodes ?? []) {
      const token = atomToken(node);
      const end = at + readNode(node).length;
      if (token && ((event.key === "Backspace" && selected.start === end) || (event.key === "Delete" && selected.start === at))) {
        event.preventDefault();
        held.current = { ...selected, start: at, end };
        if (root.current) setSelection(root.current, at, end);
        insert("");
        return;
      }
      at = end;
    }
  }

  function copy(event: ClipboardEvent<HTMLDivElement>, cut: boolean) {
    const selected = track();
    if (selected.start === selected.end) return;
    event.preventDefault();
    const raw = selected.text.slice(selected.start, selected.end);
    event.clipboardData.setData(RESOURCE_CLIPBOARD_MIME, raw);
    event.clipboardData.setData("text/plain", replaceResources(raw, (r) => r.kind === "image" ? `【图片：${r.name}】` : r.kind === "file" ? r.ref.path : r.url));
    if (cut && !props.disabled) insert("");
  }

  return (
    <div
      ref={root}
      className="resource-input"
      role="textbox"
      aria-multiline="true"
      aria-label={props["aria-label"]}
      aria-placeholder={props.placeholder}
      aria-disabled={props.disabled || undefined}
      data-testid={props["data-testid"]}
      data-placeholder={props.placeholder}
      data-empty={!props.value}
      style={{ "--resource-rows": props.rows ?? 2 } as CSSProperties}
      contentEditable={!props.disabled}
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={keyDown}
      onSelect={track}
      onBlur={track}
      onFocus={track}
      onBeforeInput={(event) => {
        const type = (event.nativeEvent as InputEvent).inputType;
        if (type === "historyUndo" || type === "historyRedo") { event.preventDefault(); undo(type === "historyUndo" ? -1 : 1); }
        else if (!composing.current) history.current[historyAt.current] = { ...track() };
      }}
      onInput={() => {
        if (composing.current) return;
        const selected = track();
        change(selected);
      }}
      onCompositionStart={() => {
        history.current[historyAt.current] = { ...track() };
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        const selected = track();
        change(selected);
      }}
      onPaste={(event) => {
        const raw = event.clipboardData.getData(RESOURCE_CLIPBOARD_MIME);
        if (raw && !props.disabled) { event.preventDefault(); insert(raw); return; }
        if (props.disabled) { event.preventDefault(); return; }
        props.onPaste?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        insert(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
      }}
      onDrop={(event) => {
        if (props.disabled) { event.preventDefault(); return; }
        props.onDrop?.(event);
        if (event.defaultPrevented || event.dataTransfer.files.length) return;
        // Structured drags (bookmarks and file marks) belong to the outer composer. Browser HTML drags are plain
        // text here; accepting their default DOM would also accept formatting and editable descendants.
        const types = [...event.dataTransfer.types];
        if (types.some((type) => type.startsWith("application/"))) return;
        if (!types.some((type) => type === "text/plain" || type === "text/html" || type === "text/uri-list")) return;
        event.preventDefault();
        event.stopPropagation();
        insert((event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list")).replace(/\r\n?/g, "\n"));
      }}
      onCopy={(event) => copy(event, false)}
      onCut={(event) => copy(event, true)}
      onMouseDown={(event) => {
        if ((event.target as Element).closest(".resource-atom button")) event.preventDefault();
      }}
      onClick={(event) => {
        const target = event.target as Element;
        const atom = target.closest<HTMLElement>("[data-resource-token]");
        const token = atom?.dataset.resourceToken;
        if (!token) return;
        if (target.closest("[data-resource-remove]") && !props.disabled) {
          if (root.current && atom) {
            // Copy/paste may reference the same resource twice. Remove the clicked occurrence, not the first token.
            const prefix = document.createRange();
            prefix.selectNodeContents(root.current);
            prefix.setEndBefore(atom);
            const index = readNode(prefix.cloneContents()).length;
            setSelection(root.current, index, index + token.length);
            insert("");
          }
          props.onRemove?.(token);
        } else if (target.closest("[data-resource-open]")) props.onOpen?.(token);
      }}
    />
  );
}
