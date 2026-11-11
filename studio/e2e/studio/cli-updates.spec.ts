import { selectSettingsPage } from "../support/settings.js";
import { expect, test } from "@playwright/test";
import type { MaintenanceCliStatus } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

function installed(cli: MaintenanceCliStatus["cli"]): MaintenanceCliStatus {
  return { cli, name: cli === "claude" ? "Claude Code" : cli === "codex" ? "Codex" : "Pi", path: `C:\\Users\\test\\${cli}.exe`, currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, canUpdate: true, updateCommand: `${cli} update`, state: "idle", message: null };
}

test("CLI list updates only the selected CLI, polls and retains the completed result", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const items = [installed("claude"), installed("codex"), installed("pi")];
  const updates: string[] = [];
  let polls = 0;
  await page.route("**/api/maintenance/clis**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/update")) {
      const { cli } = route.request().postDataJSON() as { cli: string };
      updates.push(cli);
      items[1] = { ...items[1]!, state: "updating", message: "正在更新 Codex…" };
      await route.fulfill({ json: items[1] });
    } else {
      if (items[1]!.state === "updating" && ++polls >= 2) items[1] = { ...items[1]!, currentVersion: "1.1.0", updateAvailable: false, state: "updated", message: "Codex 已更新到 1.1.0" };
      await route.fulfill({ json: { items } });
    }
  });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "维护");
  await expect(dialog.getByTestId("maintenance-mode")).toBeVisible();
  const codex = dialog.getByTestId("cli-update-codex");
  await expect(codex).toContainText("1.0.0");
  await expect(codex).toContainText("有新版本");
  await expect(dialog.getByTestId("cli-update-pi")).toContainText("有新版本");
  await screenshot(app, "studio", "cli-updates-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "cli-updates-light", page);
  await dialog.getByTestId("cli-update-button-codex").click();
  await expect(codex.getByRole("status")).toHaveText("更新中…");
  await expect(dialog.getByTestId("cli-update-button-codex")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
  await expect(codex.getByRole("status")).toHaveText("已更新", { timeout: 10_000 });
  await expect(codex).toContainText("Codex 已更新到 1.1.0");
  expect(updates).toEqual(["codex"]);
  await expect(dialog.getByTestId("cli-update-claude")).toContainText("有新版本");
  await expect(dialog.getByTestId("cli-update-button-codex")).toBeDisabled();
  await selectSettingsPage(dialog, "界面");
  await selectSettingsPage(dialog, "维护");
  await expect(dialog.getByTestId("cli-update-codex").getByRole("status")).toHaveText("已更新");
});

test("Pi update selects only Pi and shows the verified result", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const items = [installed("claude"), installed("codex"), installed("pi")];
  const updates: unknown[] = [];
  let polls = 0;
  await page.route("**/api/maintenance/clis**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/update")) {
      updates.push(route.request().postDataJSON());
      items[2] = { ...items[2]!, state: "updating", message: "正在下载并安装更新…" };
      await route.fulfill({ json: items[2] });
    } else {
      if (items[2]!.state === "updating" && ++polls >= 2) items[2] = { ...items[2]!, state: "updated", currentVersion: "1.1.0", updateAvailable: false, message: "已更新到 1.1.0，重新打开 CLI 后使用新版本。" };
      await route.fulfill({ json: { items } });
    }
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "维护");
  const pi = dialog.getByTestId("cli-update-pi");
  await expect(pi.getByRole("status")).toHaveText("有新版本");
  await dialog.getByTestId("cli-update-button-pi").click();
  await expect(pi.getByRole("status")).toHaveText("更新中…");
  await expect(dialog.getByTestId("cli-update-button-pi")).toBeDisabled();
  await expect(pi.getByRole("status")).toHaveText("已更新", { timeout: 10_000 });
  await expect(pi).toContainText("已更新到 1.1.0");
  await expect(dialog.getByTestId("cli-update-claude").getByRole("status")).toHaveText("有新版本");
  await expect(dialog.getByTestId("cli-update-codex").getByRole("status")).toHaveText("有新版本");
  expect(updates).toEqual([{ cli: "pi" }]);
  await screenshot(app, "studio", "cli-updates-pi-complete", page);
});

