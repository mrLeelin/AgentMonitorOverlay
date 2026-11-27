import { expect, test } from "@playwright/test";
import type { Session, SessionItem, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("shows a reconciled charge beside the completed turn's usage", async () => {
  const studio = await launchStudio({ transcriptView: "standard", taskSidebar: false });
  try {
    const { app, page } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
    const { session } = await studio.api<{ session: Session }>("POST", "/api/tasks", {
      title: "本轮花费",
      workspaceId: ws.id,
      firstSession: { profileId: "codex-mock", text: "旧的一轮" },
    });
    const itemsPath = `/api/sessions/${session.id}/items`;
    const completed = async () => (await studio.api<SessionItem[]>("GET", itemsPath)).filter((i) => i.type === "turn" && i.state === "completed");
    await expect.poll(async () => (await completed()).length, { timeout: 30_000 }).toBe(1);
    await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "余额计费的一轮" });
    await expect.poll(async () => (await completed()).length, { timeout: 30_000 }).toBe(2);

    // Use a fixture for the gateway's reconciled amount so the display test can run on the local mock model.
    const chargedId = (await completed())[1]!.id;
    await page.route(`**${itemsPath}`, async (route) => {
      const response = await route.fetch();
      const items = (await response.json()) as SessionItem[];
      await route.fulfill({ response, json: items.map((item) => item.id === chargedId ? { ...item, charge: { amount: 0.002, unit: "USD" }, decode: { ms: 1000, tokens: 68 } } : item) });
    });
    await page.getByTestId("task-card").filter({ hasText: "本轮花费" }).click();
    const turns = page.getByTestId("turn");
    await expect(turns).toHaveCount(2);
    await expect(turns.first().getByTestId("turn-charge")).toHaveCount(0);
    const footer = turns.last().getByTestId("turn-foot");
    await expect(footer.getByRole("button", { name: /^用量 / })).toBeVisible();
    await expect(footer.getByTestId("turn-speed")).toHaveText("68 tok/s");
    const charge = footer.getByTestId("turn-charge");
    await expect(charge).toBeVisible();
    await expect(charge).toHaveText("花费约 $0.002");

    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(app, "studio", "turn-charge", page);

    await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "[[wait]]" });
    await expect(turns.last()).toHaveAttribute("data-running", "true");
    await expect(turns.last().getByTestId("turn-charge")).toHaveCount(0);
    await page.getByRole("button", { name: "打断" }).click();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  } finally {
    await studio.close();
  }
});
