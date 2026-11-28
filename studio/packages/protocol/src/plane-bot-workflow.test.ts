import { afterEach, expect, it, vi } from "vitest";
import { PLANE_BOARD_API, TeamBoardClient } from "./team-board.js";

const client = new TeamBoardClient("https://plane.test", "fixture-token", `${PLANE_BOARD_API}/workspaces/demo/projects/project`, true);
const endpoint = `${client.source}/work-items/item`;

afterEach(() => { vi.unstubAllGlobals(); });

it("keeps the account and delivery identity across the three Plane Bot operations", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ id: "item" }))
    .mockResolvedValueOnce(Response.json({ id: "delivery-comment" }))
    .mockResolvedValueOnce(Response.json({ status: "confirmed", commentId: "creator-comment" }))
    .mockResolvedValueOnce(Response.json({ id: "item" }));
  vi.stubGlobal("fetch", fetch);
  await client.startBotItem("item", "owner");
  await expect(client.finishBotItem("item", "owner", "result-1", "摘要")).resolves.toBe("delivery-comment");
  await expect(client.botFeedback("item", "owner", "result-1")).resolves.toEqual({ status: "confirmed", commentId: "creator-comment" });
  await client.startBotItem("item", "owner", "result-1");
  expect(fetch.mock.calls.map(([url, options]) => [url, options?.method, JSON.parse(String(options?.body))])).toEqual([
    [endpoint, "POST", { action: "bot-start", viewerId: "owner" }],
    [endpoint, "POST", { action: "bot-finish", viewerId: "owner", resultId: "result-1", text: "摘要" }],
    [endpoint, "POST", { action: "bot-feedback", viewerId: "owner", resultId: "result-1" }],
    [endpoint, "POST", { action: "bot-start", viewerId: "owner", resultId: "result-1" }],
  ]);
});

it("reports an outdated Plane API and rejects unverified creator confirmation", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ message: "不支持的工作项操作" }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ status: "confirmed" }))
    .mockResolvedValueOnce(Response.json({ status: "waiting" }));
  vi.stubGlobal("fetch", fetch);
  await expect(client.finishBotItem("item", "owner", "result-1", "摘要")).rejects.toThrow("更新团队任务接口");
  await expect(client.botFeedback("item", "owner", "result-1")).rejects.toThrow("发起人验收回执");
  await expect(client.botFeedback("item", "owner", "result-1")).resolves.toEqual({ status: "waiting" });
  expect(fetch).toHaveBeenCalledTimes(3);
});
