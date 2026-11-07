import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a running card animates its runner, respects reduced motion and removes it when stopped", async () => {
  studio = await launchStudio({ dsh: true });
  const { page } = studio;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "校验掉落表",
    workspaceId: ws.id,
    firstSession: { profileId: "dsh-mock", text: "[[slow]]" },
  });
  await page.getByTestId("scope-all").click();
  const card = page.locator(`[data-task-id="${task.id}"]`);
  const runner = card.locator(".card-runner");
  await expect(card.locator(".card-status")).toContainText("运行中");
  await expect(runner).toBeVisible();
  await expect(runner).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => runner.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(5);
  // Sample two poses deterministically, including in the hidden Electron window.
  const poses: string[] = [];
  for (const time of [0, 320]) {
    poses.push(await runner.evaluate((el, ms) => {
      for (const animation of el.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = ms;
      }
      return getComputedStyle(el.querySelector(".card-runner-leg")!).transform;
    }, time));
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(studio.app, "studio", `board-runner-dark-${time}`, page);
  }
  expect(poses[0]).not.toBe(poses[1]);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(studio.app, "studio", "board-runner-light", page);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => runner.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(runner).toBeVisible();
  await studio.api("POST", `/api/sessions/${session.id}/interrupt`, {});
  await expect(runner).toHaveCount(0);
  await expect(card.locator(".card-status")).not.toContainText("运行中");
});
