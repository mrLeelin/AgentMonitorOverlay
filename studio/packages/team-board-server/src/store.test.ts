import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TeamBoardStore } from "./store.js";

it("shares tickets, serializes claims, preserves assignee on return and persists review notices and files", () => {
  const dir = mkdtempSync(join(tmpdir(), "amo-board-"));
  const path = join(dir, "board.sqlite");
  let store = new TeamBoardStore(path);
  try {
    const names = ["陈楠", "林舟", "周遥"];
    const input = { requestId: "once", title: "黑屏", description: "验证结算", assignee: names[2], files: [{ name: "test.txt", base64: "bG9n" }] };
    const ticket = store.create(names[0]!, input, names);
    expect(store.create(names[0]!, input, names).id).toBe(ticket.id);
    expect(store.snapshot(names[1]!).tickets).toMatchObject([{ id: ticket.id, assignee: names[2], status: "pending" }]);
    const take = store.claim(names[1]!, ticket.id, ticket.revision);
    expect(take.ticket).toMatchObject({ status: "doing", assignee: names[1] });
    expect(() => store.claim(names[2]!, ticket.id, ticket.revision)).toThrow("当前执行者");
    expect(() => store.change(names[2]!, ticket.id, { action: "deliver", revision: take.ticket.revision })).toThrow("当前身份");
    store.release(names[1]!, ticket.id, take.claimId);
    const released = store.detail(ticket.id);
    expect(released).toMatchObject({ status: "pending", assignee: names[2] });
    const claimed = store.claim(names[1]!, ticket.id, released.revision).ticket;
    const review = store.change(names[1]!, ticket.id, { action: "deliver", revision: claimed.revision });
    expect(store.snapshot(names[0]!).notices).toMatchObject([{ ticketId: ticket.id, unread: true }]);
    expect(store.snapshot(names[1]!).notices).toEqual([]);
    store.close();
    store = new TeamBoardStore(path);
    expect(store.snapshot(names[0]!).notices).toMatchObject([{ ticketId: ticket.id, unread: true }]);
    expect(Buffer.from(store.file(ticket.id, ticket.events[0]!.files[0]!.id).bytes).toString()).toBe("log");
    store.readNotice(names[0]!, ticket.id);
    expect(store.snapshot(names[0]!).notices[0]?.unread).toBe(false);
    expect(() => store.change(names[1]!, ticket.id, { action: "return", revision: review.revision })).toThrow("当前身份");
    const returned = store.change(names[0]!, ticket.id, { action: "return", revision: review.revision, text: "补断网测试" });
    expect(returned).toMatchObject({ status: "pending", assignee: names[1] });
    expect(returned.events.at(-1)?.text).toBe("补断网测试");
    expect(store.claim(names[2]!, ticket.id, returned.revision).ticket.assignee).toBe(names[2]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
