import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function paste(input: Locator, text?: string, image?: string) {
  await input.evaluate((el, { text, image, b64 }) => {
    const data = new DataTransfer();
    if (image) data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], image, { type: "image/png" }));
    if (text) data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { text, image, b64: TINY_PNG_BASE64 });
}

async function caret(input: Locator, text: string, offset: number) {
  await input.evaluate((el, { text, offset }) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walk.nextNode())) {
      if (node.textContent === text) {
        (el as HTMLElement).focus();
        const range = document.createRange();
        range.setStart(node, offset); range.collapse(true);
        const selection = window.getSelection()!;
        selection.removeAllRanges(); selection.addRange(range);
        el.dispatchEvent(new Event("select", { bubbles: true }));
        return;
      }
    }
    throw new Error(`Text node not found: ${text}`);
  }, { text, offset });
}

async function newDraft() {
  studio = await launchStudio();
  const page = studio.page;
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  return { page, input: page.getByLabel("第一句话") };
}

test("inserts images, URLs and files at the caret and sends the matching real attachments", async () => {
  const { page, input } = await newDraft();
  const text = "参考这张图，使用这个网址，再看这个文件。";
  await input.fill(text);
  await caret(input, text, 5);
  await paste(input, undefined, "设计稿.png");
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await expect(input).not.toContainText("[[amo:");
  await expect.poll(() => input.evaluate((el) => el.childNodes[0]?.textContent)).toBe("参考这张图");
  await caret(input, "，使用这个网址，再看这个文件。", 7);
  await paste(input, "https://example.com/design?q=中文");
  await caret(input, "，再看这个文件。", 7);
  const file = join(studio!.workspace("assets"), "配置[最终].json");
  writeFileSync(file, '{"retry":3}');
  await page.getByTestId("draft-attach-input").setInputFiles(file);
  await expect(input.getByTestId("inline-resource")).toHaveCount(3);
  await expect(input).toContainText("example.com");
  await screenshot(studio!.app, "studio", "inline-resources-draft", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(studio!.app, "studio", "inline-resources-draft-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await input.getByRole("button", { name: /查看大图/ }).click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await input.press("Enter");
  const sent = page.getByTestId("msg-user").first();
  await expect(sent.locator(".msg-text .msg-images img")).toHaveCount(1);
  await expect(sent.locator(".msg-text").getByTestId("msg-file")).toContainText("配置[最终].json");
  await expect(sent.locator(".msg-url")).toHaveAttribute("title", "https://example.com/design?q=中文");
  const agent = page.getByTestId("msg-agent").last();
  await expect(agent).toContainText("[images: 1]", { timeout: 30_000 });
  await expect(agent).toContainText("文中资源 1");
  await expect(agent).toContainText(file);
  await expect(agent).not.toContainText("[[amo:");
  await screenshot(studio!.app, "studio", "inline-resources-sent", page);
});

test("deletes a whole image, undoes it, and keeps the caret when an upload finishes", async () => {
  const { page, input } = await newDraft();
  let release!: () => void;
  const uploadGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/attachments?*", async (route) => { await uploadGate; await route.continue(); });
  await input.fill("前后");
  await caret(input, "前后", 1);
  await paste(input, undefined, "等待.png");
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "uploading");
  await input.pressSequentially("这里");
  release();
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await input.pressSequentially("继续");
  await expect(input).toContainText("这里继续后");
  await caret(input, "这里继续后", 0);
  await input.press("Backspace");
  await expect(input.getByTestId("inline-resource")).toHaveCount(0);
  await input.press("Control+z");
  await expect(input.getByTestId("inline-resource")).toHaveCount(1);
  await input.getByRole("button", { name: /移除.*等待/ }).click();
  await expect(input.getByTestId("inline-resource")).toHaveCount(0);
  await input.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 前这里继续后", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user").first().locator("img")).toHaveCount(0);
});

test("restores ready images with a saved draft and refuses a failed image until removed", async () => {
  const { page, input } = await newDraft();
  await input.fill("保留这张图");
  await paste(input, undefined, "保留.png");
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await page.reload();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await page.route("**/api/attachments?*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "upload rejected" } }) }));
  await paste(input, undefined, "失败.png");
  await expect(input.locator('[data-state="failed"]')).toHaveCount(1);
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("有图片上传失败");
  await input.getByRole("button", { name: /移除.*失败/ }).click();
  await input.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("[images: 1]", { timeout: 30_000 });
});

test("session composer keeps @ completion, multiline text, and IME Enter from submitting", async () => {
  const { page, input } = await newDraft();
  await input.fill("开始");
  await input.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 开始", { timeout: 30_000 });
  const message = page.getByLabel("输入消息");
  await message.fill("中文");
  await message.dispatchEvent("compositionstart", { data: "" });
  await message.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page.getByTestId("msg-user")).toHaveCount(1);
  await message.dispatchEvent("compositionend", { data: "中文" });
  await message.press("Shift+Enter");
  await message.pressSequentially("下一行 ");
  await paste(message, "https://example.com");
  await message.pressSequentially(" @");
  await expect(page.getByTestId("suggest")).toBeVisible();
  await message.press("Escape");
  await screenshot(studio!.app, "studio", "inline-resources-thread", page);
  await message.press("Enter");
  await expect(page.getByTestId("msg-user").last()).toContainText("下一行");
  await expect(page.getByTestId("msg-user").last().locator(".msg-url")).toHaveAttribute("title", "https://example.com");
});

