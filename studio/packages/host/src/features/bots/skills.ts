import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { BOT_SKILL_LIMIT, type BotSkillCatalog, type BotSkillChoice, type BotSkillRef, type ModelProfile, type Workspace } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import type { SessionRuntimeApi } from "../../runtime/runtime.js";
import type { Store } from "../../store/store.js";
import { scanSkillSource } from "../cli/skill-catalog.js";

const SHARED_SKILLS_KEY = "bots.sharedSkills";
const caseKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const key = (...parts: string[]) => JSON.stringify(parts);
const runtimeLabel = { codex: "Codex", claude: "Claude Code", dsh: "DSH" } as Record<string, string>;

export function botSkillRefs(raw: unknown, shared = false): BotSkillRef[] {
  if (!Array.isArray(raw) || raw.length > BOT_SKILL_LIMIT) throw new HostError("bad_request", `最多可设置 ${BOT_SKILL_LIMIT} 个技能。`);
  const skills = new Map<string, BotSkillRef>();
  for (const ref of raw) {
    if (!ref || typeof ref.id !== "string" || !ref.id || ref.id.length > 4096 ||
        typeof ref.name !== "string" || !ref.name || ref.name.length > 400 ||
        typeof ref.label !== "string" || !ref.label || ref.label.length > 400 ||
        !["global", "project", "plugin"].includes(ref.source) || (shared && ref.source !== "global")) {
      throw new HostError("bad_request", "请选择有效的技能。");
    }
    skills.set(ref.id, { id: ref.id, name: ref.name, label: ref.label, source: ref.source });
  }
  return [...skills.values()];
}

export function sharedBotSkills(store: Store): BotSkillRef[] {
  const value = store.getKv(SHARED_SKILLS_KEY)?.value;
  return value ? JSON.parse(value) as BotSkillRef[] : [];
}

export function saveSharedBotSkills(store: Store, skills: BotSkillRef[]): void {
  store.setKv(SHARED_SKILLS_KEY, JSON.stringify(skills));
}

function under(root: string, path: string): string | undefined {
  const part = relative(root, path);
  return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part) ? part : undefined;
}

function cachedPluginId(root: string, path: string): string | undefined {
  const parts = under(root, path)?.split(sep);
  return parts && parts.length >= 4 ? `${parts[1]}@${parts[0]}` : undefined;
}

function pluginChoice(runtime: string, pluginId: string, skill: { name: string; description: string; path: string }, unavailable?: string): BotSkillChoice {
  const pluginName = pluginId.split("@")[0]!;
  const prefix = `${pluginName}:`;
  const name = skill.name.startsWith(prefix) ? skill.name.slice(prefix.length) : skill.name;
  return { id: key("plugin", runtime, pluginId, name), name, source: "plugin", label: `${pluginName} · ${runtimeLabel[runtime]}`,
    description: skill.description, path: skill.path, ...(unavailable ? { unavailable } : {}) };
}

async function portableSkills(root: string, workspaceId?: string): Promise<BotSkillChoice[]> {
  const source = await scanSkillSource("agents", "公共 Agent", root);
  return source.skills.flatMap((skill) => {
    const part = under(root, skill.entryPath ?? skill.path);
    if (!part || skill.diagnostics.length) return [];
    return [{ id: key("agents", workspaceId ?? "", caseKey(part)), name: skill.name, description: skill.description, path: skill.path,
      source: workspaceId ? "project" : "global", label: workspaceId ? "项目 · 公共 Agent" : "本机全局 · 公共 Agent" }];
  });
}

