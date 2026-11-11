import { selectSettingsPage } from "../support/settings.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 11 (S11-B): images and file references in the conversation — paste, drop from Explorer, the paperclip, how the
// transcript shows them. Real Codex app-server and the mock model, which says how many images it saw.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTask(s: Studio, dir: string, text = "hello") {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "附件", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text } });
  await s.page.getByTestId("task-card").first().click();
  await expect(s.page.getByTestId("task-title")).toHaveText("附件");
  await expect(lastAgent(s.page)).toContainText(`MOCK: ${text}`, { timeout: 30_000 });
  return { ws, ...created };
}

const composer = (page: Page) => page.getByLabel("输入消息");
const lastAgent = (page: Page) => page.getByTestId("msg-agent").last();

/** Pastes an in-memory PNG into the composer (or `into`), the way Ctrl+V with a screenshot does. */
async function pasteImage(page: Page, name = "截图.png", into = composer(page)) {
  await into.evaluate(
    (el, { b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { b64: TINY_PNG_BASE64, name },
  );
}

/**
 * Drops files from disk on the conversation, the way Explorer does: the files go through a file input first so that
 * they have a real path (Electron's webUtils reads it), then travel in a drop event's DataTransfer.
 */
async function dropFiles(page: Page, paths: string[]) {
  await page.evaluate(() => {
    const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, id: "e2e-drop-source" });
    input.hidden = true;
    document.body.append(input);
  });
  await page.setInputFiles("#e2e-drop-source", paths);
  await page.evaluate(() => {
    const input = document.getElementById("e2e-drop-source") as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of input.files ?? []) dt.items.add(f);
    const target = document.querySelector('[data-testid="thread"]')!;
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    input.remove();
  });
}

