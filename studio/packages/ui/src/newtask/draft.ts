import { useCallback, useEffect, useRef, useState } from "react";
import type { HostRoutes, ModelProfile, NewTaskInput, Session, SessionOptions, SubsessionSetup, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { defaultProfile, rememberProfile, rememberWorkspace, repick } from "../lib/profiles.js";
import { isHiddenPick, rememberPick, type ModelPick } from "../lib/recents.js";
import { subSessionSetups, withMentionRefs, type MentionPick, type SubSessionSpec } from "../attach/mentions.js";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";
import { activateDraftGoal, draftGoalInput, readPendingGoalStart, savePendingGoalStart, type DraftGoal } from "./goalStart.js";

// The task being written: one draft, shared by the draft task page and the quick bar (Ctrl N), kept across restarts
// so leaving the page never loses it.

export interface TaskDraft {
  /** The task's own name; empty: taken from the first sentence. */
  title: string;
  text: string;
  /** null: no project (the common folder). */
  projectId: string | null;
  topicId: string | null;
  pick: ModelPick;
  /** Effort and permissions; the model comes from `pick`. */
  options: Omit<SessionOptions, "model">;
  /** 主控 (stage 16): the task coordinates its topic (or project). */
  lead?: boolean;
  /** Explicit Goal mode; the first sentence is the native objective. */
  goal?: DraftGoal;
  /**
   * What the「@名字」in the text point at (2026-10-29: projects, tasks, sessions, as in a session's composer); the first
   * message says so (withMentionRefs). Never the task's own project or topic.
   */
  refs?: Record<string, MentionPick>;
}

const KEY = "amo.taskDraft";

export type WorktreeChoice = NonNullable<HostRoutes["POST /api/tasks"]["req"]["worktree"]>;

export function emptyDraft(profiles: readonly ModelProfile[]): TaskDraft {
  return { title: "", text: "", projectId: null, topicId: null, pick: { profileId: defaultProfile(profiles)?.id ?? "", model: null }, options: {} };
}

function load(profiles: readonly ModelProfile[]): TaskDraft {
  const fresh = emptyDraft(profiles);
  try {
    const d = readStoredJson(KEY) as Partial<TaskDraft> | null | undefined;
    if (!d || typeof d !== "object") return fresh;
    const pick = d.pick && profiles.some((p) => p.id === d.pick!.profileId && !p.hidden && !p.unavailable) ? d.pick : fresh.pick;
    return {
      title: typeof d.title === "string" ? d.title : "",
      text: typeof d.text === "string" ? d.text : "",
      projectId: typeof d.projectId === "string" ? d.projectId : null,
      topicId: typeof d.topicId === "string" ? d.topicId : null,
      pick,
      options: d.options && typeof d.options === "object" ? d.options : {},
      ...(d.lead === true ? { lead: true } : {}),
      ...(d.goal && typeof d.goal === "object" ? { goal: { tokenBudget: typeof d.goal.tokenBudget === "string" ? d.goal.tokenBudget : "", roundBudget: typeof d.goal.roundBudget === "string" ? d.goal.roundBudget : "" } } : {}),
      ...(d.refs && typeof d.refs === "object" ? { refs: cleanRefs(d.refs) } : {}),
    };
  } catch {
    return fresh;
  }
}

const isSpec = (v: unknown): v is SubSessionSpec => {
  const o = v as Partial<SubSessionSpec> | null;
  return !!o && typeof o === "object" && typeof o.profileId === "string" && typeof o.model === "string" && typeof o.modelName === "string" && (o.modelId === null || typeof o.modelId === "string");
};

/** Stored picks that still make sense (a project, task or session with its id, or a sub-session setup). */
function cleanRefs(refs: object): Record<string, MentionPick> {
  const out: Record<string, MentionPick> = {};
  for (const [name, p] of Object.entries(refs) as Array<[string, Partial<MentionPick> | null]>) {
    // 开子会话 (2026-11-05: offered on the new-task page too): its setup, as the dialog made it.
    if (p && typeof p === "object" && p.kind === "subsession" && "spec" in p && isSpec(p.spec)) {
      out[name] = { kind: "subsession", spec: p.spec };
      continue;
    }
    if (!p || typeof p !== "object" || !("id" in p) || typeof p.id !== "string") continue;
    if (p.kind === "task") out[name] = { kind: "task", id: p.id };
    else if (p.kind === "session") out[name] = { kind: "session", id: p.id, taskId: typeof p.taskId === "string" ? p.taskId : null };
    else if (p.kind === "project" && typeof p.path === "string") out[name] = { kind: "project", id: p.id, path: p.path };
  }
  return out;
}

/** The first message as sent: the text, then what its「@名字」point at. */
export function draftText(draft: Pick<TaskDraft, "text" | "refs">): string {
  const text = draft.text.trim();
  return draft.refs ? withMentionRefs(text, new Map(Object.entries(draft.refs))) : text;
}

const save = (d: TaskDraft): void => writeStoredJson(KEY, d);

/** The shared draft. `update` merges; switching the model drops an effort or permission the new one may not take. */
export function useTaskDraft(profiles: readonly ModelProfile[], initial?: Partial<TaskDraft>) {
  const isolated = initial !== undefined;
  const [draft, setDraft] = useState<TaskDraft>(() => initial ? { ...emptyDraft(profiles), ...initial } : load(profiles));
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    if (isolated) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setDraft(load(profiles));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [profiles, isolated]);
  // A model hidden in 设置 → 模型 after the draft took it gives way to the default (问题 #14); so does an empty pick
  // once the profiles have loaded.
  const modelHidden = isHiddenPick(draft.pick.profileId, draft.pick.model);
  useEffect(() => {
    const next = repick(profiles, draft.pick.profileId) ?? (modelHidden ? draft.pick.profileId : null);
    if (next === null) return;
    setDraft((cur) => {
      const fixed = { ...cur, pick: { profileId: next, model: null }, options: {} };
      if (!isolated) save(fixed);
      return fixed;
    });
  }, [profiles, draft.pick.profileId, modelHidden, isolated]);
  const update = useCallback((patch: Partial<TaskDraft>) => {
    setDraft((cur) => {
      const next = { ...cur, ...patch };
      if (patch.pick && patch.pick.profileId !== cur.pick.profileId) next.options = {};
      if (!isolated) save(next);
      return next;
    });
  }, [isolated]);
  const reset = useCallback(
    (keep: Partial<TaskDraft> = {}) => {
      const next = { ...emptyDraft(profiles), pick: latest.current.pick, ...keep };
      if (!isolated) save(next);
      setDraft(next);
    },
    [profiles, isolated],
  );
  return { draft, update, reset };
}

