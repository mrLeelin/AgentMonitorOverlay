import { selectSettingsPage } from "../support/settings.js";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import type { StudioSettings, SubsessionNote } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function openSettings(s: Studio) {
  await s.page.evaluate(() => {
    localStorage.setItem("amo.settings.size", JSON.stringify({ w: 896, h: 640 }));
    document.documentElement.dataset.theme = "dark";
  });
  await s.page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = s.page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(dialog, "子会话");
  return dialog;
}
const channel = (dialog: Locator, id: string) => dialog.locator(`[data-testid="subsession-channel"][data-profile="${id}"]`);
const model = (dialog: Locator, id: string | null) => dialog.locator(`[data-testid="subsession-chip"][data-model="${id ?? ""}"]`);
const notes = async () => (await studio!.api<StudioSettings>("GET", "/api/settings")).subsessionNotes;
const noteFor = async (profileId: string, model: string | null) => (await notes()).find((n) => n.profileId === profileId && n.model === model);

test("subsession split editor saves blur plus immediate option change and keeps channel/model defaults separate", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const initial: SubsessionNote[] = [{ profileId: "claude-mock", model: null, note: "交代时写清文件范围与验收方式。", permission: "write", fast: true }];
  await studio.api("PUT", "/api/settings", { subsessionNotes: initial });
  const dialog = await openSettings(studio);
  await channel(dialog, "claude-mock").click();
  await model(dialog, "mock-claude-b").click();
  await expect(dialog.getByTestId("subsession-note")).toHaveAttribute("data-model", "mock-claude-b");
  await expect(dialog.locator(".subsession-inherited-note")).toContainText(initial[0]!.note);
  await expect(dialog.getByRole("group", { name: "子会话默认权限" }).getByRole("button", { name: "沿用默认", exact: true })).toHaveAttribute("aria-pressed", "true");

  let delayed = false;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT" && !delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  // 点击权限先触发 textarea blur，紧接着又发一个保存；两次必须在最新结果上合并。
  await dialog.getByTestId("subsession-note-text").fill("只读审查，列出问题与证据。");
  await dialog.getByRole("group", { name: "子会话默认权限" }).getByRole("button", { name: "只读", exact: true }).click();
  await expect.poll(() => noteFor("claude-mock", "mock-claude-b")).toEqual({ profileId: "claude-mock", model: "mock-claude-b", note: "只读审查，列出问题与证据。", permission: "read-only" });
  expect(await noteFor("claude-mock", null)).toEqual(initial[0]);
  await expect(model(dialog, "mock-claude-b")).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("思考强度", { exact: true }).selectOption("high");
  await expect.poll(async () => (await noteFor("claude-mock", "mock-claude-b"))?.effort).toBe("high");
  await screenshot(app, "studio", "subsession-layout-a-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "subsession-layout-a-light", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  await model(dialog, null).click();
  const fast = dialog.getByTestId("subsession-default-fast");
  await fast.getByRole("button", { name: "关闭", exact: true }).click();
  await expect.poll(async () => (await noteFor("claude-mock", null))?.fast).toBe(false);
  await fast.getByRole("button", { name: "沿用默认", exact: true }).click();
  await expect.poll(async () => (await noteFor("claude-mock", null))?.fast).toBeUndefined();
  expect((await noteFor("claude-mock", null))?.permission).toBe("write");
  await model(dialog, "mock-claude-b").click();
  await dialog.getByRole("button", { name: "恢复默认选项", exact: true }).click();
  await expect.poll(() => noteFor("claude-mock", "mock-claude-b")).toEqual({ profileId: "claude-mock", model: "mock-claude-b", note: "只读审查，列出问题与证据。" });
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  const reopened = await openSettings(studio);
  await channel(reopened, "claude-mock").click();
  await model(reopened, "mock-claude-b").click();
  await expect(reopened.getByTestId("subsession-note-text")).toHaveValue("只读审查，列出问题与证据。");
});

