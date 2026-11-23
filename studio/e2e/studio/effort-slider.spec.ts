import { expect, test } from "@playwright/test";
import type { ProfileChoices } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("draft slider follows the model's available levels, remembers Ultra and resets to its default", async () => {
  const studio = await launchStudio();
  try {
    const { app, page } = studio;
    // The ordinary mock has only low/high/max; this catalog variant exercises a model that also advertises Ultra.
    await page.route("**/api/profiles/codex-mock/choices", async route => {
      const response = await route.fetch();
      const choices: ProfileChoices = await response.json();
      for (const model of choices.models) {
        model.efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
        model.defaultEffort = "high";
      }
      await route.fulfill({ response, json: choices });
    });
    await page.getByRole("button", { name: "+ 新任务" }).click();
    await page.getByTestId("effort").click();
    const panel = page.getByRole("dialog", { name: "选择推理强度" });
    const slider = panel.getByRole("slider");
    await expect(slider).toBeFocused();
    await expect(slider).toHaveAttribute("aria-valuetext", "高");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const trigger = page.getByTestId("effort");
    const width = (await trigger.boundingBox())!.width;
    const normalColor = await trigger.evaluate(el => getComputedStyle(el).color);
    const fast = panel.getByRole("button", { name: "Fast 加速" });
    await fast.click();
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("fast-toggle")).toHaveAttribute("aria-pressed", "true");
    await screenshot(app, "studio", "effort-picker-normal", page);
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
    await expect(panel).toHaveAttribute("data-highest", "true");
    expect((await trigger.boundingBox())!.width).toBe(width);
    await expect(trigger).toHaveCSS("color", await panel.locator("strong").evaluate(el => getComputedStyle(el).color));
    expect(await trigger.evaluate(el => getComputedStyle(el).color)).not.toBe(normalColor);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const particle = panel.locator(".effort-particle").first();
    const transform = () => particle.evaluate(el => getComputedStyle(el).transform);
    const start = await transform();
    await expect.poll(transform).not.toBe(start);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(particle).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    const edge = (property: string) => trigger.evaluate((el, prop) => getComputedStyle(el, "::before").getPropertyValue(prop), property);
    const closedFrame = await edge("transform");
    await expect.poll(() => edge("transform")).not.toBe(closedFrame);
    await screenshot(app, "studio", "effort-trigger-particles", page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => edge("animation-name")).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    await page.getByTestId("effort").click();
    await expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    for (const [width, theme] of [[1280, "dark"], [960, "light"]] as const) {
      await app.evaluate(({ BrowserWindow }, [url, w]) => { BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url)!.setSize(w, 800); }, [page.url(), width] as const);
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
      await screenshot(app, "studio", `effort-picker-ultra-${theme}`, page);
    }
    await panel.getByRole("button", { name: "恢复模型默认推理强度" }).click();
    await expect(slider).toHaveAttribute("aria-valuetext", "高");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("amo.taskDraft")!).options.effort ?? null)).toBeNull();
    await expect.poll(() => edge("content")).toBe("none");
    await panel.getByTitle("选择模型").click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("model-drawer")).toBeVisible();
  } finally { await studio.close(); }
});
