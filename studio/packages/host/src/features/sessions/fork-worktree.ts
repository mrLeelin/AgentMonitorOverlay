import { mkdtemp, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { HostError } from "../../core/shared.js";
import { git, GitError } from "../gitreview/git.js";
import type { SessionForkOptions } from "@amo-studio/protocol";

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

/** The user chose a new checkout. Resolve the branch to a commit and leave the source checkout and refs alone. */
export async function createForkWorktree(cwd: string, projectDir: string, branch: string | undefined) {
  const options = await forkGitOptions(cwd);
  if (!options?.head) throw new HostError("conflict", "这个目录没有可用于新建工作树的 Git 提交。");
  if (branch !== undefined && !options.branches.includes(branch)) throw new HostError("conflict", "所选本地分支已不存在，请重新选择。");
  const [sourceRoot, projectRoot, commit] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(projectDir, ["rev-parse", "--show-toplevel"]),
    branch === undefined ? options.head : git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]),
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
      throw new HostError("conflict", "所选分支没有当前项目的子目录，请选另一个分支。");
    }
    return { cwd: target, remove };
  } catch (err) {
    // Git refuses to remove a dirty checkout. Never force cleanup or discard files left by another process.
    await remove().catch(() => rmdir(dir).catch(() => undefined));
    throw err;
  }
}

const isWithin = (path: string) => !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
