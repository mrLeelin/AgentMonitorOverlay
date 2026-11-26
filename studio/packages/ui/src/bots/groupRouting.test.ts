import { expect, it } from "vitest";
import type { StudioBot } from "@amo-studio/protocol";
import { groupReplyTargets } from "./groupRouting.js";

const bot = (id: string, name: string, enabled = true): StudioBot => ({
  id, name, enabled, profileId: "mock", workspaceId: null, taskId: null, homeSessionId: null, purpose: "", memory: "",
});
const members = [bot("a", "审核员"), bot("b", "审核员2"), bot("c", "Build Bot"), bot("d", "已暂停", false)];

it("uses the reply preference for plain messages", () => {
  expect(groupReplyTargets("请检查日志。", members, "bot:b")).toEqual(["b"]);
  expect(groupReplyTargets("请检查日志。", members, "all")).toEqual(["a", "b", "c"]);
  expect(groupReplyTargets("今天先记下来。", members, "mentions")).toEqual([]);
});

it("routes mentions to whole member names, even when they contain spaces or share a prefix", () => {
  expect(groupReplyTargets("给你：＠审核员２ @BUILD BOT。", members, "bot:a")).toEqual(["b", "c"]);
  expect(groupReplyTargets("（@审核员） @审核员。", members, "mentions")).toEqual(["a"]);
  expect(groupReplyTargets("x@审核员 @审核员2号", members, "mentions")).toEqual([]);
});

it("routes everyone to the enabled members and skips a named paused member without falling back", () => {
  expect(groupReplyTargets("@EVERYONE 查一下。", members, "mentions")).toEqual(["a", "b", "c"]);
  expect(groupReplyTargets("@已暂停", members, "bot:a")).toEqual([]);
  expect(groupReplyTargets("回复", members, "bot:d")).toEqual([]);
});
