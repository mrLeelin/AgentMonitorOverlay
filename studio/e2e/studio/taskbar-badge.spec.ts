import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
type BadgeWindow = { amo?: { setTaskbarBadge(count: number, image: string | null): void; host(): Promise<unknown> } };
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("taskbar badge follows pending work with Focus closed and clears when handled", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const badge = () => app.evaluate(() => (globalThis as { __amoTaskbarBadge?: { count: number; image: string | null } }).__amoTaskbarBadge);
  await expect.poll(badge).toEqual({ count: 0, image: null });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("badge") });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "任务栏角标验证", workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo badge-approved]]" },
  });
  await expect.poll(async () => (await badge())?.count, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole("button", { name: /^Focus/ })).toHaveAttribute("aria-pressed", "false");
  const image = (await badge())!.image!;
  expect(image).toMatch(/^data:image\/png;base64,/);
  // Preview the actual raster passed to Electron, enlarged alongside the app icon for visual inspection.
  await page.evaluate((src) => {
    const preview = document.createElement("div");
    preview.id = "badge-preview";
    preview.style.cssText = "position:fixed;inset:0;z-index:99999;background:#e5e7eb;display:flex;align-items:center;justify-content:center;gap:40px;color:#303238;font:24px 'Segoe UI'";
    for (const size of [48, 96]) {
      const wrap = document.createElement("div");
      wrap.style.cssText = `position:relative;width:${size}px;height:${size}px`;
      const icon = document.createElement("img");
      icon.src = "./icon.svg";
      icon.style.cssText = "width:100%;height:100%";
      const overlay = document.createElement("img");
      overlay.src = src;
      overlay.style.cssText = "position:absolute;right:-8%;bottom:-8%;width:50%;height:50%";
      wrap.append(icon, overlay);
      preview.append(wrap);
    }
    document.body.append(preview);
  }, image);
  await screenshot(app, "studio", "taskbar-badge-raster-preview", page);
  await page.evaluate(() => document.getElementById("badge-preview")?.remove());

  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1");
  await page.getByRole("button", { name: /^Focus/ }).click();
  await expect.poll(async () => (await badge())?.count).toBe(1);
  // Reload must restore the count without opening Focus.
  await page.reload();
  await expect.poll(async () => (await badge())?.count).toBe(1);
  await page.getByText("任务栏角标验证", { exact: true }).first().click();
  await page.getByRole("button", { name: "批准", exact: true }).first().click();
  await expect.poll(async () => (await badge())?.count, { timeout: 30_000 }).toBe(0);
  expect(await badge()).toEqual({ count: 0, image: null });
  expect(task.id).toBeTruthy();
});

test("taskbar badge rejects malformed updates and secondary windows", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect.poll(() => app.evaluate(() => (globalThis as { __amoTaskbarBadge?: { count: number } }).__amoTaskbarBadge?.count)).toBe(0);
  await focus.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
    (window as unknown as BadgeWindow).amo?.setTaskbarBadge(5, canvas.toDataURL());
  });
  await page.evaluate(() => (window as unknown as BadgeWindow).amo?.host());
  expect(await app.evaluate(() => (globalThis as { __amoTaskbarBadge?: { count: number } }).__amoTaskbarBadge?.count)).toBe(0);
  await page.evaluate(() => {
    const bridge = (window as unknown as BadgeWindow).amo;
    bridge?.setTaskbarBadge(-1, null);
    bridge?.setTaskbarBadge(1.5, null);
    bridge?.setTaskbarBadge(5, "data:image/png;base64,invalid");
  });
  await page.evaluate(() => (window as unknown as BadgeWindow).amo?.host());
  expect(await app.evaluate(() => (globalThis as { __amoTaskbarBadge?: { count: number } }).__amoTaskbarBadge?.count)).toBe(0);
});
