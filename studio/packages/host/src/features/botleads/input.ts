import type { BotInput, BotLeadAppointmentInput, BotLeadTermRef, BotLeadUserSource, Id } from "@amo-studio/protocol";
import { TASK_DESCRIPTION_MAX, TASK_FIRST_MESSAGE_MAX } from "@amo-studio/protocol";
import { boundedText, HostError } from "../../core/shared.js";
import { obj } from "../../http/route.js";

const id = (value: unknown, field: string): Id => boundedText(value, field, 200);
const optionalText = (value: unknown, field: string, max: number): string | undefined => value === undefined ? undefined : boundedText(value, field, max);

function userSource(value: unknown): BotLeadUserSource {
  const source = obj(value);
  switch (source.kind) {
    case "manual": return { kind: "manual" };
    case "bot-request": return { kind: "bot-request", requestId: id(source.requestId, "requestId") };
    case "user-message": return { kind: "user-message", sessionId: id(source.sessionId, "sessionId"), messageId: id(source.messageId, "messageId") };
    default: throw new HostError("bad_request", "请选择本机用户操作的有效来源。");
  }
}

function termRef(value: unknown): BotLeadTermRef {
  const ref = obj(value);
  if (typeof ref.generation !== "number" || !Number.isSafeInteger(ref.generation) || ref.generation < 1) throw new HostError("bad_request", "请选择当前主控任期。");
  return { termId: id(ref.termId, "termId"), generation: ref.generation };
}

function botChoice(body: Record<string, unknown>) {
  if (body.botId !== undefined && body.newBot === undefined) return { botId: id(body.botId, "botId") };
  if (body.botId === undefined && body.newBot && typeof body.newBot === "object" && !Array.isArray(body.newBot)) return { newBot: body.newBot as BotInput };
  throw new HostError("bad_request", "请选择一个现有机器人或填写新机器人配置。");
}

export function appointmentInput(value: unknown): BotLeadAppointmentInput {
  const body = obj(value);
  const base = { operationId: id(body.operationId, "operationId"), source: userSource(body.source) };
  switch (body.intent) {
    case "create": {
      const topic = obj(body.topic);
      if ((topic.topicId === undefined) === (topic.topicTitle === undefined)) throw new HostError("bad_request", "请选择已有专题或填写新专题标题。");
      if (body.sourceUse !== undefined && body.sourceUse !== "initial" && body.sourceUse !== "new-goal") throw new HostError("bad_request", "请选择首次承接或独立目标。");
      if (body.start !== undefined && typeof body.start !== "boolean") throw new HostError("bad_request", "请选择现在开始或放进待办。");
      return { ...base, ...botChoice(body), intent: "create", workspaceId: id(body.workspaceId, "workspaceId"), title: boundedText(body.title, "任务目标", 200),
        description: optionalText(body.description, "任务说明", TASK_DESCRIPTION_MAX), firstMessage: optionalText(body.firstMessage, "初始消息", TASK_FIRST_MESSAGE_MAX),
        sourceUse: body.sourceUse ?? "initial", ...(body.start === false ? { start: false } : {}), topic: topic.topicId === undefined ? { topicTitle: boundedText(topic.topicTitle, "专题标题", 100) } : { topicId: id(topic.topicId, "topicId") } };
    }
    case "continue": {
      if (body.purpose !== "work" && body.purpose !== "reopen") throw new HostError("bad_request", "请选择追加工作或重新开工。");
      return { ...base, intent: "continue", taskId: id(body.taskId, "taskId"), expectedTerm: termRef(body.expectedTerm), purpose: body.purpose, text: boundedText(body.text, "追加工作", 20_000) };
    }
    case "upgrade": {
      if (body.expectedTerm !== null) throw new HostError("bad_request", "升级普通任务的预期任期必须为空。");
      return { ...base, ...botChoice(body), intent: "upgrade", taskId: id(body.taskId, "taskId"), expectedTerm: null, summary: boundedText(body.summary, "交接摘要", 20_000),
        topicTitle: optionalText(body.topicTitle, "专题标题", 100) };
    }
    default: throw new HostError("bad_request", "请选择新建、接续或升级主控任务。");
  }
}

export function controlInput(value: unknown) {
  const body = obj(value);
  const operationId = id(body.operationId, "operationId");
  switch (body.action) {
    case "cancel-handoff":
      return { operationId, action: body.action, handoffOperationId: id(body.handoffOperationId, "handoffOperationId"), expectedTerm: body.expectedTerm === null ? null : termRef(body.expectedTerm) } as const;
    case "pause":
    case "resume":
    case "retry-start":
      return { operationId, action: body.action, expectedTerm: termRef(body.expectedTerm) };
    case "replace":
      return { operationId, action: body.action, ...botChoice(body), expectedTerm: termRef(body.expectedTerm), summary: optionalText(body.summary, "交接摘要", 20_000) } as const;
    default:
      throw new HostError("bad_request", "请选择要执行的主控操作。");
  }
}
