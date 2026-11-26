import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const studio = fileURLToPath(new URL("../studio/", import.meta.url));
const ui = join(studio, "packages", "ui");
const requireStudio = createRequire(join(studio, "package.json"));
const requireUi = createRequire(join(ui, "package.json"));
const { _electron, expect } = requireStudio("@playwright/test");
const { createServer } = await import(pathToFileURL(requireUi.resolve("vite")));
const { startMockModel, MOCK_MODEL_CATALOG, removeTempDir } = await import(pathToFileURL(requireStudio.resolve("@amo-studio/testkit")));

const style = `
.bot-design-nav { display: flex; overflow-x: auto; gap: 2px; flex: none; margin: 0 var(--bot-editor-gutter) 14px; border-bottom: 1px solid var(--border); }
.bot-design-nav button { flex: 0 0 auto; padding: 7px 8px 9px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-dim); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
.bot-design-nav button:hover { color: var(--text); background: var(--tint); }
.bot-design-nav button[aria-current] { color: var(--primary); border-color: var(--primary); font-weight: 650; }
.bot-design-nav button:focus-visible { outline-offset: -2px; }
.bot-design-preview-note { margin: 0; margin-left: auto; font-size: var(--fs-cap); color: var(--text-dim); }
.bot-design-overview { display: grid; gap: 10px; }
.bot-design-card { min-width: 0; border: 1px solid var(--border); border-radius: var(--r-m); background: var(--panel-raised); padding: 10px 12px 4px; }
.bot-design-card-memory { border-color: color-mix(in srgb, var(--primary) 38%, var(--border)); background: color-mix(in srgb, var(--selected) 48%, var(--panel-raised)); }
.bot-design-card h4 { margin: 0 0 4px; font-size: var(--fs-sm); }
.bot-design-card .bot-design-hint { margin: 0 0 9px; }
.bot-design-row { display: flex; gap: 8px; justify-content: space-between; align-items: center; width: 100%; min-height: 32px; border: 0; border-top: 1px solid var(--border); padding: 5px 0; background: transparent; color: var(--text); text-align: left; font: inherit; font-size: var(--fs-sm); }
button.bot-design-row { cursor: pointer; }
button.bot-design-row:hover { color: var(--primary); }
.bot-design-row > span:last-child { display: flex; align-items: center; gap: 5px; text-align: right; min-width: 0; color: var(--text-dim); }
.bot-design-row svg { width: 13px; height: 13px; flex: none; }
.bot-design-row code, .bot-design-files button, .bot-design-file-heading code { font-family: var(--font-code); font-size: var(--fs-cap); }
.bot-design-card-memory .bot-design-row code { color: var(--primary); }
.bot-design-editor { container: bot-design / inline-size; }
.bot-design-editor [hidden] { display: none !important; }
.bot-design-detail { display: grid; gap: 12px; }
.bot-design-detail .bot-editor-section { border-top: 0; padding-top: 0; }
.bot-design-detail > p { margin: 0; }
.bot-design-files { display: grid; grid-template-columns: minmax(116px, 27%) minmax(0, 1fr); overflow: hidden; border: 1px solid var(--border); border-radius: var(--r-m); }
.bot-design-files nav { display: grid; align-content: start; gap: 3px; padding: 8px 6px; border-right: 1px solid var(--border); background: var(--panel-raised); }
.bot-design-files nav summary, .bot-design-files nav button { width: 100%; padding: 6px; text-align: left; border: 0; border-radius: var(--r-s); background: transparent; color: var(--text-dim); cursor: pointer; overflow-wrap: anywhere; }
.bot-design-files nav summary { font: inherit; font-size: var(--fs-cap); }
.bot-design-files nav details button { padding-left: 14px; }
.bot-design-files nav button[aria-pressed='true'] { background: var(--selected); color: var(--primary); }
.bot-design-files nav button:hover { background: var(--tint); color: var(--text); }
.bot-design-file-content { min-width: 0; padding: 9px; }
.bot-design-file-heading { min-height: 28px; display: flex; justify-content: space-between; align-items: center; gap: 7px; margin-bottom: 5px; }
.bot-design-file-content textarea { width: 100%; min-height: 160px; resize: vertical; }
.bot-design-file-field > small { display: block; margin-top: 4px; }
.bot-design-detail .bot-preference { padding-block: 9px; gap: 10px; font-size: var(--fs-sm); }
.bot-design-detail select { max-width: 56%; }
@container bot-design (min-width: 505px) { .bot-design-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); } .bot-design-overview .bot-design-wide { grid-column: 1 / -1; } }
@container bot-design (max-width: 360px) { .bot-design-files { grid-template-columns: 1fr; } .bot-design-files nav { border-right: 0; border-bottom: 1px solid var(--border); } }
`;

