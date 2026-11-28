import { useEffect, useRef, useState } from "react";
import type { ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { samePick } from "../lib/recents.js";
import { EffortBars, FastToggle } from "../chat/pickers.js";
import { MentionList, useComposerMentions } from "../attach/useMentions.js";
import { ResourceInput, type ResourceInputHandle } from "../attach/ResourceInput.js";
import { draftText, submitDraft, useTaskDraft } from "./draft.js";
import { LeadAppointment, openLeadReceipt, type LeadDirectory, type LeadSeed } from "../bots/LeadAppointment.js";
import { ModelRow, tilePicks } from "./ModelRow.js";
import { ChoicePicker } from "./ChoiceRow.js";
import { GROUP_HEADINGS } from "./choices.js";
import { resourceSpans, resourceText } from "../attach/inlineResources.js";
import { useDraftChoices } from "./useDraftChoices.js";
import { readPendingGoalStart } from "./goalStart.js";
import { PRIMARY_ENTER_LABELS, TODO_SHORTCUTS, useTaskEnter } from "../chat/inputPrefs.js";

/**
 * 快速启动条 (Ctrl N, design/ui-directions/new-task.html): start from anywhere — the prompt, the topic and the
 * project — with the model and effort below. It writes the same draft as the draft task page (Ctrl+Shift+N opens that
 * page). 2026-10-29: the topic and the project are two small pickers (the topic's preferred project picked with it);
 * @ refers to projects, tasks and sessions as on the page, and # is plain text.
 */
export function QuickStart({
  link,
  workspaces,
  topics,
  tasks = [],
  sessions = [],
  profiles,
  onClose,
  onExpand,
  onCreated,
  leadDirectory,
}: {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks?: readonly Task[];
  sessions?: readonly Session[];
  profiles: readonly ModelProfile[];
  onClose(): void;
  /** Continue on the draft task page. */
  onExpand(): void;
  onCreated(task: Task, session: Session | null): void;
  leadDirectory?: LeadDirectory;
}) {
  const { draft, update, reset } = useTaskDraft(profiles);
  const taskEnter = useTaskEnter(draft.text);
  const { todoShortcut } = taskEnter;
  const rows = useDraftChoices({ draft, update, workspaces, topics, tasks });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [leadSeed, setLeadSeed] = useState<LeadSeed>();
  const [picking, setPicking] = useState<"topic" | "project" | null>(null);
  const input = useRef<ResourceInputHandle>(null);
  const { choices } = useProfileChoices(link, draft.pick.profileId);
  const model = choices ? activeModel(choices, draft.pick.model ? { model: draft.pick.model } : {}) : undefined;
  // No files here (the bar has no place for them): projects, tasks and their sessions.
  const mentions = useComposerMentions({
    link,
    text: draft.text,
    setText: (text) => update({ text }),
    tasks,
    sessions,
    current: null,
    projects: rows.projects,
    projectsAlways: true,
    workspaceId: null,
    picks: { value: new Map(Object.entries(draft.refs ?? {})), set: (next) => update({ refs: Object.fromEntries(next) }) },
    onFile: () => {},
    onFind: () => {},
    // Template selection is available on the full page.
    templates: false,
  });
  useEffect(() => input.current?.focus(), []);
  const hasResources = resourceSpans(draft.text).length > 0 || !!draft.goal || !!readPendingGoalStart();
  // A draft with inline resources belongs on the full page, where its previews and upload state are available.
  useEffect(() => { if (hasResources) onExpand(); }, [hasResources, onExpand]);

  const project = rows.projects.find((w) => w.id === draft.projectId);
  const topic = rows.topic;

  async function submit(file: boolean) {
    if (hasResources) return onExpand();
    if (busy) return;
    if (!draft.text.trim()) return setError("写一句话再开始。");
    if (draft.lead) return appoint(file);
    setBusy(true);
    setError("");
    try {
      const created = await submitDraft(link, draft, file);
      reset();
      onCreated(created.task, created.session);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }
  function appoint(file: boolean) {
    if (!leadDirectory) return setError("请在「设置 → 工具与自动化 → Bots」开启 Bots，或到完整新建页取消机器人带队。");
    const text = draftText(draft);
    const title = draft.title.trim() || draft.text.trim().split("\n")[0]?.slice(0, 100);
    if (!title) return setError("先写一句交付目标。");
    setError("");
    setLeadSeed({ source: { kind: "manual" }, intent: "create", title, text, workspaceId: project?.id, topicId: topic?.id, profileId: draft.pick.profileId, start: !file });
  }

  const closePicker = () => {
    setPicking(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  if (leadSeed && leadDirectory) return <LeadAppointment directory={leadDirectory} seed={leadSeed} onClose={() => {
    setLeadSeed(undefined);
    requestAnimationFrame(() => input.current?.focus());
  }} onReceipt={(receipt) => {
    reset();
    onClose();
    openLeadReceipt(leadDirectory, receipt);
  }} />;

  return (
    <div className="quick-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="quick" role="dialog" aria-label="快速新任务">
        <div className="quick-in">
          <span className="quick-spark" aria-hidden="true">
            ✳
          </span>
          <ResourceInput
            ref={input}
            value={hasResources ? resourceText(draft.text) : draft.text}
            resources={[]}
            aria-label="快速新任务"
            placeholder="一句话开始新任务，@ 引用项目或任务"
            onChange={(text) => update({ text })}
            onSelect={mentions.track}
            onKeyDown={(e) => {
              if (mentions.onKeyDown(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key.toLowerCase() === "n" && e.ctrlKey && e.shiftKey) {
                e.preventDefault();
                onExpand();
              } else if (e.key === "Tab") {
                // Tab walks the 常用 tiles.
                e.preventDefault();
                const tiles = tilePicks(profiles, draft.pick);
                const i = tiles.findIndex((t) => samePick(t, draft.pick));
                const next = tiles[(i + (e.shiftKey ? tiles.length - 1 : 1)) % tiles.length];
                if (next) update({ pick: next });
              } else {
                const action = taskEnter.action(e);
                if (!action) return;
                e.preventDefault();
                if (!e.repeat) void submit(action === "todo");
              }
            }}
          />
        </div>
        <div className="quick-picks">
          <button type="button" className="quick-pick" aria-label={`专题：${topic?.title ?? "不选"}`} onClick={() => setPicking("topic")} data-testid="quick-topic">
            <span className="quick-pick-lab">专题</span>
            <span className={topic ? "quick-pick-value" : "quick-pick-value none"}>{topic?.title ?? "不选"}</span>
            <span aria-hidden="true">▾</span>
          </button>
          <button type="button" className="quick-pick" aria-label={`项目：${project?.name ?? "不选"}`} onClick={() => setPicking("project")} data-testid="quick-project">
            <span className="quick-pick-lab">项目</span>
            <span className={project ? "quick-pick-value" : "quick-pick-value none"}>{project?.name ?? "不选"}</span>
            {project && rows.preferred.includes(project.id) && <span className="chip-tag">{GROUP_HEADINGS.topic}</span>}
            <span aria-hidden="true">▾</span>
          </button>
        </div>
        <MentionList mentions={mentions} inline />
        {error && (
          <span className="form-error quick-error" role="alert">
            {error}
          </span>
        )}
        <div className="quick-foot">
          <ModelRow link={link} profiles={profiles} pick={draft.pick} onPick={(pick) => update({ pick })} drawer={false} small />
          {model && model.efforts.length > 0 && (
            <EffortBars efforts={model.efforts} value={draft.options.effort ?? null} fallback={model.defaultEffort} onChange={(effort) => update({ options: { ...draft.options, effort } })} small />
          )}
          <FastToggle fast={model?.fast} value={draft.options.fast ?? choices?.defaultFast} onChange={(fast) => update({ options: { ...draft.options, fast } })} small />
          <span className="quick-hints">
            {leadDirectory && <button type="button" className="link-btn" onClick={() => appoint(false)} disabled={busy}>机器人带队</button>}
            <button type="button" className="link-btn" onClick={() => void submit(false)} disabled={busy}>
              <kbd aria-hidden="true">{PRIMARY_ENTER_LABELS[taskEnter.startKey]}</kbd>开始
            </button>
            <button type="button" className="link-btn" onClick={() => void submit(true)} disabled={busy}>
              {todoShortcut !== "off" && <kbd>{TODO_SHORTCUTS[todoShortcut]}</kbd>}放进待办
            </button>
            <span>
              <kbd>Tab</kbd>换模型
            </span>
            <button type="button" className="link-btn" onClick={onExpand}>
              <kbd>Ctrl ⇧ N</kbd>展开
            </button>
          </span>
        </div>
      </div>
      {picking && (
        <ChoicePicker
          noun={picking === "topic" ? "专题" : "项目"}
          choices={picking === "topic" ? rows.topicChoices : rows.projectChoices}
          selected={picking === "topic" ? draft.topicId : draft.projectId}
          noneLabel="不选"
          onPick={(id) => {
            if (picking === "topic") rows.pickTopic(id);
            else rows.pickProject(id);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