test("subsession navigation and search do not save empty rows; retired configuration remains editable and can be cleared alone", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const initial: SubsessionNote[] = [
    { profileId: "claude-mock", model: "retired-model", note: "旧型号说明", permission: "read-only" },
    { profileId: "codex-mock", model: null, note: "保留其他渠道的配置" },
    { profileId: "claude-mock", model: "mock-claude", note: "原型号说明" },
  ];
  await studio.api("PUT", "/api/settings", { subsessionNotes: initial });
  const dialog = await openSettings(studio);
  const writes: unknown[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/settings")) writes.push(request.postDataJSON()); });
  await channel(dialog, "claude-mock").click();
  await model(dialog, "mock-claude-b").click();
  await dialog.getByRole("searchbox", { name: "搜索子会话型号" }).fill("no-such-model");
  await expect(dialog.getByText("没有匹配的型号", { exact: true })).toBeVisible();
  await dialog.getByRole("searchbox", { name: "搜索子会话型号" }).fill("retired");
  await expect(model(dialog, "retired-model")).toContainText("已不在型号列表");
  await model(dialog, "retired-model").click();
  await expect(dialog.getByTestId("subsession-note-text")).toHaveValue("旧型号说明");
  expect(writes).toEqual([]);
  expect(await notes()).toEqual(initial);
  await dialog.getByTestId("subsession-note-remove").click();
  await expect.poll(notes).toEqual([initial[1], initial[2]]);
  await expect(model(dialog, "retired-model")).toHaveCount(0);
  await dialog.getByRole("searchbox", { name: "搜索子会话型号" }).fill("mock-claude");
  // 型号成为默认后，原先以型号 id 保存的历史条目仍须可达，不能混进 model:null。
  await expect(model(dialog, "mock-claude")).toContainText("原型号设置（现为默认）");
  await model(dialog, "mock-claude").click();
  await expect(dialog.getByTestId("subsession-note-text")).toHaveValue("原型号说明");
  await dialog.getByTestId("subsession-note-remove").click();
  await expect.poll(notes).toEqual([initial[1]]);
  await expect(model(dialog, "mock-claude")).toHaveCount(0);
  await channel(dialog, "codex-mock").click();
  await expect(dialog.getByTestId("subsession-note-text")).toHaveValue("保留其他渠道的配置");
});

test("subsession save failure keeps the draft for the queued option update and clears the error on recovery", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dialog = await openSettings(studio);
  await channel(dialog, "claude-mock").click();
  await model(dialog, "mock-claude-b").click();
  let writes = 0;
  let allowSuccess: () => void = () => {};
  const recovered = new Promise<void>((resolve) => { allowSuccess = resolve; });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    if (writes === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "模拟保存失败" } } });
    }
    await recovered;
    await route.continue();
  });
  await dialog.getByTestId("subsession-note-text").fill("失败后仍要保留的说明");
  await dialog.getByRole("group", { name: "子会话默认权限" }).getByRole("button", { name: "只读", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("模拟保存失败");
  allowSuccess();
  await expect.poll(() => noteFor("claude-mock", "mock-claude-b")).toEqual({ profileId: "claude-mock", model: "mock-claude-b", note: "失败后仍要保留的说明", permission: "read-only" });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByTestId("subsession-note-text")).toHaveValue("失败后仍要保留的说明");
  expect(writes).toBe(2);
});

test("subsession Pi only permits inherited or full access in the split editor", async () => {
  const agent = fileURLToPath(new URL("../../packages/testkit/scripts/mock-pi.mjs", import.meta.url));
  studio = await launchStudio({ env: { AMO_STUDIO_TEST_PI_AGENT: agent } });
  const dialog = await openSettings(studio);
  await channel(dialog, "pi").click();
  const permissions = dialog.getByRole("group", { name: "子会话默认权限" });
  await expect(permissions.getByRole("button", { name: "只读", exact: true })).toBeDisabled();
  await expect(permissions.getByRole("button", { name: "可写", exact: true })).toBeDisabled();
  await permissions.getByRole("button", { name: "完全访问", exact: true }).click();
  await expect.poll(async () => (await noteFor("pi", null))?.permission).toBe("full");
  await screenshot(studio.app, "studio", "subsession-layout-a-pi", studio.page);
  await permissions.getByRole("button", { name: "沿用默认", exact: true }).click();
  await expect.poll(notes).toEqual([]);
});
