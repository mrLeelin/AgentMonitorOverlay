import { describe, expect, expectTypeOf, it } from "vitest";
import { projectTaskContextHint, type TaskContextHint, type TaskContextHintEvidence } from "./shared-context.js";
import type { HostEvent, StateSnapshot, Task } from "./index.js";

const binding = { id: "requirement", taskId: "task", contextId: "context", version: 2 };
const adopted = { requirementId: binding.id, taskId: binding.taskId, contextId: binding.contextId, version: binding.version, adoptedAt: "2026-11-28T02:00:00Z" };

describe("task context hint projection", () => {
  it("uses the same additive field in the batch snapshot and task upserts", () => {
    type Hint = TaskContextHint | null | undefined;
    expectTypeOf<StateSnapshot["tasks"][number]["contextHint"]>().toEqualTypeOf<Hint>();
    expectTypeOf<Extract<HostEvent, { type: "task.upserted" }>["task"]["contextHint"]>().toEqualTypeOf<Hint>();
    expectTypeOf<Omit<Task, "contextHint">>().toExtend<Task>();
  });

  it("returns no hint for an unbound task, and prioritizes invalid ownership over previous adoption", () => {
    expect(projectTaskContextHint({ binding: null, validBinding: false, receipts: [adopted] })).toBeNull();
    expect(projectTaskContextHint({ binding, validBinding: false, receipts: [adopted] })).toEqual({ kind: "invalid-binding" });
  });

  it("requires adoption of the exact binding and version", () => {
    const receipts = [
      { ...adopted, requirementId: "older-binding" },
      { ...adopted, taskId: "other-task" },
      { ...adopted, contextId: "other-context" },
      { ...adopted, version: 1 },
      { ...adopted, adoptedAt: undefined, queuedAt: adopted.adoptedAt, deliveredAt: adopted.adoptedAt },
    ];
    const evidence: TaskContextHintEvidence = { binding, validBinding: true, receipts };
    expect(projectTaskContextHint(evidence)).toEqual({ kind: "awaiting-adoption", version: 2 });
    expect(projectTaskContextHint({ ...evidence, receipts: [...receipts, adopted] })).toBeNull();
  });
});
