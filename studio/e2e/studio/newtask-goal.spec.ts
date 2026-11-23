import { expect, test } from "@playwright/test";
import type { SessionGoalState, StateSnapshot } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => {
  if (studio) {
    const state = await studio.api<StateSnapshot>("GET", "/api/state").catch(() => null);
    for (const session of state?.sessions ?? []) {
      await studio.api("POST", `/api/sessions/${session.id}/interrupt`).catch(() => undefined);
      await studio.api("DELETE", `/api/sessions/${session.id}/goal`).catch(() => undefined);
    }
    await studio.close(); studio = undefined;
  }
});

async function openDraft(profileId = "codex-mock") {
  studio = await launchStudio({ taskSidebar: false, dsh: profileId === "dsh-mock" });
  await studio.page.evaluate((profileId) => {
    localStorage.setItem("amo.taskDraft", JSON.stringify({ title: "新建 Goal 验证", text: "[[goal-slow]] 检查当前实现并交付验证证据。", projectId: null, topicId: null, pick: { profileId, model: null }, options: {} }));
  }, profileId);
  await studio.page.getByRole("button", { name: "+ 新任务" }).click();
  await studio.page.getByRole("button", { name: "更多选项", exact: true }).click();
  await studio.page.getByTestId("draft-goal-toggle").click();
}

for (const [profileId, budget] of [["codex-mock", "50000"], ["claude-mock", null], ["dsh-mock", "8"]] as const) {
  test(`${profileId} 从新建页直接以原生 Goal 开始`, async () => {
    await openDraft(profileId);
    const { page, app } = studio!;
    await expect(page.getByTestId("draft-start")).toContainText("开始 Goal");
    if (budget) await page.getByTestId("draft-goal-budget").fill(budget);
    else await expect(page.getByTestId("draft-goal-budget")).toHaveCount(0);
    await expect(page.getByTestId("draft-file")).toBeDisabled();
    expect((await studio!.api<StateSnapshot>("GET", "/api/state")).tasks).toHaveLength(0);

    if (profileId === "codex-mock") {
      await page.reload();
      await page.getByRole("button", { name: "更多选项", exact: true }).click();
      await expect(page.getByTestId("draft-goal-toggle")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("draft-goal-budget")).toHaveValue(budget!);
      for (const [width, theme] of [[1280, "dark"], [1280, "light"], [1000, "dark"]] as const) {
        await app.evaluate(({ BrowserWindow }, [url, size]) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.setSize(size, 900); }, [page.url(), width] as const);
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        const button = (await page.getByTestId("draft-goal-toggle").boundingBox())!;
        expect(button.x).toBeGreaterThanOrEqual(0);
        expect(button.x + button.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
        await screenshot(app, "studio", `newtask-goal-${theme}-${width}`, page);
      }
    }
    const request = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/tasks"));
    await page.getByTestId("draft-start").click();
    expect((await request).postDataJSON().firstSession.text).toBeUndefined();
    await expect(page.getByTestId("switch-goal")).toContainText(/进行中|已完成/, { timeout: 45_000 });
    const state = await studio!.api<StateSnapshot>("GET", "/api/state");
    expect(state.tasks).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    const goal = await studio!.api<SessionGoalState>("GET", `/api/sessions/${state.sessions[0]!.id}/goal`);
    expect(goal.goal?.objective).toBe("[[goal-slow]] 检查当前实现并交付验证证据。");
    if (profileId === "codex-mock") expect(goal.goal?.tokenBudget).toBe(50000);
    if (profileId === "dsh-mock") expect(goal.goal?.roundBudget).toBe(8);
  });
}

test("开启失败和刷新后重试使用已建会话，不重复建任务", async () => {
  await openDraft();
  const { page, app } = studio!;
  let fail = true;
  await page.route("**/api/sessions/*/goal", (route) => route.request().method() === "PUT" && fail
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "runtime_error", message: "测试 Goal 开启失败" } }) })
    : route.continue());
  await page.getByTestId("draft-start").click();
  await expect(page.getByTestId("draft-goal-recovery")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("测试 Goal 开启失败");
  const before = await studio!.api<StateSnapshot>("GET", "/api/state");
  expect(before.tasks).toHaveLength(1);
  expect(before.sessions).toHaveLength(1);
  await screenshot(app, "studio", "newtask-goal-recovery", page);
  await page.reload();
  await expect(page.getByTestId("draft-goal-recovery")).toBeVisible();
  fail = false;
  await page.getByTestId("draft-goal-retry").click();
  await expect(page.getByTestId("switch-goal")).toContainText("进行中", { timeout: 30_000 });
  const after = await studio!.api<StateSnapshot>("GET", "/api/state");
  expect(after.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
  expect(after.sessions.map((session) => session.id)).toEqual(before.sessions.map((session) => session.id));
});

test("Goal 不把图片悄悄丢掉，校验失败不会创建任务", async () => {
  await openDraft();
  const { page } = studio!;
  await page.getByLabel("第一句话").press("Control+End");
  await page.getByTestId("draft-attach-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") });
  await expect(page.getByRole("button", { name: "查看大图 图片 1 · pixel.png" })).toBeVisible();
  await expect(page.getByLabel("第一句话").getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await page.getByTestId("draft-start").click();
  await expect(page.getByRole("alert")).toContainText("暂不带图片");
  expect((await studio!.api<StateSnapshot>("GET", "/api/state")).tasks).toHaveLength(0);
  await expect(page.getByLabel("第一句话")).toContainText("检查当前实现");
});