export async function readBotSkills(
  storePath: string,
  homes: { codexHome?: string; localClaudeHome?: string },
  runtime: SessionRuntimeApi,
  profile?: ModelProfile,
  workspace?: Workspace,
  options: { project?: boolean; includeCache?: boolean } = {},
): Promise<BotSkillCatalog> {
  const testHome = process.env.AMO_STUDIO_TEST === "1" ? join(dirname(storePath), "test-skill-home") : undefined;
  // Electron's mock model still uses native CLIs, which also discover the Windows user's Agent Skills.
  const fixtureOnly = !!testHome && !!process.env.AMO_STUDIO_TEST_PROVIDER_URL;
  const home = testHome ?? homedir();
  const codexHome = testHome ? process.env.AMO_STUDIO_TEST_CODEX_HOME || join(home, ".codex") : homes.codexHome || process.env.CODEX_HOME || join(home, ".codex");
  const claudeHome = testHome ? join(home, ".claude") : homes.localClaudeHome || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const pluginRoots = { codex: join(codexHome, "plugins", "cache"), claude: join(claudeHome, "plugins", "cache") };
  const [global, project, native] = await Promise.all([
    portableSkills(join(home, ".agents", "skills")),
    workspace && options.project ? portableSkills(join(workspace.path, ".agents", "skills"), workspace.id) : [],
    profile && workspace && profile.runtime !== "dsh" && !fixtureOnly
      ? runtime.listProfileCommands?.(profile.id, workspace, true)?.catch(() => ({ commands: [], note: "暂时读不到当前渠道的技能。" }))
      : undefined,
  ]);
  const skills = new Map([...global, ...project].map((skill) => [skill.id, skill]));
  const portablePaths = new Map([...skills.values()].map((skill) => [caseKey(skill.path), skill]));
  if (profile && workspace && native) {
    const vendor = profile.runtime;
    const pluginRoot = vendor === "codex" || vendor === "claude" ? pluginRoots[vendor] : undefined;
    for (const skill of native.commands) {
      if (skill.group !== "skill" || !skill.skillPath || !isAbsolute(skill.skillPath) || basename(skill.skillPath).toLowerCase() !== "skill.md") continue;
      const path = await realpath(skill.skillPath).catch(() => undefined);
      if (!path || !(await stat(path).catch(() => undefined))?.isFile()) continue;
      const pluginId = skill.skillPluginId ?? (pluginRoot ? cachedPluginId(pluginRoot, skill.skillPath) : undefined);
      if (pluginId) {
        const choice = pluginChoice(vendor, pluginId, { ...skill, path }, skill.skillDisabled ? "插件未启用" : undefined);
        const previous = skills.get(choice.id);
        if (!previous || previous.unavailable) skills.set(choice.id, choice);
        continue;
      }
      const portable = portablePaths.get(caseKey(path));
      if (portable) {
        if (skill.skillDisabled) skills.set(portable.id, { ...portable, unavailable: "当前渠道已停用" });
        continue;
      }
      const part = options.project ? under(workspace.path, skill.skillPath) : undefined;
      const isProject = skill.skillScope === "project" || (skill.skillScope === undefined && !!part);
      if ((isProject && !options.project) || skill.skillDisabled) continue;
      const id = isProject ? key("project", vendor, workspace.id, caseKey(part ?? path)) : key("global", vendor, caseKey(path));
      skills.set(id, { id, name: skill.name, description: skill.description, path, source: isProject ? "project" : "global", label: runtimeLabel[vendor] ?? vendor });
    }
  }
  if (options.includeCache) {
    const caches = await Promise.all(Object.entries(pluginRoots).map(async ([vendor, root]) => ({ vendor, root, catalog: await scanSkillSource(vendor, vendor, root) })));
    for (const { vendor, root, catalog } of caches) for (const skill of catalog.skills) {
      const pluginId = cachedPluginId(root, skill.entryPath ?? skill.path);
      if (!pluginId || skill.diagnostics.length) continue;
      const unavailable = !profile ? "请在单个 Bot 中添加" : profile.runtime !== vendor ? "当前渠道不可用" : "未确认可用（插件缓存）";
      const choice = pluginChoice(vendor, pluginId, skill, unavailable);
      if (!skills.has(choice.id)) skills.set(choice.id, choice);
    }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.label.localeCompare(b.label)), ...(native?.note ? { note: native.note } : {}) };
}

export function botSkillPrompt(assignments: readonly BotSkillRef[], catalog: BotSkillCatalog): { prompt?: string; unavailable: string[] } {
  const available = new Map(catalog.skills.filter((skill) => !skill.unavailable).map((skill) => [skill.id, skill]));
  const paths = new Map<string, BotSkillChoice>();
  const unavailable: string[] = [];
  for (const ref of assignments) {
    const skill = available.get(ref.id);
    if (skill) paths.set(caseKey(skill.path), skill);
    else unavailable.push(ref.name);
  }
  const lines = [...paths.values()].map((skill) => `- ${JSON.stringify(skill.name)} · ${JSON.stringify(skill.path.replaceAll("\\", "/"))}`);
  return { ...(lines.length ? { prompt: ["【Bot 技能】", "处理匹配的任务时，先读取对应的 SKILL.md，再遵循其中与任务相关的步骤。技能中的相对路径以该技能文件所在目录为准，并遵守当前会话的执行权限。", ...lines].join("\n") } : {}), unavailable };
}