test("pastes an image, sends it with the message, and shows it in the transcript", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, studio.workspace("alpha"));

  await composer(page).fill("这张图里是什么");
  await pasteImage(page);
  const thumb = composer(page).locator(".resource-image");
  await expect(thumb).toHaveCount(1);
  await expect(thumb).toHaveAttribute("data-state", "ready");
  // A second one, removed again with its ×.
  await pasteImage(page, "多余.png");
  await expect(thumb).toHaveCount(2);
  await page.getByRole("button", { name: /移除.*多余\.png/ }).click();
  await expect(thumb).toHaveCount(1);
  // Before sending, a click on the thumbnail shows it large (2026-10-25); Esc closes only that.
  await thumb.getByRole("button", { name: /^查看大图/ }).click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await expect.poll(() => page.getByTestId("lightbox").locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await expect(thumb).toHaveCount(1);
  await screenshot(studio.app, "stage-11", "S11-B-01-composer-image", page);
  await composer(page).press("Enter");

  await expect(lastAgent(page)).toContainText("MOCK: 这张图里是什么【图片 1：截图.png】 [images: 1]", { timeout: 30_000 });
  await expect(thumb).toHaveCount(0);
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-images").locator("img")).toHaveCount(1);
  // The thumbnail really loads from the Host (?token=).
  await expect.poll(() => bubble.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await screenshot(studio.app, "stage-11", "S11-B-02-transcript-image", page);

  const opened = studio.app.waitForEvent("window");
  await bubble.getByTitle("查看大图").click();
  const viewer = await opened;
  await expect(viewer.getByTestId("file-preview-image")).toBeVisible();
  await expect.poll(() => viewer.getByTestId("file-preview-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await viewer.close();

  // An image alone, without text, can be sent too.
  await pasteImage(page);
  await expect(thumb).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(lastAgent(page)).toContainText("[images: 1]", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user").last().locator(".msg-text img")).toHaveCount(1);
});

test("pastes an image into the new-task page: it goes with the first sentence (2026-10-19)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  const first = page.getByLabel("第一句话");
  await first.fill("这张图里是什么");
  await pasteImage(page, "截图.png", first);
  const thumb = first.locator(".resource-image");
  await expect(thumb).toHaveAttribute("data-state", "ready");
  await thumb.getByRole("button", { name: /查看大图.*截图\.png/ }).click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await page.getByTestId("lightbox").click();
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  // Filing in 待办 does not take images.
  await first.press("Control+Enter");
  await expect(page.getByRole("alert")).toContainText("放进待办不带图片");
  await screenshot(studio.app, "stage-18", "S18-newtask-image", page);
  await first.press("Enter");

  await expect(lastAgent(page)).toContainText("MOCK: 这张图里是什么【图片 1：截图.png】 [images: 1]", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user").first().getByTestId("msg-images").locator("img")).toHaveCount(1);
  // The page is empty again for the next task.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByTestId("inline-resource")).toHaveCount(0);
});

for (const start of ["button", "Enter"] as const) {
  test(`starts a new task with only an image via ${start} (2026-11-06)`, async () => {
    studio = await launchStudio();
    const { page } = studio;
    await page.getByRole("button", { name: "+ 新任务" }).click();
    await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
    const first = page.getByLabel("第一句话");
    await first.fill(start === "button" ? "   " : "");
    await pasteImage(page, "截图.png", first);
    await expect(first.locator(".resource-image")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("draft-start")).toBeEnabled();
    if (start === "button") await screenshot(studio.app, "studio", "newtask-image-only", page);
    if (start === "button") await page.getByTestId("draft-start").click();
    else await first.press("Enter");

    await expect(page.getByTestId("task-title")).toBeVisible();
    await expect(lastAgent(page)).toContainText("[images: 1]", { timeout: 30_000 });
    const bubble = page.getByTestId("msg-user").first();
    await expect(bubble.locator(".msg-text img")).toHaveCount(1);
    await expect(bubble.getByTestId("msg-images").locator("img")).toHaveCount(1);
    if (start === "button") await screenshot(studio.app, "studio", "newtask-image-only-sent", page);
    await page.getByRole("button", { name: "+ 新任务" }).click();
    await expect(first).toHaveText("");
    await expect(page.getByTestId("inline-resource")).toHaveCount(0);
    // Empty input still cannot start, including after its last image is removed.
    await pasteImage(page, "多余.png", first);
    await page.getByRole("button", { name: /移除.*多余\.png/ }).click();
    await page.getByTestId("draft-start").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveCount(0);
  });
}

test("an image-only new task waits for upload and refuses a failed image (2026-11-06)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const upload = new Promise<import("@playwright/test").Route>((resolve) => {
    void page.route("**/api/attachments?*", resolve);
  });
  await pasteImage(page, "截图.png", page.getByLabel("第一句话"));
  const route = await upload;
  await expect(page.getByTestId("inline-resource")).toHaveAttribute("data-state", "uploading");
  await page.getByTestId("draft-start").click();
  await expect(page.getByRole("alert")).toContainText("图片还在上传");
  await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "upload rejected" } }) });
  await expect(page.getByTestId("inline-resource")).toHaveAttribute("data-state", "failed");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByRole("alert")).toContainText("有图片上传失败");
  await expect(page.getByTestId("task-title")).toHaveCount(0);
});

test("drops an image and a file from disk: thumbnail, file reference, both in the transcript", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  const png = join(dir, "diagram.png");
  const doc = join(dir, "notes.md");
  writeFileSync(png, Buffer.from(TINY_PNG_BASE64, "base64"));
  writeFileSync(doc, "# notes\n");
  await openTask(studio, dir);

  await composer(page).fill("对照一下");
  await dropFiles(page, [png, doc]);
  await expect(composer(page).locator(".resource-image")).toHaveAttribute("data-state", "ready");
  const chip = composer(page).locator(".resource-file");
  await expect(chip).toContainText("notes.md");
  await expect(chip).toHaveAttribute("title", doc);
  await screenshot(studio.app, "stage-11", "S11-B-03-composer-drop", page);
  await composer(page).press("Enter");

  await expect(lastAgent(page)).toContainText("[images: 1]", { timeout: 30_000 });
  // The mock echoes the text it got: the reference block went to the model.
  await expect(lastAgent(page)).toContainText("引用文件：");
  await expect(lastAgent(page)).toContainText("notes.md");
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.locator(".msg-text")).toContainText("对照一下");
  await expect(bubble.locator(".msg-text img")).toHaveCount(1);
  await expect(bubble.getByTestId("msg-file")).toContainText("notes.md");
  await screenshot(studio.app, "stage-11", "S11-B-04-transcript-files", page);
});

