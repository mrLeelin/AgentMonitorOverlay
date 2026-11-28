import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BotLeadAppointmentInput, BotLeadOperationReceipt, HostErrorBody, HostEvent, NewTaskInput, PlaneBotApproval, PlaneBotDelivery,
  PlaneBotJob, PlaneBotPlanChoice, RouteRequest, RouteResponse, TaskResult, TaskResultPage, TaskWorkflow, TaskWorkflowSummaryPage, WorktreeIntegrationInput,
} from "./index.js";

describe("Bot lead public protocol", () => {
  it("keeps old task, worker, workflow and Plane payloads valid", () => {
    expectTypeOf<{ lead: true }>().toExtend<NewTaskInput>();
    expectTypeOf<void>().toExtend<RouteRequest<"POST /api/bot-requests/:id/worker">>();
    expectTypeOf<Pick<RouteResponse<"POST /api/bot-requests/:id/worker">, "task" | "session">>()
      .toExtend<RouteResponse<"POST /api/bot-requests/:id/worker">>();
    expectTypeOf<RouteResponse<"GET /api/tasks/:id/workflow">>().toEqualTypeOf<TaskWorkflow>();
    expectTypeOf<Omit<PlaneBotApproval, "execution">>().toExtend<PlaneBotApproval>();
    expectTypeOf<Omit<Extract<PlaneBotJob, { mode?: "independent" }>, "mode">>().toExtend<PlaneBotJob>();
    expectTypeOf<{ error: { code: "conflict"; message: string } }>().toExtend<HostErrorBody>();
  });

  it("carries a versioned term and restricts source variants on the user-facing route", () => {
    type Continue = Extract<BotLeadAppointmentInput, { intent: "continue" }>;
    type Create = Extract<BotLeadAppointmentInput, { intent: "create" }>;
    expectTypeOf<Omit<Continue, "expectedTerm">>().not.toExtend<BotLeadAppointmentInput>();
    expectTypeOf<Omit<Create, "source"> & { source: { kind: "plane"; jobId: string } }>().not.toExtend<BotLeadAppointmentInput>();
    expectTypeOf<Extract<HostEvent, { type: "bot-lead.changed" }>["state"]>()
      .toEqualTypeOf<RouteResponse<"GET /api/tasks/:id/bot-lead">["state"]>();

    const receipt = {
      operationId: "op-1", taskId: "task-1", topicId: "topic-1", action: "create",
      state: { kind: "appointed", term: {
        termId: "term-1", generation: 1, botId: "bot-1", name: "小鲸鱼",
        sessionId: null, state: "active", runState: "pending",
      } },
    } satisfies BotLeadOperationReceipt;
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
    expect(receipt.state.term.sessionId).toBeNull();
  });

  it("addresses worktree integration by checkout and result version before a session exists", () => {
    type WorktreeRequest = RouteRequest<"POST /api/tasks/:id/worktree-integrations">;
    expectTypeOf<WorktreeRequest>().toEqualTypeOf<WorktreeIntegrationInput>();
    expectTypeOf<Omit<WorktreeRequest, "worktreeId"> & { sessionId: string }>().not.toExtend<WorktreeRequest>();
    expectTypeOf<Omit<WorktreeRequest, "prerequisiteResultId">>().not.toExtend<WorktreeRequest>();
  });

  it("keeps root pages lightweight and separates managed Plane evidence from the old worker session", () => {
    expectTypeOf<RouteResponse<"GET /api/tasks/:id/workflow/summary">>().toEqualTypeOf<TaskWorkflowSummaryPage>();
    expectTypeOf<RouteResponse<"GET /api/tasks/:id/workflow/results/:resultId">>().toEqualTypeOf<TaskResultPage>();
    expectTypeOf<Extract<"summary" | "verification" | "worktrees", keyof TaskResultPage["result"]>>().toBeNever();
    expectTypeOf<"worktrees">().toExtend<keyof TaskResult>();
    type Managed = Extract<PlaneBotJob, { mode: "managed" }>;
    expectTypeOf<Managed["taskId"]>().toEqualTypeOf<null>();
    expectTypeOf<NonNullable<Managed["delivery"]>["sessionId"]>().toEqualTypeOf<null>();
    expectTypeOf<PlaneBotDelivery>().not.toExtend<NonNullable<Managed["delivery"]>>();
    expectTypeOf<{ mode: "managed"; operationId: string }>().not.toExtend<NonNullable<PlaneBotApproval["execution"]>>();
    expectTypeOf<{ planHash: string; approve: false; execution: { mode: "independent" } }>().not.toExtend<PlaneBotPlanChoice>();
  });
});