const sections = `
const botDesignSections = [["overview", "概览"], ["runtime", "运行配置"], ["memory", "角色与记忆"], ["automation", "自动化"], ["access", "访问与技能"], ["notifications", "通知"]];

function BotDesignOverview({ draft, state, shared, schedule, notifications, show }) {
  const profile = state.profiles.find((entry) => entry.id === draft.profileId);
  const workspace = state.workspaces.find((entry) => entry.id === draft.workspaceId);
  const permission = ({ "read-only": "只读", plan: "只读", "workspace-write": "工作区可写", acceptEdits: "允许编辑", "full-access": "完全访问", bypassPermissions: "完全访问" })[draft.permission ?? "read-only"] ?? "自定义权限";
  const row = (label, value, panel, file) => <button className="bot-design-row" type="button" onClick={() => show(panel, file)}><span>{label}</span><span>{value}<IconChevronRight /></span></button>;
  return <div className="bot-design-overview">
    <section className="bot-design-card"><h4>运行配置</h4>
      {row("模型", profile?.label ?? "请选择模型", "runtime")}
      {row("执行权限", permission, "runtime")}
      {row("默认项目", workspace?.name ?? "公共目录", "runtime")}
    </section>
    <section className="bot-design-card bot-design-card-memory"><h4>角色与记忆</h4>
      {row("角色职责", <code>SOUL.md</code>, "memory", "purpose")}
      {row("长期记忆", <code>MEMORY.md</code>, "memory", "memory")}
      {row("记忆文件夹", <code>memory/</code>, "memory", "notes")}
    </section>
    <section className="bot-design-card"><h4>自动化</h4>
      {row("巡视", schedule.patrol, "automation")}
      {row("记忆整理", schedule.memory, "automation")}
      {row("长期未活动", schedule.idle, "automation")}
    </section>
    <section className="bot-design-card"><h4>访问与技能</h4>
      {row("谁可以提问", "仅自己", "access")}
      {row("技能", (shared?.length ?? 0) + " 项共有 · " + (draft.skills?.length ?? 0) + " 项专用", "access")}
      {row("连接器与分享", "Webhook", "access")}
    </section>
    <section className="bot-design-card bot-design-wide"><h4>通知</h4>
      {row("需要授权、完成与失败", Object.values(notifications).filter(Boolean).length + " 项已开启", "notifications")}
    </section>
  </div>;
}

function BotDesignAutomation({ schedule, update }) {
  const options = [["patrol", "巡视", ["每 4 小时", "每 8 小时", "每天", "关闭"]], ["memory", "记忆整理", ["每晚 23:00", "每周一次", "关闭"]], ["idle", "长期未活动", ["5 天", "7 天", "14 天"]]];
  return <div className="bot-design-detail">
    <p className="settings-hint">示例计划。可调整选项，在这里预览设置方式。</p>
    <section className="bot-design-card">
      {options.map(([key, label, choices]) => <label key={key} className="bot-design-row"><span>{label}</span><select className="field" aria-label={label} value={schedule[key]} onChange={(event) => update({ ...schedule, [key]: event.target.value })}>{choices.map((choice) => <option key={choice}>{choice}</option>)}</select></label>)}
    </section>
  </div>;
}

function BotDesignNotifications({ values, update }) {
  return <div className="bot-design-detail">
    <p className="settings-hint">选择这个 Bot 的哪些事件需要提醒。</p>
    <section className="bot-design-card">
      {[["approval", "需要授权", "Bot 需要你批准一个操作。"], ["done", "任务完成", "Bot 已给出任务结果。"], ["failed", "无法完成", "Bot 遇到阻塞，需要你处理。"]].map(([key, label, hint]) => <BotPreference key={key} label={label} hint={hint} checked={values[key]} disabled={false} onChange={(checked) => update({ ...values, [key]: checked })} />)}
    </section>
  </div>;
}
`;

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Bot settings preview anchor missing: ${before}`);
  return source.replace(before, after);
}

function preview(source) {
  source = replace(source, '  const { id } = selected;', `  const { id } = selected;
  const [designPanel, setDesignPanel] = useState("overview");
  const [designFile, setDesignFile] = useState("memory");
  const [designNotes, setDesignNotes] = useState("# 审查笔记\\n\\n- 核对旧数据兼容性。\\n- 检查失败重试是否会重复执行。");
  const [designSchedule, setDesignSchedule] = useState({ patrol: "每 4 小时", memory: "每晚 23:00", idle: "5 天" });
  const [designNotifications, setDesignNotifications] = useState({ approval: true, done: true, failed: true });
  const designScroll = useRef(null);
  const showDesign = (panel, file) => {
    if (file) setDesignFile(file);
    setDesignPanel(panel);
    designScroll.current?.scrollTo({ top: 0 });
  };`);
  source = replace(source, '<div className="bot-settings-editor">', '<div className="bot-settings-editor bot-design-editor">');
  source = replace(source, '<h3 title={selected.name}>{selected.name}</h3>', '<h3 title={selected.name}>{selected.name}</h3><span className="bot-design-preview-note">设计预览</span>');
  source = replace(source, '    <div className="bot-editor-scroll">', `    <style>{${JSON.stringify(style)}}</style>
    <nav className="bot-design-nav" aria-label="Bot 设置分区">
      {botDesignSections.map(([panel, label]) => <button key={panel} type="button" aria-current={designPanel === panel ? "page" : undefined} onClick={() => showDesign(panel)}>{label}</button>)}
    </nav>
    <div className="bot-editor-scroll" ref={designScroll}>
      {designPanel === "overview" && <BotDesignOverview draft={draft} state={state} shared={shared} schedule={designSchedule} notifications={designNotifications} show={showDesign} />}
      {designPanel === "automation" && <BotDesignAutomation schedule={designSchedule} update={setDesignSchedule} />}
      {designPanel === "notifications" && <BotDesignNotifications values={designNotifications} update={setDesignNotifications} />}`);
  source = replace(source, '        <div className="bot-editor-identity">', '        <div className="bot-design-detail" hidden={designPanel !== "runtime"}><div className="bot-editor-identity">');
  source = replace(source, '        <BotSkillsSection link={link}', `        </div>
        <div className="bot-design-detail" hidden={designPanel !== "access"}>
        <section className="bot-design-card"><h4>访问权限</h4><div className="bot-design-row"><span>谁可以提问</span><span>仅自己</span></div><div className="bot-design-row"><span>分享</span><span>已关闭</span></div></section>
        <BotSkillsSection link={link}`);
  source = replace(source, '        <section className="bot-editor-section" aria-labelledby="bot-editor-content-title">\n          <h4 id="bot-editor-content-title">职责与记忆</h4>', `        </div>
        <section className="bot-design-detail" hidden={designPanel !== "memory"} aria-label="角色与记忆">
          <div><h4 className="settings-heading">Bot 资料目录</h4><p className="settings-hint">每个 Bot 保存自己的职责和长期记忆。任务仍在原项目或工作树运行。</p></div>
          <div className="bot-design-files">
            <nav aria-label="Bot 资料文件">
              <button type="button" aria-pressed={designFile === "purpose"} onClick={() => setDesignFile("purpose")}>SOUL.md</button>
              <button type="button" aria-pressed={designFile === "memory"} onClick={() => setDesignFile("memory")}>MEMORY.md</button>
              <details open><summary>memory/</summary><button type="button" aria-pressed={designFile === "notes"} onClick={() => setDesignFile("notes")}>reviews.md</button></details>
            </nav>
            <div className="bot-design-file-content">`);
  source = replace(source, '<div className="bot-form-field">\n            <div className="bot-editor-field-head"><label htmlFor="studio-bot-purpose">职责</label>', '<div className="bot-design-file-field" hidden={designFile !== "purpose"}>\n            <div className="bot-design-file-heading"><label htmlFor="studio-bot-purpose"><code>SOUL.md</code></label>');
  source = replace(source, '<div className="bot-form-field">\n            <div className="bot-editor-field-head"><label htmlFor="studio-bot-memory">记忆</label>', '<div className="bot-design-file-field" hidden={designFile !== "memory"}>\n            <div className="bot-design-file-heading"><label htmlFor="studio-bot-memory"><code>MEMORY.md</code></label>');
  source = replace(source, '        </section>\n      </form>', `              <div className="bot-design-file-field" hidden={designFile !== "notes"}>
                <div className="bot-design-file-heading"><label htmlFor="bot-design-notes"><code>memory/reviews.md</code></label></div>
                <textarea id="bot-design-notes" className="field" value={designNotes} onChange={(event) => setDesignNotes(event.target.value)} />
                <small className="settings-hint">示例记忆文件，可在本页试改。</small>
              </div>
            </div>
          </div>
        </section>
      </form>`);
  source = replace(source, '{!!chats.length && <section', '{designPanel === "runtime" && !!chats.length && <section');
  source = replace(source, '<BotWebhooks link={link} id={id} />', '{designPanel === "access" && <BotWebhooks link={link} id={id} />}');
  return source + sections;
}

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
const sandbox = await mkdtemp(join(tmpdir(), "amo-studio-bot-design-"));
const screenshots = join(studio, "screenshots", "studio");
const data = join(sandbox, "data");
const codexHome = join(sandbox, "codex-home");
let server;
let mock;
let electron;

try {
  await mkdir(data);
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), "[features]\nplugins = false\n");
  server = await createServer({
    root: ui,
    cacheDir: join(sandbox, "vite"),
    server: { host: "127.0.0.1", port: 47988, strictPort: true, hmr: false },
    plugins: [{
      name: "amo-bot-settings-design-preview",
      enforce: "pre",
      transform(source, id) {
        if (id.replaceAll("\\", "/").endsWith("/src/bots/BotsPage.tsx")) return preview(source);
      },
    }],
  });
  await server.listen();
  const devUrl = server.resolvedUrls.local[0];
  console.log(`Studio preview renderer ready at ${devUrl}`);
  mock = await startMockModel();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(AMO_STUDIO_|AMO_HOME$|AMO_LOCAL_HOME$)/i.test(key)));
  electron = await _electron.launch({
    executablePath: requireStudio("electron"),
    args: [join(studio, "packages", "app", "dist", "main.js")],
    env: { ...inherited, AMO_STUDIO_TEST: "1", AMO_STUDIO_PORT: "47989", AMO_STUDIO_DATA_DIR: data,
      AMO_HOME: join(sandbox, "amo-home"), AMO_LOCAL_HOME: join(sandbox, "amo-local"), AMO_STUDIO_DSH_DESKTOP: "",
      AMO_STUDIO_DEV_URL: devUrl, AMO_STUDIO_DEV_ORIGIN: new URL(devUrl).origin,
      AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl, AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG, AMO_STUDIO_TEST_CODEX_HOME: codexHome },
  });
  const window = await electron.firstWindow({ timeout: 45000 });
  window.on("pageerror", error => console.error("Renderer:", error.message));
  const { url } = JSON.parse(await readFile(join(data, "host.json"), "utf8"));
  const token = (await readFile(join(data, "host-token"), "utf8")).trim();
  async function createBot(name, purpose, memory, avatar) {
    const response = await fetch(new URL("/api/bots", url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, purpose, memory, avatar, profileId: "codex-mock", workspaceId: null, enabled: true }) });
    if (!response.ok) throw new Error(`Create preview Bot failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
  await createBot("审核员", "# 审核员\n\n审查改动中的功能回归，核实影响范围。结论附文件、行号和触发条件。", "# 长期记忆\n\n- 优先检查功能回归，先核对实际调用链。\n- 汇报时区分编译通过和实际运行验证。", "mascot:A1");
  await createBot("开发助手", "按项目要求完成实现和验证。", "# 开发助手\n\n- 复用项目已有组件。", "mascot:B1");

  await window.getByRole("button", { name: "Bot 选项", exact: true }).click({ timeout: 45000 });
  await window.getByRole("menuitem", { name: "打开 Bots 工作台" }).click();
  const openSettings = window.getByRole("button", { name: "管理 Bots", exact: true });
  const dialog = window.getByRole("dialog", { name: "设置", exact: true });
  const settings = dialog.getByTestId("studio-bots-settings");
  const nav = settings.getByRole("navigation", { name: "Bot 设置分区" });
  async function openBotSettings() {
    await openSettings.click();
    await settings.getByRole("button", { name: "审核员", exact: true }).click();
    await expect(nav.getByRole("button", { name: "概览", exact: true })).toHaveAttribute("aria-current", "page");
  }
  async function capture(name) {
    await window.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const bytes = await electron.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    const file = join(screenshots, `bot-settings-design-${name}.png`);
    await writeFile(file, Buffer.from(bytes, "base64"));
    console.log(file);
  }

  await mkdir(screenshots, { recursive: true });
  await openBotSettings();
  await capture("amo-light");
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await window.getByRole("button", { name: "深色模式", exact: true }).click();
  await openBotSettings();
  await capture("amo-dark");
  await settings.getByRole("button", { name: /长期记忆.*MEMORY.md/ }).click();
  const memory = settings.getByRole("textbox", { name: "MEMORY.md", exact: true });
  await expect(memory).toHaveValue(/优先检查功能回归/);
  await capture("amo-memory");
  await memory.fill("示例记忆修改");
  await settings.getByRole("button", { name: "reviews.md", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "memory/reviews.md" })).toHaveValue(/旧数据兼容性/);
  await settings.getByRole("button", { name: "MEMORY.md", exact: true }).click();
  await expect(memory).toHaveValue("示例记忆修改");
  await nav.getByRole("button", { name: "运行配置", exact: true }).click();
  await expect(settings.getByRole("group", { name: "权限", exact: true }).getByRole("button", { name: /^只读/ })).toHaveAttribute("aria-pressed", "true");
  await nav.getByRole("button", { name: "自动化", exact: true }).click();
  await settings.getByLabel("巡视", { exact: true }).selectOption("每天");
  await nav.getByRole("button", { name: "通知", exact: true }).click();
  await settings.getByRole("switch", { name: "任务完成", exact: true }).uncheck();
  await nav.getByRole("button", { name: "概览", exact: true }).click();
  await expect(settings.getByRole("button", { name: "巡视 每天" })).toBeVisible();
  await expect(settings.getByRole("button", { name: /2 项已开启/ })).toBeVisible();
  await settings.getByRole("button", { name: "开发助手", exact: true }).click();
  await nav.getByRole("button", { name: "角色与记忆", exact: true }).click();
  await expect(memory).toHaveValue(/复用项目已有组件/);
  await settings.getByRole("button", { name: "审核员", exact: true }).click();
  await expect(nav.getByRole("button", { name: "概览", exact: true })).toHaveAttribute("aria-current", "page");
  console.log("Native Studio overview, runtime permissions, per-Bot memory, automation and notification controls verified.");

  if (process.argv.includes("--show")) {
    // Put only this isolated preview on screen after setup. Hiding its main window closes this test app and its Host.
    const display = await electron.evaluate(({ BrowserWindow, screen, app }) => {
      const view = BrowserWindow.getAllWindows()[0];
      const area = screen.getPrimaryDisplay().workArea;
      const width = Math.min(1440, area.width - 48);
      const height = Math.min(900, area.height - 48);
      view.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height });
      view.setTitle("AMO Studio · Bot 设置设计预览");
      view.setSkipTaskbar(false);
      view.setFocusable(true);
      view.once("hide", () => app.quit());
      view.show();
      return { visible: view.isVisible(), bounds: view.getBounds() };
    });
    console.log(`Interactive Studio preview: ${JSON.stringify(display)}`);
    await new Promise(resolve => electron.once("close", resolve));
    electron = undefined;
  }
} finally {
  await electron?.close();
  await mock?.close();
  await server?.close();
  removeTempDir(sandbox);
}