/**
 * Creates the task: `file` only files it in 待办 (no session, no model call); otherwise its first session starts.
 * `onCanvas`: a task in a topic also goes on that topic's canvas ("显示在画布上"). `attachments`: uploaded images that go
 * with the first message, or stay with a filed task until its first session starts.
 */
/** `resumeFrom` (接续已有会话, 2026-11-05): the outside Claude session the first session goes on from; the text may be empty then. */
export type CreateTaskFromDraft = (input: NewTaskInput) => Promise<{ task: Task; session: Session | null; existing?: boolean }>;

export async function submitDraft(link: HostLink, draft: TaskDraft, file: boolean, onCanvas = false, attachments: readonly string[] = [], resumeFrom?: string, subsessions?: readonly SubsessionSetup[], goalRuntime?: ModelProfile["runtime"], worktree?: WorktreeChoice, create?: CreateTaskFromDraft): Promise<{ task: Task; session: Session | null }> {
  if ((!create || draft.goal) && readPendingGoalStart()) throw new Error("已有一次 Goal 开启尚未完成，请回到新建任务页重试或进入已建会话。");
  if (draft.lead) throw new Error("请先选择机器人带队。");
  const text = draftText(draft);
  if (draft.goal && (file || resumeFrom || attachments.length)) throw new Error(file ? "Goal 需要直接开始，不能放进待办。" : resumeFrom ? "接续已有会话请在会话内开启 Goal。" : "Goal 直接启动暂不带图片，请关闭 Goal 发送图片，再在会话内开启。");
  const goal = draft.goal ? draftGoalInput(text, draft.goal, goalRuntime) : undefined;
  // 子会话设定 named in the first message (2026-11-05): kept by the Host for the task's first session.
  const setups = subsessions ?? (draft.refs ? subSessionSetups(draft.text, new Map(Object.entries(draft.refs))) : []);
  const options: SessionOptions = { ...draft.options, ...(draft.pick.model ? { model: draft.pick.model } : {}) };
  const request: NewTaskInput = {
    ...(draft.title.trim() ? { title: draft.title.trim() } : file || goal ? { title: text.split("\n")[0]!.slice(0, 60) } : {}),
    workspaceId: draft.projectId,
    topicId: draft.topicId,
    // The native setter may fail after the task exists. Keep the objective visible on that task too.
    ...(goal ? { description: text } : {}),
    ...(worktree ? { worktree } : {}),
    // 放进待办 (2026-11-05): the sentence is kept on the task for its first session; it used to be cut to the title.
    ...(file
      ? { firstMessage: attachments.length ? { text, attachments: [...attachments] } : text }
      : { firstSession: { profileId: draft.pick.profileId, ...(!goal && text ? { text } : {}), ...(Object.keys(options).length ? { options } : {}), ...(attachments.length ? { attachments: [...attachments] } : {}), ...(resumeFrom ? { resumeFrom } : {}), ...(setups.length ? { subsessions: [...setups] } : {}) } }),
  };
  const created = create ? await create(request) : { ...await call(link, "POST /api/tasks", {}, request), existing: false };
  if (created.existing) return created;
  if (goal && created.session) {
    // Persist before activation: an error or a renderer reload must not turn Retry into a duplicate task.
    const pending = { taskId: created.task.id, sessionId: created.session.id, goal, ...(onCanvas && created.task.topicId ? { onCanvas: true } : {}) };
    savePendingGoalStart(pending);
    await activateDraftGoal(link, pending);
  }
  if (!file) {
    rememberProfile(draft.pick.profileId);
    rememberPick(draft.pick);
  }
  if (draft.projectId) rememberWorkspace(draft.projectId);
  if (!goal && onCanvas && created.task.topicId) await call(link, "PUT /api/tasks/:id/canvas", { id: created.task.id }, { onCanvas: true });
  return created;
}

/** An `@名字` (or, in older uses, `#名字`) being typed right before the caret. */
export interface Mention {
  sign: "@" | "#";
  query: string;
  start: number;
  end: number;
}

export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[3]!.length - 1;
  return { sign: m[2] as "@" | "#", query: m[3]!, start, end: caret };
}

/** The text with the mention taken out (and the doubled space it leaves). */
export function withoutMention(text: string, mention: Mention): string {
  return (text.slice(0, mention.start) + text.slice(mention.end)).replace(/ {2,}/g, " ");
}
