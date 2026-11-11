import { selectSettingsPage } from "../support/settings.js";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot } from "../support/studio.js";
import type { StudioSettings } from "@amo-studio/protocol";

test("network settings validate, save, reload and test without changing the saved choice", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await selectSettingsPage(dialog, "网络");
    await expect(dialog.getByLabel("连接方式")).toHaveValue("inherit");
    await dialog.getByLabel("连接方式").selectOption("manual");
    await dialog.getByLabel("代理地址").fill("bad");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("请输入完整代理地址");
    await dialog.getByLabel("代理地址").fill("http://127.0.0.1:7890");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("已保存");
    await dialog.getByRole("button", { name: "应用到空闲 Codex 后台", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("已释放空闲 Codex 后台");
    await screenshot(app, "studio", "settings-network", page);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await selectSettingsPage(page.getByRole("dialog", { name: "设置", exact: true }), "网络");
    await expect(page.getByLabel("代理地址")).toHaveValue("http://127.0.0.1:7890");
    await page.getByLabel("代理地址").fill("bad");
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("请输入完整代理地址");
    const saved = await studio.api<StudioSettings>("GET", "/api/settings");
    expect(saved.network).toEqual({ mode: "manual", proxyUrl: "http://127.0.0.1:7890" });
  } finally { await studio.close(); }
});