test("CLI checks recover from network errors and show missing, current and failed installs", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  let ready = false;
  let requests = 0;
  let failed = false;
  await page.route("**/api/maintenance/clis**", async (route) => {
    requests++;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/check")) ready = true;
    if (!ready) { await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "版本服务器暂时不可用" } } }); return; }
    if (path.endsWith("/update")) {
      failed = true;
      await route.fulfill({ json: { ...installed("claude"), state: "error", message: "更新失败：请检查安装目录权限后重试" } });
      return;
    }
    const claude = { ...installed("claude"), ...(failed ? { state: "error" as const, message: "更新失败：请检查安装目录权限后重试" } : {}) };
    await route.fulfill({ json: { items: [claude, { ...installed("codex"), path: null, currentVersion: null, updateAvailable: false, canUpdate: false, updateCommand: null, message: "没有找到 Codex，请先安装" }, { ...installed("pi"), path: null, currentVersion: null, latestVersion: null, updateAvailable: false, canUpdate: false, updateCommand: null, message: "没有找到 Pi，请先安装" }] } });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "维护");
  await expect(dialog.getByRole("alert")).toContainText("版本服务器暂时不可用");
  await dialog.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(dialog.getByTestId("cli-update-codex").getByRole("status")).toHaveText("未安装");
  await expect(dialog.getByTestId("cli-update-button-codex")).toBeDisabled();
  await expect(dialog.getByTestId("cli-update-pi").getByRole("status")).toHaveText("未安装");
  await expect(dialog.getByTestId("cli-update-button-pi")).toBeDisabled();
  await dialog.getByTestId("cli-update-button-claude").click();
  await expect(dialog.getByTestId("cli-update-claude").getByRole("alert")).toContainText("检查安装目录权限");
  await expect(dialog.getByTestId("cli-update-button-claude")).toBeEnabled();
  await screenshot(app, "studio", "cli-updates-error", page);
  expect(requests).toBeGreaterThanOrEqual(3);
});

test("packaged Studio also lists CLI updates and explains installations it cannot update", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await page.route("**/api/maintenance", (route) => route.fulfill({ json: { mode: "packaged", studioRoot: "C:\\AMO Studio", source: null, claude: null, codex: null } }));
  await page.route("**/api/maintenance/clis**", (route) => route.fulfill({ json: { items: [
    { ...installed("claude"), canUpdate: false, updateCommand: null, message: "这是 Studio 自带的 Claude Code，请通过原安装方式更新" },
    { ...installed("codex"), currentVersion: "1.1.0", updateAvailable: false },
    { ...installed("pi"), latestVersion: null, updateAvailable: false, canUpdate: false, updateCommand: null, message: "未识别到 Pi 的 npm 安装包，请使用原安装方式更新" },
  ] } }));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "维护");
  await expect(dialog.getByTestId("maintenance-mode")).toContainText("便携版");
  await expect(dialog.getByTestId("maintenance-open-claude")).toHaveCount(0);
  await expect(dialog.getByTestId("cli-update-claude")).toContainText("请通过原安装方式更新");
  await expect(dialog.getByTestId("cli-update-button-claude")).toBeDisabled();
  await expect(dialog.getByTestId("cli-update-codex").getByRole("status")).toHaveText("已是最新");
  await expect(dialog.getByTestId("cli-update-button-codex")).toBeDisabled();
  await expect(dialog.getByTestId("cli-update-pi").getByRole("status")).toHaveText("无法检查更新");
  await expect(dialog.getByTestId("cli-update-pi")).toContainText("请使用原安装方式更新");
  await expect(dialog.getByTestId("cli-update-button-pi")).toBeDisabled();
});
