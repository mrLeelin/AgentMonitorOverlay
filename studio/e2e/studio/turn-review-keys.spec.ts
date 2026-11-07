import { expect, test } from "@playwright/test";
import type { SessionItem, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("turn review arrows follow the visible file order, reveal the selection and leave comment editing alone", async () => {
  studio = await launchStudio({ mockModel: false });
  const { app, page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("turn-review") });
  const paths = Array.from({ length: 40 }, (_, i) => `src/File-${String(i).padStart(2, "0")}.ts`);
  // Recorded edits are in first-touched order; navigation follows the sorted list on screen.
  const items: SessionItem[] = [{
    id: "edit", sessionId: "recorded", seq: 1, createdAt: "2026-11-07T00:00:00Z",
    type: "tool", name: "edit", kind: "edit", summary: "recorded changes", status: "completed",
    files: [...paths].reverse().map((path) => ({ path, change: "update", added: 1, removed: 1, diff: `@@ -1 +1 @@\n-old\n+${path}` })),
  }];
  await app.context().route("**/api/sessions/recorded/items", (route) => route.fulfill({ json: items }));
  const opened = app.waitForEvent("window");
  await page.evaluate((target) => (window as unknown as { amo: { openReview(t: unknown): Promise<void> } }).amo.openReview(target), { workspaceId: ws.id, sessionId: "recorded", turnItemId: "edit", file: paths[0] });
  const review = await opened;
  await review.waitForLoadState("domcontentloaded");
  const list = review.getByRole("navigation", { name: "本轮改动的文件" });
  const selected = list.locator('[data-testid="review-file"][aria-current="true"]');
  const at = async (index: number) => {
    await expect(selected).toHaveAttribute("title", paths[index]!);
    await expect(review.getByTestId("review-file-head").locator("code")).toHaveAttribute("title", paths[index]!);
    await expect(review.getByTestId("diff-lines")).toContainText(paths[index]!);
    await expect(selected).toBeInViewport({ ratio: 1 });
  };
  await at(0);
  await selected.click();
  await review.keyboard.press("ArrowUp");
  await at(0);
  await review.keyboard.press("ArrowDown");
  await at(1);
  await review.keyboard.press("j");
  await at(2);
  await review.keyboard.press("k");
  await at(1);
  await review.keyboard.press("ArrowUp");
  await at(0);
  // Repeated events can arrive before React paints the previous selection.
  await review.evaluate(() => {
    for (let i = 0; i < 45; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  await at(39);
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await screenshot(app, "studio", "turn-review-arrow-keys", review, "review");
  await review.keyboard.press("ArrowDown");
  await at(39);
  await review.locator(".gr-line.add").getByTestId("add-comment").click();
  const input = review.getByTestId("comment-draft").getByRole("textbox");
  await input.fill("检查改动");
  await input.press("ArrowUp");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("检查改动");
  await at(39);
  await input.press("Control+ArrowUp");
  await at(39);
});
