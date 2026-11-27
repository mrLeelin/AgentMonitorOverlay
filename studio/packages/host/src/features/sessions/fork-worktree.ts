import { mkdtemp, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { HostError } from "../../core/shared.js";
import { git, GitError, resolveCommit } from "../gitreview/git.js";
import { isObjectId, type SessionForkOptions } from "@amo-studio/protocol";

export async function forkGitOptions(cwd: string): Promise<SessionForkOptions["git"]> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch((err: unknown) => {
    if (err instanceof GitError && (err.kind === "failed" || err.kind === "missing")) return "";
    throw err;
  });
  if (inside.trim() !== "true") return null;
  const [branch, head, branches] = await Promise.all([
    git(cwd, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
    git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => ""),
    git(cwd, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"]),
  ]);
  return { branch: branch.trim().replace(/^refs\/heads\//, "") || null, head: head.trim() || null, branches: branches.trim().split(/\r?\n/).filter(Boolean) };
}

async function worktreeCommit(cwd: string, branch: string | undefined, pinnedCommit?: string): Promise<string> {
  if (pinnedCommit !== undefined) {
    if (!isObjectId(pinnedCommit)) throw new HostError("bad_request", "工作树基准必须是完整的 Git 提交编号。");
    const resolved = await resolveCommit(cwd, pinnedCommit).catch((err: unknown) => {
      if (err instanceof GitError && err.kind === "failed") return null;
      throw err;
    });
    if (resolved !== pinnedCommit) throw new HostError("conflict", "工作树的基准提交已不可用。");
    return pinnedCommit;
  }
  const options = await forkGitOptions(cwd);
  if (!options?.head) throw new HostError("conflict", "这个目录没有可用于新建工作树的 Git 提交。");
  if (branch !== undefined && !options.branches.includes(branch)) throw new HostError("conflict", "所选本地分支已不存在，请重新选择。");
  return branch === undefined ? options.head : git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

/** An approved baseline must stay fixed even if the project moves to a new commit. */
export async function createForkWorktree(cwd: string, projectDir: string, branch: string | undefined, pinnedCommit?: string) {
  const commit = await worktreeCommit(cwd, branch, pinnedCommit);
  const [sourceRoot, projectRoot] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(projectDir, ["rev-parse", "--show-toplevel"]),
  ]);
  const root = projectRoot.trim();
  const within = relative(await realpath(sourceRoot.trim()), await realpath(cwd));
  if (!isWithin(within)) throw new HostError("conflict", "会话目录不在 Git 工作树下。");
  // Keep the checkout beside the project, even when the Studio data directory is inside that project.
  const dir = await mkdtemp(join(dirname(root), `${basename(root)}-amo-`));
  const worktree = join(dir, "worktree");
  const target = join(worktree, within);
  const remove = async () => {
    await git(cwd, ["worktree", "remove", "--", worktree]);
    await rmdir(dir);
  };
  try {
    await git(cwd, ["worktree", "add", "--detach", "--", worktree, commit.trim()], undefined, 180_000);
    const resolved = await realpath(target).catch(() => null);
    if (!resolved || !isWithin(relative(await realpath(worktree), resolved)) || !(await stat(resolved)).isDirectory()) {
      throw new HostError("conflict", pinnedCommit === undefined ? "所选分支没有当前项目的子目录，请选另一个分支。" : "基准提交没有当前项目的子目录。");
    }
    return { cwd: target, remove };
  } catch (err) {
    // Git refuses to remove a dirty checkout. Never force cleanup or discard files left by another process.
    await remove().catch(() => rmdir(dir).catch(() => undefined));
    throw err;
  }
}

const isWithin = (path: string) => !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
