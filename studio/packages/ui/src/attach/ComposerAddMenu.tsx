import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "../lib/ContextMenu.js";
import { pickFolder } from "../lib/profiles.js";
import { ComposerToolIcon } from "./ComposerToolIcon.js";
import { IconPaperclip } from "./icons.js";
import { SketchDialog } from "./SketchDialog.js";
import type { AttachmentsState } from "./useAttachments.js";
import "./composer-tools.css";

interface Props {
  attach: AttachmentsState;
  fileInputId: string;
  disabled?: boolean;
  remote?: boolean;
  goal?: { action?: () => void; detail: string };
}

export function ComposerAddMenu({ attach, fileInputId, disabled, remote, goal }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"add" | "files" | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderError, setFolderError] = useState("");
  const writable = useRef(!disabled);
  writable.current = !disabled;

  useLayoutEffect(() => {
    if (menu) box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:enabled')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!disabled) return;
    setMenu(null);
    setDrawing(false);
  }, [disabled]);

  async function chooseFolder() {
    const owner = trigger.current;
    setMenu(null);
    setFolderOpen(true);
    try {
      const path = await pickFolder();
      if (owner?.isConnected && writable.current && path) attach.addFiles([path]);
    } catch (error) {
      if (owner?.isConnected) setFolderError(`无法打开文件夹选择器：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFolderOpen(false);
    }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      trigger.current?.focus({ preventScroll: true });
      setMenu(null);
      return;
    }
    if (event.key === "ArrowLeft" && menu === "files") {
      event.preventDefault();
      setMenu("add");
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:enabled')];
    if (!buttons.length) return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  const anchor = menu ? trigger.current?.getBoundingClientRect() : undefined;
  const above = !!anchor && anchor.top >= 190;
  return <>
    <button ref={trigger} type="button" className="round-btn attach composer-add" aria-label="添加" title="添加文件、绘图或目标" aria-haspopup="menu" aria-expanded={!!menu} disabled={disabled || folderOpen}
      onClick={() => { setFolderError(""); setMenu(menu ? null : "add"); }} onKeyDown={(event) => {
        if (event.key !== "ArrowDown" || menu) return;
        event.preventDefault();
        setFolderError("");
        setMenu("add");
      }}><ComposerToolIcon name="plus" /></button>
    <input ref={picker} type="file" multiple hidden data-testid={fileInputId} onChange={(event) => {
      if (writable.current) attach.addDropped([...(event.currentTarget.files ?? [])]);
      event.currentTarget.value = "";
    }} />
    {menu && anchor && createPortal(
      <ContextMenu key={menu} at={{ x: anchor.left, y: above ? anchor.top - 7 : anchor.bottom + 7 }} above={above}
        label={menu === "files" ? "文件和文件夹" : "添加"} className="composer-add-menu" boxRef={box} trigger={trigger.current ?? undefined} onClose={() => {
          if (box.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
          setMenu(null);
        }} onKeyDown={navigate}>
        {menu === "add" ? <>
          <div className="composer-add-heading">添加</div>
          <button type="button" role="menuitem" aria-haspopup="menu" onClick={() => setMenu("files")}><IconPaperclip /><span>文件和文件夹</span><ComposerToolIcon name="next" size={13} /></button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setDrawing(true); }}><ComposerToolIcon name="pen" /><span>绘图</span><small>绘制草图</small></button>
          <button type="button" role="menuitem" disabled={!goal?.action} title={goal?.detail ?? "远程会话暂不支持 Goal"} onClick={() => { setMenu(null); goal?.action?.(); }}>
            <ComposerToolIcon name="goal" /><span>目标模式</span><small>{goal?.detail ?? "远程会话暂不支持"}</small>
          </button>
        </> : <>
          <button type="button" role="menuitem" className="composer-add-back" onClick={() => setMenu("add")}><ComposerToolIcon name="back" size={14} /><span>返回添加</span></button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); trigger.current?.focus({ preventScroll: true }); picker.current?.click(); }}><IconPaperclip /><span>选择文件…</span></button>
          <button type="button" role="menuitem" disabled={remote} title={remote ? "远程传输文件夹请先打包" : undefined} onClick={() => void chooseFolder()}><ComposerToolIcon name="folder" /><span>选择文件夹…</span>{remote && <small>请先打包</small>}</button>
        </>}
      </ContextMenu>, document.body,
    )}
    {folderError && <span className="attach-notice" role="alert">{folderError}</span>}
    {drawing && !disabled && <SketchDialog onClose={() => {
      setDrawing(false);
      trigger.current?.focus({ preventScroll: true });
    }} onAttach={(image) => {
      setDrawing(false);
      if (writable.current) attach.addImages([image]);
    }} />}
  </>;
}
