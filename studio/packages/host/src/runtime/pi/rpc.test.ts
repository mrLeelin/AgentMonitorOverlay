import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRpc } from "./rpc.js";

const AGENT = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
const reply = (request, data) => process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data }) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (request.type === "echo") setTimeout(() => reply(request, { text: request.message, env: process.env.PI_RPC_TEST }), request.delay || 0);
    else if (request.type === "fail") process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: false, error: "command rejected" }) + "\n");
    else if (request.type === "event") {
      process.stderr.write("api-key-private-should-never-log\n");
      process.stdout.write("invalid-private-output\nnull\n[]\n");
      const bytes = Buffer.from(JSON.stringify({ type: "message_update", text: "中文😀\u2028second\u2029third" }) + "\r\n");
      const split = bytes.indexOf(Buffer.from("😀")) + 2;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => { process.stdout.write(bytes.subarray(split)); reply(request, {}); }, 10);
    } else if (request.type === "exit") process.exit(7);
    else if (request.type === "extension_ui_response") process.stdout.write(JSON.stringify({ type: "extension_reply_seen", value: request.value, id: request.id }) + "\n");
  }
});
`;

describe("PiRpc", () => {
  let dir: string;
  let script: string;
  const connections: PiRpc[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amo-studio-test-pi-rpc-"));
    script = join(dir, "agent.mjs");
    writeFileSync(script, AGENT, "utf8");
  });
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((rpc) => rpc.close(200)));
    rmSync(dir, { recursive: true, force: true });
  });
  function connect(command = process.execPath, args = [script]) {
    const rpc = new PiRpc({ command, args, env: { PI_RPC_TEST: "command-env" } }, dir, { ...process.env, PI_RPC_TEST: "base-env" });
    connections.push(rpc);
    return rpc;
  }

  it("correlates concurrent responses by ID and keeps command environment overrides", async () => {
    const rpc = connect();
    const slow = rpc.request("echo", { message: "first", delay: 50 });
    const fast = rpc.request("echo", { message: "second" });
    expect(await fast).toEqual({ text: "second", env: "command-env" });
    expect(await slow).toEqual({ text: "first", env: "command-env" });
  });

  it("decodes fragmented UTF-8 and CRLF without splitting Unicode separators or logging diagnostics", async () => {
    const rpc = connect();
    const events: Record<string, unknown>[] = [];
    const logs: string[] = [];
    rpc.on("event", (record) => events.push(record));
    rpc.on("log", (message) => logs.push(message));
    await rpc.request("event");
    expect(events).toEqual([{ type: "message_update", text: "中文😀\u2028second\u2029third" }]);
    expect(logs).toHaveLength(3);
    expect(logs.join(" ")).not.toContain("private");
  });

  it("sends extension replies without creating a pending RPC request", async () => {
    const rpc = connect();
    const event = new Promise<Record<string, unknown>>((resolve) => rpc.once("event", resolve));
    rpc.notify({ type: "extension_ui_response", id: "dialog-1", value: "选择" });
    expect(await event).toEqual({ type: "extension_reply_seen", id: "dialog-1", value: "选择" });
  });

  it("rejects command failures and deadlines while allowing later requests", async () => {
    const rpc = connect();
    await expect(rpc.request("fail")).rejects.toThrow("command rejected");
    await expect(rpc.request("hang", {}, 20)).rejects.toThrow("没有回应 hang");
    expect(await rpc.request("echo", { message: "after deadline" })).toMatchObject({ text: "after deadline" });
  });

  it("rejects all pending requests on unexpected exit and emits exit once", async () => {
    const rpc = connect();
    const exits: Error[] = [];
    rpc.on("exit", (error) => exits.push(error));
    const pending = expect(rpc.request("hang", {}, 0)).rejects.toThrow("Pi 进程已退出");
    const exiting = expect(rpc.request("exit")).rejects.toThrow("Pi 进程已退出");
    await Promise.all([pending, exiting]);
    await rpc.exited;
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toContain("7");
    expect(rpc.alive).toBe(false);
    await expect(rpc.request("echo")).rejects.toThrow("Pi 进程已退出");
  });

  it("reports startup failure without exposing the command or its environment", async () => {
    const rpc = connect(join(dir, "missing-private-executable"), []);
    await expect(rpc.request("get_state")).rejects.toThrow("无法启动 Pi");
    await rpc.exited;
    expect(rpc.alive).toBe(false);
  });

  it("closes once, rejects pending work, and refuses writes after close", async () => {
    const rpc = connect();
    await rpc.request("echo");
    const pending = expect(rpc.request("hang", {}, 0)).rejects.toThrow("正在关闭");
    const closing = rpc.close();
    expect(rpc.close()).toBe(closing);
    await Promise.all([pending, closing]);
    expect(rpc.alive).toBe(false);
    expect(() => rpc.notify({ type: "extension_ui_response" })).toThrow("Pi");
    await expect(rpc.request("get_state")).rejects.toThrow("Pi");
  });

  it("kills a process that does not close on stdin EOF", async () => {
    writeFileSync(script, `${AGENT}\nsetInterval(() => {}, 1000);`, "utf8");
    const rpc = connect();
    await rpc.request("echo");
    await rpc.close(30);
    expect(rpc.alive).toBe(false);
  });
});
