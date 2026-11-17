import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { ResourceInput, type ResourceInputHandle } from "../attach/ResourceInput.js";
import { MentionList, useComposerMentions } from "../attach/useMentions.js";
import type { MentionPick } from "../attach/mentions.js";
import { fileToken, resourceSpans } from "../attach/inlineResources.js";
import { baseName } from "../attach/refs.js";
import { FileSelector } from "../attach/FileSelector.js";
import { PromptTemplateDialog } from "../attach/PromptTemplateDialog.js";
import { viewFile } from "../files/FileLinks.js";
import { SlashMenu, useSlashCommands } from "./cli/SlashMenu.js";

/** Goal accepts text and file references, without starting a message or running a slash command. */
export function GoalObjectiveInput({ link, session, tasks, sessions, projects, value, refs, onChange, onRefs, disabled }: {
  link: HostLink;
  session: Session;
  tasks: readonly Task[];
  sessions: readonly Session[];
  projects: readonly Workspace[];
  value: string;
  refs: ReadonlyMap<string, MentionPick>;
  onChange(text: string): void;
  onRefs(refs: ReadonlyMap<string, MentionPick>): void;
  disabled: boolean;
}) {
  const input = useRef<ResourceInputHandle>(null);
  const [finding, setFinding] = useState<string | null>(null);
  const focus = (caret?: number | null) => requestAnimationFrame(() => {
    input.current?.focus();
    if (caret !== undefined && caret !== null) input.current?.setSelectionRange(caret, caret);
  });
  const mentions = useComposerMentions({
    link, text: value, setText: onChange, tasks, sessions, projects, current: session,
    picks: { value: refs, set: onRefs }, inlineFiles: true, subsession: false, commit: false,
    onFile: (path) => input.current?.insert(`${fileToken({ path })} `),
    onFind: setFinding,
  });
  const slash = useSlashCommands({ link, session, text: value, setText: onChange, completionOnly: true, onComplete: focus });
  const resources = resourceSpans(value).flatMap(({ token, resource }) => resource.kind === "file"
    ? [{ token, kind: "file" as const, label: baseName(resource.ref.path), title: resource.ref.path }]
    : []);
  return (
    <div className="goal-field">
      <span>要完成的目标</span>
      <div className="goal-input">
        <ResourceInput ref={input} value={value} onChange={onChange} resources={resources} mentions={mentions.names} skills={slash.skills} onOpenSkill={slash.openSkill}
          aria-label="要完成的目标" rows={3} placeholder="描述要完成的工作和完成标准…（支持 @、/、$）" disabled={disabled} data-testid="goal-objective-input"
          onSelect={(selection) => { mentions.track(selection); slash.track(selection); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (slash.onKeyDown(event) || mentions.onKeyDown(event)) event.stopPropagation();
          }}
          onOpen={(token) => {
            const resource = resourceSpans(token)[0]?.resource;
            if (resource?.kind === "file") viewFile({ file: resource.ref }, session.workspaceId, session.id);
          }} />
      </div>
      {!disabled && <><MentionList mentions={mentions} inline /><SlashMenu slash={slash} inline /></>}
      {finding !== null && session.workspaceId && createPortal(
        <div data-goal-dialog onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <FileSelector link={link} workspaceId={session.workspaceId} initialQuery={finding}
            onPick={(path) => input.current?.insert(`${fileToken({ path })} `)} onClose={() => { setFinding(null); focus(); }} />
        </div>, document.body)}
      {mentions.askingTemplate && <PromptTemplateDialog link={link} workspaceId={session.workspaceId} projects={projects} onDone={(body) => focus(mentions.finishTemplate(body))} />}
    </div>
  );
}