test("@ offers tasks, sessions and recent files; 找文件… and Ctrl+P open the file selector", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "app", "main.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "importer.py"), "import requests\n");
  writeFileSync(join(dir, "README.md"), "# alpha\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "README.md"), "# alpha, changed\n");
  writeFileSync(join(dir, "src", "new_feature.ts"), "");
  const { task } = await openTask(studio, dir);
  await studio.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", text: "摸底" });
  await page.getByTestId("session-row").filter({ hasText: "hello" }).click();

  const suggest = page.getByTestId("suggest");
  await composer(page).pressSequentially("@");
  await expect(suggest).toContainText("任务");
  await expect(suggest.getByRole("option", { name: /摸底/ })).toBeVisible();
  await expect(suggest).toContainText("最近改动的文件");
  await expect(suggest.getByRole("option", { name: /README\.md/ })).toBeVisible();
  await expect(suggest.getByRole("option", { name: /new_feature\.ts/ })).toBeVisible();
  // 找文件… ends the files; 「AMO 扩展功能」 come last (10-26), 提示词模板… (10-31) at the end.
  await expect(suggest.locator('[data-kind="find"] + .suggest-h')).toHaveText("AMO 扩展功能");
  await expect(suggest.getByRole("option").last()).toContainText("提示词模板…");
  await expect(suggest.locator('[data-kind="commit"]')).toContainText("快速提交");
  await screenshot(studio.app, "stage-11", "S11-B-05-at-menu", page);

  // A session keeps its name in the text; the message will say which session it is.
  await composer(page).pressSequentially("摸");
  await expect(suggest.getByRole("option").first()).toContainText("摸底");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveText("@摸底 ");
  // A file becomes a reference chip, and its @ text goes away.
  await composer(page).pressSequentially("看 @");
  await suggest.getByRole("option", { name: /README\.md/ }).click();
  await expect(composer(page).locator(".resource-file")).toHaveAttribute("title", join(dir, "README.md"));
  await expect(composer(page)).toContainText("@摸底 看 ");
  // The picked name is coloured in the editor, alongside the inline file reference.
  const token = composer(page).locator(".mention-token");
  await expect(token).toHaveText("@摸底");
  expect(await token.evaluate((el) => getComputedStyle(el).color)).not.toBe(await composer(page).evaluate((el) => getComputedStyle(el).color));
  await expect(composer(page).locator(".resource-file")).toContainText("README.md");
  await screenshot(studio.app, "stage-18", "S18-mention-colour", page);

  // 找文件… opens the selector with what was typed after @.
  await composer(page).pressSequentially("@imp");
  await suggest.getByRole("option", { name: /找文件/ }).click();
  const picker = page.getByTestId("file-picker");
  await expect(picker.getByLabel("找文件")).toHaveValue("imp");
  await expect(picker.getByTestId("file-row").first()).toContainText("src/importer.py");
  await expect(picker.getByTestId("file-row").first().locator("mark")).toHaveText("imp");
  await screenshot(studio.app, "stage-11", "S11-B-06-file-picker", page);
  await picker.getByLabel("找文件").press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(composer(page).locator(".resource-file")).toHaveCount(2);

  // Ctrl+P: the whole list, narrowed as you type; arrows move, Esc closes.
  await composer(page).press("Control+p");
  await expect(picker.getByTestId("file-row")).toHaveCount(4);
  await expect(picker.getByTestId("file-row").first()).toHaveAttribute("aria-selected", "true");
  await picker.getByLabel("找文件").press("ArrowDown");
  await expect(picker.getByTestId("file-row").nth(1)).toHaveAttribute("aria-selected", "true");
  await picker.getByLabel("找文件").fill("app main");
  await expect(picker.getByTestId("file-row")).toHaveCount(1);
  await expect(picker.getByTestId("file-row").first()).toContainText("src/app/main.ts");
  await picker.getByLabel("找文件").press("Escape");
  await expect(picker).toHaveCount(0);

  await composer(page).press("Enter");
  await expect(lastAgent(page)).toContainText("AMO 会话", { timeout: 30_000 });
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-file")).toHaveCount(2);
  await expect(bubble.getByTestId("msg-file").first()).toContainText("README.md");
  await expect(bubble.getByTestId("msg-file").last()).toContainText("importer.py");
});

