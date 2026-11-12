import { useEffect, useState } from "react";
import { isCommon, type StateSnapshot, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { setThemePref, THEME_LABELS, useThemePref, type ThemePref } from "../lib/theme.js";
import { ModelsPage } from "./ModelsPage.js";
import { NetworkPage } from "./NetworkPage.js";
import { SubsessionPage } from "./SubsessionPage.js";
import { FeaturesSection } from "./FeaturesSection.js";
import { DevUiSection } from "./DevUi.js";
import { ExperimentalSection } from "./ExperimentalSection.js";
import { ScratchpadSettings } from "../scratchpad/ScratchpadSettings.js";
import { DataPage } from "./DataPage.js";
import { QuotaPage } from "./QuotaPage.js";
import { StatsPage } from "./StatsPage.js";
import { useDialogSize } from "./dialogSize.js";
import { MaintenancePage } from "./MaintenancePage.js";
import { DutyPage } from "./DutyPage.js";
import { McpPage } from "./McpPage.js";
import { FolderAccessSection } from "./FolderAccessSection.js";
import { setScrollOnSend, setTranscriptView, TRANSCRIPT_VIEW_HINTS, TRANSCRIPT_VIEW_LABELS, useScrollOnSend, useTranscriptView, type TranscriptView } from "../chat/prefs.js";
import { useChatSettings } from "../chat/cli/chatSettings.js";
import { defaultFolder, setDefaultFolder } from "../lib/profiles.js";
import { BotArt, MascotArt, ReaderArt } from "../focus/PixelBot.js";
import { PET_SKINS, usePetSkin, writePetSkin, type PetSkin } from "../focus/petSkin.js";
import { pickDirectory } from "../folders/FolderPicker.js";
import { GitEditorPage } from "./GitEditorPage.js";
import { PromptTemplateManager } from "../attach/PromptTemplateDialog.js";

const GROUPS = [
  { id: "general", label: "通用" },
  { id: "models", label: "模型与会话" },
  { id: "tools", label: "工具与自动化" },
  { id: "advanced", label: "高级设置" },
  { id: "maintenance", label: "数据与维护" },
] as const;
type SettingsGroup = (typeof GROUPS)[number]["id"];

/** Stable page ids keep links from the rest of Studio opening the right group. */
const PAGES = [
  { id: "ui", group: "general", label: "界面", keywords: "主题 深色 浅色 外观 大小 缩放 Focus 皮肤 工作步骤 发送 跳到最新 建议 远程" },
  { id: "common", group: "general", label: "项目与目录", keywords: "默认 公共 工作 文件夹 访问 权限" },
  { id: "scratchpad", group: "general", label: "便签", keywords: "随手记 快捷键" },
  { id: "models", group: "models", label: "模型与渠道", keywords: "渠道 Claude GPT Codex DeepSeek Pi 登录 账号 密钥 API Key 常用预设 型号 排序 压缩" },
  { id: "subsession", group: "models", label: "子会话", keywords: "型号 渠道 Fast 启动选项 权限 默认" },
  { id: "prompt-templates", group: "models", label: "提示词模板", keywords: "提示词 模板 prompt template 常用 新建 编辑 全局 项目" },
  { id: "quota", group: "models", label: "额度", keywords: "用量 余额 订阅 GPT Claude DeepSeek 左下角" },
  { id: "stats", group: "models", label: "用量统计", keywords: "用量 token 费用 花费 消耗" },
  { id: "mcp", group: "tools", label: "MCP", keywords: "服务 工具 stdio HTTP" },
  { id: "git-editor", group: "tools", label: "Git 编辑器", keywords: "程序 路径 自动 检测 打开方式" },
  { id: "duty", group: "tools", label: "值守", keywords: "调度 定时 任务 自动" },
  { id: "network", group: "advanced", label: "网络", keywords: "连接 代理 proxy HTTP SOCKS 连通性" },
  { id: "features", group: "advanced", label: "功能开关", keywords: "开关 命令行 Windows 适配 中转 确认 自动发送" },
  { id: "experimental", group: "advanced", label: "测试功能", keywords: "实验 开关 开发 界面 dev UI" },
  { id: "data", group: "maintenance", label: "数据管理", keywords: "归档 恢复 删除 清理 自动删除 保留天数" },
  { id: "maintenance", group: "maintenance", label: "维护", keywords: "版本 运行方式 终端 CLI 更新 安装 Claude Codex Pi" },
] as const;
export type SettingsPage = (typeof PAGES)[number]["id"];

// The page last open, for the next time 设置 opens in this window.
let lastPage: SettingsPage = "ui";
let lastGroup: SettingsGroup | null = "general";
const groupFor = (page: SettingsPage): SettingsGroup => PAGES.find((p) => p.id === page)!.group;

/** Settings keeps one category expanded; search temporarily previews matching pages across all categories. */
export function SettingsDialog({ link, state, settings, page: startPage, onClose, onOpenRemote }: { link: HostLink; /** The window's live snapshot (值守's forms offer its tasks, projects and models). */ state: StateSnapshot; settings: StudioSettings | null; /** Opens on this page. */ page?: SettingsPage; onClose(): void; /** 远程 left 设置 for a page of its own (2026-10-29): the line on 界面 opens it. */ onOpenRemote?: () => void }) {
  const [selectedPage, setPage] = useState<SettingsPage>(startPage ?? lastPage);
  const [expanded, setExpanded] = useState<SettingsGroup | null>(startPage ? groupFor(startPage) : lastGroup);
  const [search, setSearch] = useState("");
  const [searchPage, setSearchPage] = useState<SettingsPage | null>(null);
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const pages = PAGES.filter((p) => terms.every((term) => `${GROUPS.find((g) => g.id === p.group)!.label} ${p.label} ${p.keywords}`.toLowerCase().includes(term)));
  // Search previews never overwrite the page/group to restore when it is cleared.
  const page = searching ? pages.find((p) => p.id === searchPage)?.id ?? pages.find((p) => p.id === selectedPage)?.id ?? pages[0]?.id : selectedPage;
  const theme = useThemePref();
  const view = useTranscriptView();
  const jumpOnSend = useScrollOnSend();
  const chat = useChatSettings(link);
  const [dir, setDir] = useState(settings?.commonWorkspace?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const size = useDialogSize();

  useEffect(() => { lastPage = selectedPage; lastGroup = expanded; }, [selectedPage, expanded]);
  useEffect(() => setDir(settings?.commonWorkspace?.path ?? ""), [settings?.commonWorkspace?.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveCommon(value: string) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await call(link, "PUT /api/settings", {}, { commonDir: value });
      setMessage({ text: `公共目录：${next.commonWorkspace.path}` });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    const chosen = await pickDirectory();
    if (chosen) setDir(chosen);
  }

  function open(next: SettingsPage) {
    if (searching) setSearchPage(next);
    else {
      setPage(next);
      setExpanded(groupFor(next));
    }
    setMessage(null);
  }

  function toggleGroup(group: SettingsGroup) {
    const next = expanded === group ? null : group;
    setExpanded(next);
    if (next && groupFor(selectedPage) !== next) {
      const first = PAGES.find((p) => p.group === next)!;
      setPage(first.id);
      setMessage(null);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置" style={size.style}>
        <div className="modal-head">
          <span className="modal-title">设置</span>
          <span className="spacer" />
          <button type="button" className="link-btn" onClick={onClose} aria-label="关闭设置">
            关闭
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-sidebar">
            <div className="settings-search">
              <input
                className="field"
                type="search"
                aria-label="搜索设置"
                placeholder="搜索设置"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSearchPage(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && search) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearch("");
                  }
                }}
              />
              {search && <button type="button" className="settings-search-clear" aria-label="清空设置搜索" onClick={() => setSearch("")}>×</button>}
            </div>
            <nav className="settings-nav" aria-label="设置分类" onKeyDown={(e) => {
              const target = e.target as HTMLElement;
              if (!["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
              const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.getClientRects().length > 0);
              const index = buttons.indexOf(target as HTMLButtonElement);
              if (index < 0) return;
              e.preventDefault();
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                if (searching) return;
                const group = target.closest<HTMLElement>("[data-settings-group]")!.dataset.settingsGroup as SettingsGroup;
                if (e.key === "ArrowRight" && expanded !== group) toggleGroup(group);
                if (e.key === "ArrowLeft" && expanded === group) {
                  document.getElementById(`settings-group-${group}`)?.focus();
                  toggleGroup(group);
                }
                return;
              }
              const next = buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]!;
              next.focus();
              if (next.dataset.page) open(next.dataset.page as SettingsPage);
            }}>
              {GROUPS.map((group) => {
                const children = pages.filter((p) => p.group === group.id);
                if (!children.length) return null;
                const isOpen = searching || expanded === group.id;
                return <div className="settings-group" data-settings-group={group.id} key={group.id}>
                  {searching ? <div className="settings-group-label">{group.label}</div> : <button
                    type="button"
                    className="settings-group-toggle"
                    id={`settings-group-${group.id}`}
                    aria-expanded={isOpen}
                    aria-controls={`settings-group-pages-${group.id}`}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span className="settings-group-arrow" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                    {group.label}
                  </button>}
                  <div className="settings-group-pages" id={`settings-group-pages-${group.id}`} hidden={!isOpen} role="tablist" aria-label={group.label} aria-orientation="vertical">
                    {children.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="tab"
                        id={`settings-tab-${p.id}`}
                        aria-selected={page === p.id}
                        aria-controls="settings-page"
                        data-page={p.id}
                        tabIndex={page === p.id ? 0 : -1}
                        className="settings-tab"
                        onClick={() => open(p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>;
              })}
            </nav>
          </div>
          <div className="settings-page" id="settings-page" role={page ? "tabpanel" : undefined} aria-labelledby={page ? `settings-tab-${page}` : undefined} key={page}>
            {!page && <p className="settings-search-empty" role="status">没有匹配的设置，试试其他关键词。</p>}
            {page === "network" && <NetworkPage link={link} value={settings?.network} />}
            {page === "ui" && (
              <section className="settings-section" aria-label="界面">
                <span className="settings-heading">界面</span>
                <div className="settings-row">
                  <span className="settings-label">主题</span>
                  <div role="radiogroup" aria-label="主题" className="chips">
                    {(Object.keys(THEME_LABELS) as ThemePref[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={theme === p}
                        aria-pressed={theme === p}
                        onClick={() => setThemePref(p)}
                      >
                        {THEME_LABELS[p]}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">只影响这台电脑上的 Studio；Focus 悬浮窗会一起切换。</span>
                <PetSkinRow />
                {window.amo?.uiScale && <UiScaleRow />}
                <div className="settings-row">
                  <span className="settings-label">工作步骤展示</span>
                  <div role="radiogroup" aria-label="工作步骤展示" className="chips">
                    {(Object.keys(TRANSCRIPT_VIEW_LABELS) as TranscriptView[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={view === v}
                        aria-pressed={view === v}
                        title={TRANSCRIPT_VIEW_HINTS[v]}
                        onClick={() => setTranscriptView(v)}
                      >
                        {TRANSCRIPT_VIEW_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">{TRANSCRIPT_VIEW_HINTS[view]}。</span>
                <div className="settings-row">
                  <span className="settings-label">发送后跳到最新</span>
                  <div role="radiogroup" aria-label="发送后跳到最新" className="chips">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={jumpOnSend === on}
                        aria-pressed={jumpOnSend === on}
                        onClick={() => setScrollOnSend(on)}
                        data-testid={`scroll-on-send-${on ? "on" : "off"}`}
                      >
                        {on ? "开启" : "关闭"}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">在输入框发出消息后，对话直接跳到最末尾并跟着回复往下走，不管之前看到哪里。关闭后停在原来看的位置。</span>
                <div className="settings-row">
                  <span className="settings-label">建议的下一句</span>
                  <div role="radiogroup" aria-label="建议的下一句" className="chips">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={chat.settings.promptSuggestions === on}
                        aria-pressed={chat.settings.promptSuggestions === on}
                        onClick={() => void chat.update({ promptSuggestions: on }).catch((err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true }))}
                      >
                        {on ? "显示" : "关闭"}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">Claude 会话每轮回答后，在输入框上方给出建议的下一句，点一下填进输入框。默认关闭：每轮会多一次很小的模型请求。</span>
                {/* 2026-10-29: 远程 was a page of 设置 until it got its own; this line is for whoever looks for it here. */}
                <div className="settings-row" data-testid="settings-remote-moved">
                  <span className="settings-label">远程</span>
                  <span className="settings-hint">远程功能在顶栏的「远程」里。</span>
                  {onOpenRemote && (
                    <button type="button" className="link-btn" onClick={onOpenRemote} data-testid="settings-open-remote">
                      打开
                    </button>
                  )}
                </div>
                {message && (
                  <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="settings-message">
                    {message.text}
                  </span>
                )}
              </section>
            )}

            {page === "models" && <ModelsPage link={link} settings={settings} />}
            {page === "subsession" && <SubsessionPage link={link} settings={settings} />}
            {page === "prompt-templates" && <PromptTemplateManager link={link} projects={state.workspaces.filter((w) => !isCommon(w))} />}
            {page === "quota" && <QuotaPage link={link} settings={settings} />}
            {page === "stats" && <StatsPage link={link} />}

            {page === "common" && <DefaultFolderSection />}
            {page === "git-editor" && <GitEditorPage link={link} />}
            {page === "common" && (
              <section className="settings-section" aria-label="公共目录">
                <span className="settings-heading">公共目录</span>
                <span className="settings-hint">没有指定项目的任务、调度 agent，以及没选项目的专题会话都在这个文件夹里运行。默认是数据目录下的 common 文件夹。</span>
                <div className="settings-row">
                  <input className="field" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="例如 D:\AMO\common" aria-label="公共目录" />
                  {window.amo?.pickDirectory && (
                    <button type="button" className="btn-ghost small" onClick={() => void pick()} disabled={busy}>
                      选择…
                    </button>
                  )}
                </div>
                <div className="settings-row end">
                  <button type="button" className="btn-primary small" onClick={() => void saveCommon(dir.trim())} disabled={busy || !dir.trim() || dir.trim() === settings?.commonWorkspace?.path}>
                    保存
                  </button>
                </div>
                {message && (
                  <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="settings-message">
                    {message.text}
                  </span>
                )}
              </section>
            )}
            {page === "common" && <FolderAccessSection link={link} />}
            {page === "features" && <FeaturesSection link={link} disabled={settings?.disabledFeatures ?? []} teamAutoSend={settings?.teamAutoSend ?? false} shellHelp={settings?.shellHelp ?? true} />}
            {page === "experimental" && (
              <>
                <ExperimentalSection link={link} on={settings?.experimentalFeatures ?? []} />
                <DevUiSection link={link} dir={settings?.devUiDir ?? null} />
              </>
            )}
            {page === "scratchpad" && <ScratchpadSettings link={link} settings={settings} />}
            {page === "data" && <DataPage link={link} />}
            {page === "duty" && <DutyPage link={link} state={state} />}
            {page === "mcp" && <McpPage link={link} />}
            {page === "maintenance" && <MaintenancePage link={link} />}
          </div>
        </div>
        <span className="settings-grip" role="separator" aria-label="拖动改变设置窗口大小，双击恢复默认" title="拖动改变大小，双击恢复默认" data-testid="settings-grip" {...size.grip} />
      </div>
    </div>
  );
}

/** 默认路径 (2026-10-17, in place of 默认项目): where 选择文件夹 starts when adding a project; kept on this machine. */
function DefaultFolderSection() {
  const [path, setPath] = useState(defaultFolder);
  const [saved, setSaved] = useState(defaultFolder);
  const save = (next: string) => {
    setDefaultFolder(next);
    setPath(next.trim());
    setSaved(next.trim());
  };
  const browse = async () => {
    const chosen = await pickDirectory(path.trim() || null);
    if (chosen) save(chosen);
  };
  return (
    <section className="settings-section" aria-label="默认路径">
      <span className="settings-heading">默认路径</span>
      <span className="settings-hint">添加项目时点「选择文件夹」，从这个文件夹开始选（比如放所有工程的目录）。不填就从系统默认的位置开始。只存在这台电脑上。</span>
      <div className="settings-row">
        <input className="field" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save(path)} placeholder="例如 G:\PROJECT" aria-label="默认路径" />
        {window.amo?.pickDirectory && (
          <button type="button" className="btn-ghost small" onClick={() => void browse()}>
            选择…
          </button>
        )}
      </div>
      <div className="settings-row end">
        {saved && (
          <button type="button" className="btn-ghost small" onClick={() => save("")}>
            清除
          </button>
        )}
        <button type="button" className="btn-primary small" onClick={() => save(path)} disabled={path.trim() === saved}>
          保存
        </button>
      </div>
    </section>
  );
}

const UI_SCALE_LABELS: Array<[number, string]> = [
  [0.9, "小"],
  [1, "标准"],
  [1.1, "大"],
  [1.25, "较大"],
  [1.4, "特大"],
];

/** 界面大小 (2026-10-15): text and icons of every Studio window, Focus too, together. */
function UiScaleRow() {
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const api = window.amo?.uiScale;
    if (!api) return;
    void api.get().then(setScale);
    return api.onChange(setScale);
  }, []);
  return (
    <>
      <div className="settings-row">
        <span className="settings-label">界面大小</span>
        <div role="radiogroup" aria-label="界面大小" className="chips">
          {UI_SCALE_LABELS.map(([s, label]) => (
            <button
              key={s}
              type="button"
              role="radio"
              className="chip"
              aria-checked={scale !== null && Math.abs(scale - s) < 0.001}
              aria-pressed={scale !== null && Math.abs(scale - s) < 0.001}
              onClick={() => {
                setScale(s);
                void window.amo?.uiScale?.set(s);
              }}
            >
              {label} {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      </div>
      <span className="settings-hint">文字和图标一起放大缩小，所有 Studio 窗口（含 Focus）一起变。快捷键：Ctrl + = 放大，Ctrl + - 缩小，Ctrl + 0 恢复标准。</span>
    </>
  );
}

/** Focus 桌宠 (2026-10-15 evening): who pops up on Focus when something needs the person, and flies about when ignored. */
function PetSkinRow() {
  const skin = usePetSkin();
  return (
    <>
      <div className="settings-row">
        <span className="settings-label">Focus 桌宠</span>
        <div role="radiogroup" aria-label="Focus 桌宠" className="chips">
          {(Object.keys(PET_SKINS) as PetSkin[]).map((k) => (
            <button key={k} type="button" role="radio" className="chip" aria-checked={skin === k} aria-pressed={skin === k} onClick={() => writePetSkin(k)} data-testid={`pet-skin-${k}`}>
              {PET_SKINS[k]}
            </button>
          ))}
        </div>
        <span className="settings-pet-preview" data-testid="pet-skin-preview">
          {skin === "reader" ? <ReaderArt mood="calm" /> : skin === "mascot" ? <MascotArt mood="calm" /> : <BotArt mood="calm" />}
        </span>
      </div>
      <span className="settings-hint">有事时在 Focus 上冒出来提醒你；放着 5 分钟不管会生气、满屏乱飞。只影响这台电脑。</span>
      {skin === "mascot" && (
        <span className="settings-hint" data-testid="pet-skin-mascot-hint">
          选了 AMO 娘，左上角和窗口（标题栏、任务栏）的图标也换成她，并跟着换表情：出错或等你审批是「待命」，没额度是「睿智」，有会话在跑是「认真」，只剩等你审核是「开心」，什么都没有是她的头像。
        </span>
      )}
    </>
  );
}
