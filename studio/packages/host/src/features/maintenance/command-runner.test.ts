import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliCleanupError, runCliCommand, type CliCommandRunnerIo } from "./command-runner.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("CLI command timeout", () => {
  it("keeps the command pending until its own process tree is cleaned, even when the parent exits first", async () => {
    vi.useFakeTimers();
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 24680 });
    let done: Parameters<CliCommandRunnerIo["start"]>[2] | undefined;
    let finishCleanup: (() => void) | undefined;
    const io: CliCommandRunnerIo = {
      start: vi.fn((_command, _env, callback) => { done = callback; return child; }),
      stopTree: vi.fn(async () => new Promise<void>((resolve) => { finishCleanup = resolve; })),
    };
    let settled = false;
    const outcome = runCliCommand({ file: "npm", args: ["install"] }, 100, io).catch((error) => { settled = true; return error as Error; });
    await vi.advanceTimersByTimeAsync(100);
    expect(io.stopTree).toHaveBeenCalledExactlyOnceWith(child);
    done!(new Error("parent ended"), "", "");
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCleanup!();
    expect(await outcome).toMatchObject({ message: expect.stringContaining("已结束本次更新进程") });
  });

  it("reports unconfirmed cleanup distinctly so the caller can prevent overlapping installs", async () => {
    vi.useFakeTimers();
    const io: CliCommandRunnerIo = { start: vi.fn(() => new ChildProcess()), stopTree: vi.fn(async () => { throw new Error("taskkill failed"); }) };
    const outcome = runCliCommand({ file: "npm", args: ["install"] }, 100, io).catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(CliCleanupError);
  });

  it("cancels the timer after normal completion and hides sensitive installer stderr", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ANTHROPIC_API_KEY", "private-key");
    let done: Parameters<CliCommandRunnerIo["start"]>[2] | undefined;
    const io: CliCommandRunnerIo = { start: vi.fn((_command, env, callback) => { expect(env.ANTHROPIC_API_KEY).toBeUndefined(); done = callback; return new ChildProcess(); }), stopTree: vi.fn() };
    const outcome = runCliCommand({ file: "node", args: ["npm-cli.js"], node: true }, 100, io).catch((error) => error as Error);
    done!(Object.assign(new Error("failure"), { code: 1 }), "", "EPERM registry token=private-key");
    const error = await outcome as Error;
    expect(error.message).toContain("文件权限不足");
    expect(error.message).not.toContain("private-key");
    await vi.advanceTimersByTimeAsync(200);
    expect(io.stopTree).not.toHaveBeenCalled();
  });
});