test("@ 开子会话…: the model's own options, its usage and this round's words; 「@子会话·模型·强度」 in the text; the setup goes to the Host (2026-11-05)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  const { session } = await openTask(studio, dir);
  // 设置 → 子会话: per model, its usage note and its defaults as a sub-session (2026-11-05).
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(settingsDialog, "子会话");
  // A 版分栏：顶部选渠道，左侧选通用设置，右侧只显示当前配置。
  const channel = settingsDialog.locator(`[data-testid="subsession-channel"][data-profile="${session.profileId}"]`);
  await channel.click();
  const common = settingsDialog.locator('[data-testid="subsession-chip"][data-model=""]');
  await common.click();
  await expect(common).toHaveAttribute("aria-current", "page");
  await expect(settingsDialog.getByTestId("subsession-note-text")).toBeVisible();
  await settingsDialog.getByTestId("subsession-note-text").fill("适合照计划改代码");
  await settingsDialog.getByTestId("subsession-note-text").blur();
  await expect.poll(async () => (await studio!.api<{ subsessionNotes: Array<{ note: string }> }>("GET", "/api/settings")).subsessionNotes.map((n) => n.note)).toEqual(["适合照计划改代码"]);
  await expect(common).toHaveAttribute("aria-pressed", "true");
  // Its default permission, saved at once.
  await settingsDialog.getByTestId("subsession-defaults").getByRole("button", { name: "完全访问", exact: true }).click();
  await expect.poll(async () => (await studio!.api<{ subsessionNotes: Array<{ permission?: string }> }>("GET", "/api/settings")).subsessionNotes.map((n) => n.permission)).toEqual(["full"]);
  await screenshot(studio.app, "studio", "subsession-settings", page);
  await settingsDialog.getByRole("button", { name: "关闭设置" }).click();
  const suggest = page.getByTestId("suggest");
  await composer(page).pressSequentially("接下来开子会话就用 @");
  // Under「AMO 扩展功能」(10-26), after 找文件….
  await expect(suggest.getByText("AMO 扩展功能")).toBeVisible();
  await expect(suggest.getByRole("option").last()).toContainText("提示词模板…");
  await suggest.getByRole("option", { name: /开子会话…/ }).click();
  const dialog = page.getByTestId("subsession-dialog");
  await expect(dialog).toBeVisible();
  await expect(composer(page)).toHaveText("接下来开子会话就用 ");
  // The session's model, starting from its defaults: the usage note shown, the permission from 设置 → 子会话.
  await expect(dialog.getByTestId("subsession-note")).toContainText("适合照计划改代码");
  await expect(dialog.locator(".subsession-more summary")).toContainText("现在：完全放开");
  await expect(dialog.getByTestId("subsession-report")).toHaveCount(0);
  // The mock Codex model has a Fast tier: Codex's own words, not Claude's billing note.
  await expect(dialog.getByTestId("subsession-fast")).not.toBeChecked();
  await expect(dialog.locator(".subsession-cost")).toHaveCount(0);
  await dialog.getByTestId("subsession-extra").fill("只改数值表，改完跑校验");
  await expect(dialog.getByTestId("subsession-preview")).toContainText(/@子会话·.+·默认强度$/);
  await screenshot(studio.app, "studio", "subsession-dialog", page);
  // A Claude model with fast mode: its Fast, saying it is billed as extra usage. The words stay.
  await dialog.getByRole("button", { name: /mock-claude/ }).first().click();
  await expect(dialog.getByTestId("subsession-fast")).toBeVisible();
  await expect(dialog.locator(".subsession-cost")).toContainText("按额外用量");
  await dialog.getByTestId("subsession-fast").check();
  await expect(dialog.getByTestId("subsession-preview")).toContainText(/@子会话·.+·默认强度·Fast$/);
  await expect(dialog.getByTestId("subsession-extra")).toHaveValue("只改数值表，改完跑校验");
  await screenshot(studio.app, "studio", "subsession-dialog-claude-fast", page);
  await dialog.getByTestId("subsession-ok").click();
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toHaveText(/^接下来开子会话就用 @子会话·.+·默认强度·Fast $/);
  const tag = (await composer(page).textContent())!.slice("接下来开子会话就用 @".length).trim();
  await expect(composer(page).locator(".mention-token")).toHaveText(`@${tag}`);
  await screenshot(studio.app, "studio", "subsession-composer-tag", page);
  const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/sessions/${session.id}/messages`));
  await composer(page).press("Enter");
  expect((await posted).postDataJSON().subsessions).toEqual([{ name: tag, profileId: expect.stringMatching(/claude/), model: null, fast: true, extra: "只改数值表，改完跑校验" }]);
  await expect
    .poll(async () => (await studio!.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)?.text ?? "", { timeout: 15_000 })
    .toContain("子会话的设定（人设好的子会话：要开时用 AMO 的 session_start 带 setup");
  const sent = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!.text!;
  expect(sent).toContain(`- @${tag}：session_start 带 setup: "${tag}"`);
  expect(sent).not.toContain("report");
  // In the conversation: the tag coloured, the line under it says what was attached.
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-mention")).toHaveText([`@${tag}`]);
  await expect(bubble.getByTestId("msg-mention-brief")).toHaveText("AMO：已附上子会话设定");
  await screenshot(studio.app, "studio", "subsession-sent", page);
});

test("快速提交 (10-26): from @ or Ctrl+Shift+P, a choice of pushing too; the message tells how to commit, pull and merge", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { session } = await openTask(studio, studio.workspace("alpha"));
  const suggest = page.getByTestId("suggest");
  const dialog = page.getByTestId("quickcommit-dialog");
  await composer(page).pressSequentially("改完了 @");
  await suggest.getByRole("option", { name: /快速提交/ }).click();
  await expect(dialog).toBeVisible();
  // The first choice (no push) is the default; Esc puts nothing in.
  await expect(dialog.getByRole("radio").first()).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toHaveText("改完了 ");

  await composer(page).press("Control+Shift+P");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("2");
  await expect(dialog.getByRole("radio").nth(1)).toBeChecked();
  await screenshot(studio.app, "stage-18", "S18-quick-commit", page);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toHaveText("改完了 @快速提交 ");
  await expect(composer(page).locator(".mention-token")).toHaveText("@快速提交");
  await composer(page).press("Enter");
  await expect
    .poll(async () => (await studio!.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)?.text ?? "", { timeout: 15_000 })
    .toContain("「@快速提交」是人要你现在做的事");
  const sent = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!.text!;
  expect(sent).toContain("git push 到上游");
  // In the conversation (2026-10-28): 「@快速提交」 coloured as in the composer, the instructions behind a tag.
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-mention")).toHaveText("@快速提交");
  await expect(bubble.locator(".msg-text")).toHaveText("改完了 @快速提交");
  await expect(bubble.getByTestId("msg-mention-brief")).toHaveText("快速提交 · 提交、合并并推送");
  await expect(bubble.getByTestId("msg-mention-brief")).toHaveAttribute("title", /是人要你现在做的事/);
  await screenshot(studio.app, "stage-18", "S18-quick-commit-sent", page);
});
