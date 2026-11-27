import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "@amo-studio/testkit";
import { afterEach, expect, it } from "vitest";
import { createForkWorktree, forkGitOptions } from "./fork-worktree.js";

let root: string | undefined;
afterEach(() => { if (root) removeTempDir(root); root = undefined; });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=AMO test", "-c", "user.email=amo@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, windowsHide: true, encoding: "utf8" }).trim();

it("rejects a vanished branch and cleans up a checkout whose project directory is missing", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-fork-worktree-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  expect(await forkGitOptions(repo)).toBeNull();
  git(repo, "init", "-qb", "main");
  git(repo, "commit", "--allow-empty", "-qm", "no game project yet");
  git(repo, "branch", "without-game");
  const project = join(repo, "Game");
  mkdirSync(project);
  writeFileSync(join(project, "project.txt"), "project");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "new game project");
  const originalWorktrees = git(repo, "worktree", "list", "--porcelain");

  await expect(createForkWorktree(project, project, "deleted-branch")).rejects.toThrow("所选本地分支已不存在");
  await expect(createForkWorktree(project, project, "without-game")).rejects.toThrow("所选分支没有当前项目的子目录");
  expect(git(repo, "worktree", "list", "--porcelain")).toBe(originalWorktrees);
  expect(git(repo, "branch", "--show-current")).toBe("main");
});

it("checks out the pinned commit and rejects a missing commit or a non-commit object", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-fork-worktree-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-qb", "main");
  git(repo, "commit", "--allow-empty", "-qm", "approved baseline");
  const baseline = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "--allow-empty", "-qm", "new project commit");
  const head = git(repo, "rev-parse", "HEAD");
  const originalWorktrees = git(repo, "worktree", "list", "--porcelain");

  const fork = await createForkWorktree(repo, repo, undefined, baseline);
  try {
    expect(git(fork.cwd, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  } finally {
    await fork.remove();
  }

  await expect(createForkWorktree(repo, repo, undefined, "0".repeat(head.length))).rejects.toMatchObject({ code: "conflict" });
  await expect(createForkWorktree(repo, repo, undefined, git(repo, "rev-parse", "HEAD^{tree}"))).rejects.toMatchObject({ code: "conflict" });
  await expect(createForkWorktree(repo, repo, undefined, "HEAD")).rejects.toMatchObject({ code: "bad_request" });
  expect(git(repo, "worktree", "list", "--porcelain")).toBe(originalWorktrees);
});