test("switching between two nonempty session drafts cannot undo into the other session", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const created = await studio.api<{ task: { id: string } }>("POST", "/api/tasks", { title: "草稿隔离", firstSession: { profileId: "codex-mock", text: "会话甲" } });
  await studio.api("POST", `/api/tasks/${created.task.id}/sessions`, { profileId: "codex-mock", text: "会话乙" });
  await page.getByTestId("task-card").filter({ hasText: "草稿隔离" }).click();
  const input = page.getByLabel("输入消息");
  await page.getByTestId("session-row").filter({ hasText: "会话甲" }).click();
  await input.fill("甲的草稿");
  await page.getByTestId("session-row").filter({ hasText: "会话乙" }).click();
  await input.fill("乙的草稿");
  await page.getByTestId("session-row").filter({ hasText: "会话甲" }).click();
  await expect(input).toHaveText("甲的草稿");
  await input.press("Control+z");
  await expect(input).toHaveText("甲的草稿");
  await page.getByTestId("session-row").filter({ hasText: "会话乙" }).click();
  await expect(input).toHaveText("乙的草稿");
  await input.press("Control+z");
  await expect(input).toHaveText("乙的草稿");
});

test("stopping and resending an unanswered message restores its actual image", async () => {
  const { page, input } = await newDraft();
  await input.fill("开始");
  await input.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 开始", { timeout: 30_000 });
  const message = page.getByLabel("输入消息");
  await message.fill("等一下 [[wait]] ");
  await paste(message, undefined, "重发.png");
  await expect(message.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await message.press("Enter");
  await expect(page.getByTestId("msg-user").last().locator("img")).toHaveCount(1);
  await page.getByRole("button", { name: "打断", exact: true }).click();
  await expect(message.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible({ timeout: 30_000 });
  // Remove the mock's wait command while preserving the restored resource.
  await caret(message, "等一下 [[wait]] ", 0);
  await message.press("Delete");
  const posted = page.waitForRequest((r) => r.method() === "POST" && /\/sessions\/[^/]+\/messages/.test(r.url()));
  await message.press("Enter");
  expect((await posted).postDataJSON().attachments).toHaveLength(1);
});

test("URL drag and structured copy keep real references without leaking markers to plain text", async () => {
  const { input } = await newDraft();
  await input.fill("前后");
  await caret(input, "前后", 1);
  await input.evaluate((el) => {
    const data = new DataTransfer(); data.setData("text/uri-list", "https://example.com/reference");
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(input.getByTestId("inline-resource")).toHaveCount(1);
  const copied = await input.evaluate((el) => {
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(el);
    selection.removeAllRanges(); selection.addRange(range);
    const data = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData("text/plain"), raw: data.getData("application/x-amo-composer-text") };
  });
  expect(copied.text).toBe("前https://example.com/reference后");
  expect(copied.raw).toContain("[[amo:url:");
  await input.press("End");
  await input.evaluate((el, copied) => {
    const data = new DataTransfer(); data.setData("text/plain", copied.text); data.setData("application/x-amo-composer-text", copied.raw);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, copied);
  await expect(input.getByTestId("inline-resource")).toHaveCount(2);
  await input.getByTestId("inline-resource").last().getByRole("button", { name: /移除/ }).click();
  await expect(input.getByTestId("inline-resource")).toHaveCount(1);
});

test("plan feedback expands URL references and preserves unsupported pictures", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page } = studio;
  await studio.api("POST", "/api/tasks", { title: "计划资源", firstSession: { profileId: "claude-mock", text: "[[plan]] 先出一个计划", options: { permission: "plan" } } });
  await page.getByTestId("task-card").filter({ hasText: "计划资源" }).click();
  const plan = page.getByTestId("plan-card").first();
  await expect(plan).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  const input = page.getByLabel("输入消息");
  await input.fill("参考这里");
  await paste(input, "https://example.com/plan");
  await paste(input, undefined, "计划.png");
  await expect(input.locator('.resource-image')).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "要修改", exact: true }).click();
  await expect(page.getByText(/计划的修改意见暂时不能带图片/)).toBeVisible();
  await expect(input.getByTestId("inline-resource")).toHaveCount(2);
  await expect(plan).toHaveAttribute("data-state", "pending");
  await input.getByRole("button", { name: /移除.*计划.png/ }).click();
  const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/questions/") && r.url().includes("/answer"));
  await page.getByRole("button", { name: "要修改", exact: true }).click();
  expect((await posted).postDataJSON().feedback).toBe("参考这里https://example.com/plan");
  await expect(plan).toHaveAttribute("data-revised", "");
});

test("failed sending restores both the inline picture and a newer draft", async () => {
  const { page, input } = await newDraft();
  await input.fill("开始"); await input.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 开始", { timeout: 30_000 });
  const message = page.getByLabel("输入消息");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/sessions/*/messages", async (route) => {
    await gate;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "send rejected" } }) });
  });
  await message.fill("原来的消息");
  await paste(message, undefined, "原图.png");
  await expect(message.locator(".resource-image")).toHaveAttribute("data-state", "ready");
  await message.press("Enter");
  await expect(message).toHaveText("");
  await message.fill("下一条草稿");
  release();
  await expect(message).toContainText("原来的消息");
  await expect(message).toContainText("下一条草稿");
  await expect(message.locator(".resource-image")).toHaveAttribute("data-state", "ready");
  await page.unroute("**/api/sessions/*/messages");
  const posted = page.waitForRequest((r) => r.method() === "POST" && /\/sessions\/[^/]+\/messages/.test(r.url()));
  await message.press("Enter");
  expect((await posted).postDataJSON().attachments).toHaveLength(1);
});
