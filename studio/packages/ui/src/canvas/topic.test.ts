import { describe, expect, it } from "vitest";
import type { Task, Topic, Workspace } from "@amo-studio/protocol";
import { canvasTopicFor } from "./topic.js";

const topic = (id: string, workspaceIds: string[] = [], archivedAt: string | null = null): Topic => ({ id, title: id, workspaceIds, archivedAt, createdAt: "", updatedAt: "" });
const workspaces: Workspace[] = ["a", "b"].map((id) => ({ id, name: id, path: id, createdAt: "" }));
const state = (topics: Topic[], tasks: Task[] = []) => ({ topics, tasks, workspaces });

describe("canvas topic for the current scope", () => {
  it("prefers a project's matching topic, keeping the existing order among multiple matches", () => {
    const data = state([topic("first", ["a"]), topic("match", ["a", "b"]), topic("also", ["b"])]);
    expect(canvasTopicFor({ kind: "workspace", id: "b" }, data)?.id).toBe("match");
    expect(canvasTopicFor({ kind: "topic", id: "also" }, data)?.id).toBe("also");
  });

  it("includes projects shown as common through live tasks, but ignores archived tasks", () => {
    const task: Task = { id: "t", title: "t", topicId: "match", workspaceId: "b", column: "todo", createdAt: "", updatedAt: "", archivedAt: null };
    const data = state([topic("first"), topic("match")], [task]);
    expect(canvasTopicFor({ kind: "workspace", id: "b" }, data)?.id).toBe("match");
    expect(canvasTopicFor({ kind: "workspace", id: "b" }, { ...data, tasks: [{ ...task, archivedAt: "archived" }] })?.id).toBe("first");
  });

  it("skips archived topics and falls back when there is no project match or explicit live topic", () => {
    const data = state([topic("archived", ["b"], "archived"), topic("first", ["a"])]);
    expect(canvasTopicFor({ kind: "workspace", id: "b" }, data)?.id).toBe("first");
    expect(canvasTopicFor({ kind: "topic", id: "archived" }, data)?.id).toBe("first");
    expect(canvasTopicFor({ kind: "all" }, data)?.id).toBe("first");
  });

  it("has no canvas when there are no live topics", () => {
    expect(canvasTopicFor({ kind: "workspace", id: "b" }, state([]))).toBeUndefined();
    expect(canvasTopicFor({ kind: "all" }, state([topic("archived", [], "archived")]))).toBeUndefined();
  });
});
