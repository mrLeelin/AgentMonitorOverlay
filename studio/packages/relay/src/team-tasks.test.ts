import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RelayStore } from "./store.js";
import { TeamTasksStore } from "./team-tasks.js";

it("isolates team task files, deduplicates creates, and rejects stale or unauthorized transitions", () => {
  const filesDir = mkdtempSync(join(tmpdir(), "amo-team-tasks-"));
  const relay = new RelayStore(":memory:");
  try {
    for (const name of ["提单人", "接收人", "旁观者"]) relay.register(name, "team-task-test");
    const tasks = new TeamTasksStore(relay, filesDir);
    const input = { requestId: "retry-1", title: "排查黑屏", description: "打开结算页", assignee: "接收人", files: [{ name: "复现.txt", base64: Buffer.from("log").toString("base64") }] };
    const ticket = tasks.create("提单人", input);
    expect(tasks.create("提单人", input)).toEqual(ticket);
    expect(readdirSync(join(filesDir, "team-tasks"))).toHaveLength(1);
    expect(relay.tasksFor("旁观者")).toEqual([]);
    expect(tasks.list("旁观者")).toEqual([]);
    const file = ticket.events[0]!.files[0]!;
    expect(() => tasks.file("旁观者", ticket.id, file.id)).toThrow("找不到这张团队任务");
    const other = tasks.create("提单人", { ...input, requestId: "retry-2", files: [] });
    expect(() => tasks.file("接收人", other.id, file.id)).toThrow("找不到这份附件");
    expect(readFileSync(tasks.file("接收人", ticket.id, file.id).path, "utf8")).toBe("log");

    const start = { action: "start", revision: ticket.revision };
    expect(() => tasks.change("提单人", ticket.id, start)).toThrow("当前账号不能执行这个动作");
    const doing = tasks.change("接收人", ticket.id, start);
    expect(tasks.change("接收人", ticket.id, start)).toEqual(doing);
    expect(() => tasks.change("接收人", ticket.id, { action: "deliver", revision: ticket.revision, text: "验证通过", files: input.files })).toThrow("原单已有更新");
    expect(readdirSync(join(filesDir, "team-tasks"))).toHaveLength(1);
    expect(() => tasks.change("接收人", ticket.id, { action: "deliver", revision: doing.revision, text: "验证通过", files: [{ name: "../bad.txt", base64: "bG9n" }] })).toThrow("附件文件名无效");
    expect(tasks.detail("接收人", ticket.id)).toEqual(doing);

    relay.renameMember("接收人", "新接收人");
    expect(tasks.list("接收人")).toEqual([]);
    expect(tasks.detail("新接收人", ticket.id)).toMatchObject({ assignee: "新接收人", events: [{ actor: "提单人" }, { actor: "新接收人" }] });
    const review = tasks.change("新接收人", ticket.id, { action: "deliver", revision: doing.revision, text: "验证通过" });
    expect(() => tasks.change("新接收人", ticket.id, { action: "accept", revision: review.revision })).toThrow("当前账号不能执行这个动作");
    expect(tasks.change("提单人", ticket.id, { action: "accept", revision: review.revision }).status).toBe("done");
  } finally {
    relay.close();
    rmSync(filesDir, { force: true, recursive: true });
  }
});
