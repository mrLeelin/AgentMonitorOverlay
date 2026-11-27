import { expect, test } from "@playwright/test";
import type { Session, SessionItem, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("Rider 对比保留代码行、改动连接和原行批注", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("JellybeanUnity") });
  const { session } = await studio.api<{ session: Session }>("POST", "/api/tasks", {
    title: "调整金币奖励显示", workspaceId: ws.id, firstSession: { profileId: "codex-mock" },
  });
  const diff = [
    "@@ -12,9 +12,7 @@",
    " public sealed class CoinReward",
    " {",
    "     public bool FromLogin { get; private set; }",
    "-    public int ComboRate { get; private set; }",
    " ",
    "-    public void Init(bool fromLogin, int comboRate = 0)",
    "+    public void Init(bool fromLogin)",
    "     {",
    "         FromLogin = fromLogin;",
    "-        ComboRate = comboRate;",
    "@@ -266,8 +264,15 @@",
    "     // 实例化金币特效",
    "     if (result.GridType == GridType.Coin)",
    "     {",
    "-        ShowHammerEffect(coin, position);",
    "-        ShowRewardText(position, result.Value);",
    "+        if (result.Value > 0)",
    "+        {",
    "+            ShowHammerEffect(coin, position);",
    "+            ShowRewardText(position, result.Value);",
    "+        }",
    "+        else",
    "+        {",
    "+            ShowEmptyText(position);",
    "+        }",
    "     }",
    " ",
    "     isClicked = true;",
  ].join("\n");
  const effects = Array.from({ length: 70 }, (_, i) => `+    LoadEffect(${i});`);
  const tail = Array.from({ length: 35 }, (_, i) => `     ReleaseEffect(${i});`);
  const longDiff = ["@@ -1,37 +1,177 @@", " void UpdateEffects()", ...effects, "     PlayEffect();", ...tail, ...effects.map(s => s.replace("LoadEffect", "QueueEffect"))].join("\n");
  const items: SessionItem[] = [{
    id: "reward-edit", sessionId: session.id, seq: 1, createdAt: "2026-11-27T00:00:00Z",
    type: "tool", name: "edit", kind: "edit", summary: "调整金币奖励显示", status: "completed",
    files: [{ path: "CoinReward.cs", change: "update", added: 10, removed: 5, diff },
      { path: "RewardVisuals.cs", change: "update", added: 140, removed: 0, diff: longDiff }],
  }];
  await app.context().route(`**/api/sessions/${session.id}/items*`, (route) => route.fulfill({ json: items }));
  await page.evaluate(() => localStorage.setItem("amo.theme", "dark"));
  await page.getByTestId("task-card").first().click();
  const opened = app.waitForEvent("window");
  await page.getByTestId("task-session-changes").click();
  const review = await opened;
  await expect(review.getByTestId("review-scope")).toHaveText("会话改动");
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.setSize(1430, 746), review.url());

  const layout = (name: string) => review.getByRole("button", { name, exact: true });
  await layout("Rider 对比").click();
  const rider = review.getByTestId("diff-rider");
  await expect(rider.getByTestId("diff-hunk")).toHaveCount(2);
  const old = rider.getByTestId("rider-line-old");
  const next = rider.getByTestId("rider-line-new");
  await expect(old.locator(".gr-no")).toHaveText(["12", "13", "14", "15", "16", "17", "18", "19", "20", "266", "267", "268", "269", "270", "271", "272", "273"]);
  await expect(next.locator(".gr-no")).toHaveText(["12", "13", "14", "15", "16", "17", "18", ...Array.from({ length: 15 }, (_, i) => String(264 + i))]);
  const signature = old.filter({ hasText: "void Init" });
  await expect.poll(async () => (await signature.locator("mark").allTextContents()).join("")).toContain("int comboRate = 0");
  await expect(rider.locator('svg [data-kind="add"]').first()).toBeVisible();
  await expect(rider.locator('svg [data-kind="del"]').first()).toBeVisible();
  await expect(rider.locator('svg [data-kind="change"]').first()).toBeVisible();
  const oldCall = old.filter({ hasText: "ShowHammerEffect" });
  const newCall = next.filter({ hasText: "ShowHammerEffect" });
  await expect(oldCall).toHaveAttribute("data-kind", "change");
  await expect(newCall).toHaveAttribute("data-kind", "change");
  const oldBox = (await oldCall.boundingBox())!;
  const newBox = (await newCall.boundingBox())!;
  expect(newBox.y - oldBox.y).toBeCloseTo(2 * oldBox.height, 0);
  await screenshot(app, "studio", "session-rider-diff", review, "review");

  await signature.hover();
  await signature.getByTestId("add-comment").click();
  const draft = review.getByTestId("comment-draft");
  await draft.getByRole("textbox").fill("确认删除连击参数");
  await draft.getByRole("button", { name: "保存" }).click();
  for (const name of ["单栏", "左右对照", "Rider 对比"]) {
    await review.keyboard.press("e");
    await expect(layout(name)).toHaveAttribute("aria-pressed", "true");
    await expect(review.getByTestId("review-comment")).toHaveText(/确认删除连击参数/);
  }
  await layout("复制注释").click();
  await expect(review.getByTestId("review-draft-count")).toHaveText("草稿批注 0 条");
  const copied = await app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1));
  expect(copied).toContain("CoinReward.cs（旧版第 17 行，已删除）");
  expect(copied).toContain("确认删除连击参数");

  await review.getByTestId("review-file").filter({ hasText: "RewardVisuals.cs" }).click();
  // The reading point stays on the same old/new boundary inside a long insertion, including at EOF.
  for (const [text, boundary, atEnd] of [
    ["LoadEffect(40);", "PlayEffect();", false],
    ["PlayEffect();", "PlayEffect();", false],
    ["QueueEffect(40);", "ReleaseEffect(34);", true],
  ] as const) {
    const current = next.filter({ hasText: text });
    await current.evaluate(el => {
      const scroller = el.closest(".gr-scroll")!;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight * 0.4;
    });
    await expect(current).toBeInViewport();
    const previous = old.filter({ hasText: boundary });
    await expect(previous).toBeInViewport();
    await expect.poll(async () => {
      const rect = (await previous.boundingBox())!;
      return Math.abs(rect.y + (atEnd ? rect.height : 0) - (await current.boundingBox())!.y);
    }).toBeLessThan(2);
  }

  const openedTurn = app.waitForEvent("window");
  await page.getByTestId("turn-changes-review").click();
  const turn = await openedTurn;
  await expect(turn.getByTestId("review-scope")).toHaveText("本轮改动");
  await turn.getByRole("button", { name: "Rider 对比", exact: true }).click();
  await expect(turn.getByTestId("diff-rider").getByTestId("rider-line-new").filter({ hasText: "ShowHammerEffect" })).toHaveAttribute("data-kind", "change");
});
