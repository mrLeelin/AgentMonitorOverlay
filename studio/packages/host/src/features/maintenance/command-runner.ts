import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface CliCommand { file: string; args: string[]; node?: boolean }
export class CliCleanupError extends Error {}
export interface CliCommandRunnerIo {
  start(command: CliCommand, env: NodeJS.ProcessEnv, done: (error: (Error & { code?: string | number | null }) | null, stdout: string, stderr: string) => void): ChildProcess;
  stopTree(child: ChildProcess): Promise<void>;
}

const defaultIo: CliCommandRunnerIo = {
  start(command, env, done) {
    return execFile(command.file, command.args, { env, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }, done);
  },
  stopTree(child) {
    if (!child.pid) return Promise.resolve();
    if (process.platform !== "win32") { child.kill("SIGKILL"); return Promise.resolve(); }
    // Kill the tree while its root still exists: killing npm first loses its installer subprocesses.
    return new Promise((resolve, reject) => execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, (error) => error ? reject(error) : resolve()));
  },
};

export function runCliCommand(command: CliCommand, timeout: number, io: CliCommandRunnerIo = defaultIo): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|AMO_STUDIO_.*|CLAUDE.*|ANTHROPIC_.*|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)$/i.test(key)));
  if (command.node) env.ELECTRON_RUN_AS_NODE = "1";
  return new Promise((resolveRun, reject) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = io.start(command, env, (error, stdout, stderr) => {
      if (timedOut) return;
      clearTimeout(timer);
      // npm errors can contain private registry URLs or tokens; expose the category, never raw output.
      const reason = /EACCES|EPERM|access denied|permission denied|EBUSY|being used by another process/i.test(stderr) ? "文件权限不足或文件被占用，请关闭其他 CLI 窗口后重试。" : /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|CERT_|SELF_SIGNED_CERT/i.test(stderr) ? "下载连接失败，请检查网络、代理与证书后重试。" : "请检查本机安装与文件权限后重试。";
      if (error) reject(new Error(`CLI 命令执行失败（退出码 ${error.code ?? "未知"}），${reason}`));
      else resolveRun(stdout);
    });
    timer = setTimeout(() => {
      timedOut = true;
      void io.stopTree(child).then(
        () => reject(new Error("命令运行超时，已结束本次更新进程，请检查网络和 CLI 安装后重试。")),
        () => reject(new CliCleanupError("命令运行超时，但无法确认本次安装进程已全部结束。为避免重复安装，已停用更新；请关闭残留的安装进程后重新启动 Studio。")),
      );
    }, timeout);
  });
}
