import { expect, test, type Locator, type Page } from "@playwright/test";
import { TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function openDraft() {
  studio = await launchStudio({ taskSidebar: false });
  const { page } = studio;
  await page.evaluate(() => {
    localStorage.setItem("amo.taskDraft", JSON.stringify({ title: "绘图验证", text: "左侧右侧", projectId: null, topicId: null, pick: { profileId: "codex-mock", model: null }, options: {} }));
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  return page;
}

const add = (page: Page) => page.getByRole("button", { name: "添加", exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: "添加", exact: true });

async function openSketch(page: Page) {
  await add(page).click();
  await menu(page).getByRole("menuitem", { name: /绘图/ }).click();
  const dialog = page.getByRole("dialog", { name: "绘图", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 12 });
  await page.mouse.up();
}

async function pixel(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((el: HTMLCanvasElement, [x, y]) => [...el.getContext("2d")!.getImageData(x!, y!, 1, 1).data], [x, y]);
}

test("新建任务的添加菜单复用文件与 Goal，并把草图插在光标处", async () => {
  const page = await openDraft();
  const input = page.getByLabel("第一句话");
  await add(page).press("ArrowDown");
  await expect(menu(page).getByRole("menuitem")).toHaveCount(3);
  await expect(menu(page).getByRole("menuitem", { name: "文件和文件夹" })).toBeFocused();
  await screenshot(studio!.app, "studio", "composer-add-draft-dark", page);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("draft-start")).toContainText("开始 Goal");
  await expect(page.getByTestId("draft-goal-budget")).toBeVisible();
  await add(page).click();
  await menu(page).getByRole("menuitem", { name: /目标模式/ }).click();
  await expect(page.getByTestId("draft-start")).not.toContainText("Goal");

  const folder = studio!.workspace("草图参考");
  await add(page).click();
  await menu(page).getByRole("menuitem", { name: "文件和文件夹" }).click();
  const files = page.getByRole("menu", { name: "文件和文件夹" });
  const chooser = page.waitForEvent("filechooser");
  await files.getByRole("menuitem", { name: "选择文件…" }).click();
  await (await chooser).setFiles({ name: "参考图.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64") });
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await input.fill("左侧右侧");
  await add(page).click();
  await menu(page).getByRole("menuitem", { name: "文件和文件夹" }).click();
  await files.getByRole("menuitem", { name: "选择文件夹…" }).click();
  const picker = page.getByRole("dialog", { name: "选择文件夹" });
  const path = picker.getByRole("textbox", { name: "路径" });
  await expect(picker.getByRole("group", { name: "磁盘" }).getByRole("button").first()).toBeEnabled();
  await path.fill(folder);
  await path.press("Enter");
  await expect(path).toHaveValue(folder);
  await picker.getByRole("button", { name: "选择这个文件夹" }).click();
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("title", folder);
  await input.fill("左侧右侧");
  await input.press("Home");
  await input.press("ArrowRight");
  await input.press("ArrowRight");

  const dialog = await openSketch(page);
  const canvas = dialog.getByTestId("sketch-canvas");
  const paper = await pixel(canvas, 240, 180);
  await expect(dialog.getByRole("button", { name: "插入绘图" })).toBeDisabled();
  await dialog.getByRole("button", { name: "红色", exact: true }).click();
  await drag(page, canvas, [0.15, 0.3], [0.35, 0.3]);
  expect(await pixel(canvas, 240, 180)).toEqual([239, 83, 84, 255]);
  await dialog.getByRole("button", { name: "选择并移动" }).click();
  await drag(page, canvas, [0.25, 0.3], [0.25, 0.4]);
  expect(await pixel(canvas, 240, 180)).toEqual(paper);
  expect(await pixel(canvas, 240, 240)).toEqual([239, 83, 84, 255]);
  await dialog.getByRole("button", { name: "橡皮擦" }).click();
  await drag(page, canvas, [0.25, 0.32], [0.25, 0.48]);
  expect(await pixel(canvas, 240, 240)).toEqual(paper);
  expect(await pixel(canvas, 165, 240)).toEqual([239, 83, 84, 255]);
  expect(await pixel(canvas, 315, 240)).toEqual([239, 83, 84, 255]);
  await canvas.press("Control+z");
  expect(await pixel(canvas, 240, 240)).toEqual([239, 83, 84, 255]);
  await dialog.getByRole("button", { name: "重做" }).click();
  expect(await pixel(canvas, 240, 240)).toEqual(paper);
  await dialog.getByRole("button", { name: "撤销" }).click();

  await dialog.getByRole("button", { name: "图形", exact: true }).click();
  const shapes = dialog.getByRole("group", { name: "选择图形" });
  await expect(shapes.getByRole("button")).toHaveCount(8);
  await screenshot(studio!.app, "studio", "composer-sketch-shapes-dark", page);
  await shapes.getByRole("button", { name: "箭头", exact: true }).click();
  await dialog.getByRole("button", { name: "蓝色", exact: true }).click();
  await drag(page, canvas, [0.37, 0.40], [0.70, 0.65]);
  await dialog.getByRole("button", { name: "文字", exact: true }).click();
  await dialog.getByRole("button", { name: "默认墨色" }).click();
  await canvas.click({ position: { x: 54, y: 70 } });
  await dialog.getByRole("textbox", { name: "输入绘图文字" }).fill("入口 → 处理 → 完成");
  await dialog.getByRole("textbox", { name: "输入绘图文字" }).press("Enter");
  await screenshot(studio!.app, "studio", "composer-sketch-dark", page);

  const uploaded = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/attachments?"));
  await dialog.getByRole("button", { name: "插入绘图" }).click();
  expect((await uploaded).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await expect.poll(() => input.evaluate((el) => [el.firstChild?.textContent, el.querySelector("[data-testid=inline-resource]")?.nextSibling?.textContent])).toEqual(["左侧", "右侧"]);
  await expect(page.getByTestId("msg-user")).toHaveCount(0);
  await screenshot(studio!.app, "studio", "composer-sketch-inserted-dark", page);
});

test("进行中的会话可打开 Goal、取消绘图、再把 PNG 随消息发送", async () => {
  const page = await openDraft();
  await page.getByLabel("第一句话").fill("[[slow]] 正在运行的任务");
  await page.getByTestId("draft-start").click();
  const input = page.getByLabel("输入消息");
  await expect(input).toBeVisible();
  await expect(page.getByRole("button", { name: "打断", exact: true })).toBeVisible();
  await add(page).click();
  await menu(page).getByRole("menuitem", { name: /目标模式/ }).click();
  await expect(page.getByRole("dialog", { name: "Goal 目标" })).toBeVisible();
  await expect(page.getByTestId("goal-objective-input")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Goal 目标" })).toHaveCount(0);

  await input.fill("这是一张图");
  const abandoned = await openSketch(page);
  await drag(page, abandoned.getByTestId("sketch-canvas"), [0.2, 0.2], [0.4, 0.4]);
  await page.keyboard.press("Escape");
  await expect(abandoned).toHaveCount(0);
  await expect(input.getByTestId("inline-resource")).toHaveCount(0);

  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await studio!.app.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.setSize(900, 660); }, page.url());
  await add(page).click();
  await expect(menu(page).getByRole("menuitem")).toHaveCount(3);
  await screenshot(studio!.app, "studio", "composer-add-chat-light", page);
  await menu(page).getByRole("menuitem", { name: /绘图/ }).click();
  const dialog = page.getByRole("dialog", { name: "绘图", exact: true });
  const canvas = dialog.getByTestId("sketch-canvas");
  await dialog.getByRole("button", { name: "蓝色", exact: true }).click();
  await drag(page, canvas, [0.15, 0.4], [0.67, 0.55]);
  await screenshot(studio!.app, "studio", "composer-sketch-chat-light", page);
  await dialog.getByRole("button", { name: "插入绘图" }).click();
  await expect(input.getByTestId("inline-resource")).toHaveAttribute("data-state", "ready");
  await expect(input.getByTestId("inline-resource")).toContainText("绘图.png");
  await expect(page.getByTestId("msg-user")).toHaveCount(1);
  await input.press("Enter");
  const image = page.getByTestId("msg-user").last().locator(".msg-images img");
  await expect(image).toBeVisible({ timeout: 30_000 });
  expect(await image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([960, 600]);
});

test("圆形橡皮只擦经过的像素，缺口随图形移动并保留在导出的 PNG 中", async () => {
  const page = await openDraft();
  const dialog = await openSketch(page);
  const canvas = dialog.getByTestId("sketch-canvas");
  const white = [255, 255, 255, 255];
  const paper = await pixel(canvas, 480, 150);
  await dialog.getByRole("button", { name: "白色", exact: true }).click();
  await dialog.getByRole("slider", { name: "笔画粗细" }).press("End");
  await dialog.getByRole("button", { name: "图形", exact: true }).click();
  await dialog.getByRole("button", { name: "椭圆", exact: true }).click();
  await drag(page, canvas, [0.25, 0.25], [0.75, 0.75]);
  expect(await pixel(canvas, 480, 150)).toEqual(white);

  await dialog.getByRole("button", { name: "橡皮擦" }).click();
  const slider = dialog.getByRole("slider", { name: "橡皮擦大小" });
  await slider.press("End");
  await expect(slider).toHaveValue("100");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
  const cursor = dialog.locator(".sketch-eraser-tip");
  await expect(cursor).toBeVisible();
  expect((await cursor.boundingBox())!.width).toBeCloseTo(100 * box.width / 960, 0);
  await page.mouse.down();
  expect(await pixel(canvas, 480, 150)).toEqual(paper);
  expect(await pixel(canvas, 480, 450)).toEqual(white);
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.14);
  await screenshot(studio!.app, "studio", "composer-sketch-eraser-dark", page);

  await dialog.getByRole("button", { name: "撤销" }).click();
  expect(await pixel(canvas, 480, 150)).toEqual(white);
  await dialog.getByRole("button", { name: "重做" }).click();
  expect(await pixel(canvas, 480, 150)).toEqual(paper);
  await dialog.getByRole("button", { name: "选择并移动" }).click();
  await drag(page, canvas, [0.75, 0.5], [0.825, 0.55]);
  expect(await pixel(canvas, 552, 180)).toEqual(paper);
  expect(await pixel(canvas, 552, 480)).toEqual(white);

  await dialog.getByRole("button", { name: "插入绘图" }).click();
  const chip = page.getByLabel("第一句话").getByTestId("inline-resource");
  await expect(chip).toHaveAttribute("data-state", "ready");
  const actual = await chip.locator("img").evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const out = document.createElement("canvas");
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return [180, 480].map((y) => [...ctx.getImageData(552, y, 1, 1).data]);
  });
  expect(actual).toEqual([paper, white]);
});

test("Shift 在拖动中实时切换正方形与正圆预览，并按松开鼠标时的比例落笔", async () => {
  const page = await openDraft();
  const dialog = await openSketch(page);
  const canvas = dialog.getByTestId("sketch-canvas");
  const paper = await pixel(canvas, 220, 135);
  const white = [255, 255, 255, 255];
  const box = (await canvas.boundingBox())!;
  const move = (x: number, y: number) => page.mouse.move(box.x + x * box.width / 960, box.y + y * box.height / 600);

  await dialog.getByRole("button", { name: "白色", exact: true }).click();
  await dialog.getByRole("slider", { name: "笔画粗细" }).press("End");
  const shapes = dialog.getByRole("button", { name: "图形", exact: true });
  await shapes.click();
  await dialog.getByRole("button", { name: "矩形", exact: true }).click();
  await move(320, 325);
  await page.mouse.down();
  await move(130, 255);
  expect(await pixel(canvas, 220, 255)).toEqual(white);
  expect(await pixel(canvas, 220, 135)).toEqual(paper);
  await page.keyboard.down("Shift");
  expect(await pixel(canvas, 220, 135)).toEqual(white);
  expect(await pixel(canvas, 220, 255)).toEqual(paper);
  await page.keyboard.up("Shift");
  expect(await pixel(canvas, 220, 255)).toEqual(white);
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(await pixel(canvas, 220, 135)).toEqual(white);

  await shapes.click();
  await dialog.getByRole("button", { name: "椭圆", exact: true }).click();
  await page.keyboard.down("Shift");
  await move(580, 100);
  await page.mouse.down();
  await move(800, 195);
  expect(await pixel(canvas, 690, 320)).toEqual(white);
  await page.keyboard.up("Shift");
  expect(await pixel(canvas, 690, 195)).toEqual(white);
  expect(await pixel(canvas, 690, 320)).toEqual(paper);
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(await pixel(canvas, 690, 320)).toEqual(white);
  expect(await pixel(canvas, 800, 210)).toEqual(white);

  await screenshot(studio!.app, "studio", "composer-sketch-shift-shapes-dark", page);
});

test("Shift 锁定心形、星形、菱形和三角形的比例，并吸附直线和箭头", async () => {
  const page = await openDraft();
  const dialog = await openSketch(page);
  const canvas = dialog.getByTestId("sketch-canvas");
  const shapes = dialog.getByRole("button", { name: "图形", exact: true });
  const paper = await pixel(canvas, 657, 240);
  const white = [255, 255, 255, 255];
  const chooseShape = async (name: string) => {
    await shapes.click();
    await dialog.getByRole("button", { name, exact: true }).click();
  };
  const drawWithShift = async (name: string, x: number, y: number, endX: number, endY: number) => {
    await chooseShape(name);
    await page.keyboard.down("Shift");
    await drag(page, canvas, [x / 960, y / 600], [endX / 960, endY / 600]);
    await page.keyboard.up("Shift");
  };
  await dialog.getByRole("button", { name: "白色", exact: true }).click();
  await dialog.getByRole("slider", { name: "笔画粗细" }).press("End");

  await chooseShape("心形");
  const box = (await canvas.boundingBox())!;
  const move = (x: number, y: number) => page.mouse.move(box.x + x * box.width / 960, box.y + y * box.height / 600);
  await move(570, 65);
  await page.mouse.down();
  await move(745, 120);
  expect(await pixel(canvas, 657, 120)).toEqual(white);
  expect(await pixel(canvas, 657, 240)).toEqual(paper);
  await page.keyboard.down("Shift");
  expect(await pixel(canvas, 657, 240)).toEqual(white);
  await page.keyboard.up("Shift");
  expect(await pixel(canvas, 657, 240)).toEqual(paper);
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(await pixel(canvas, 657, 240)).toEqual(white);

  await drawWithShift("星形", 490, 250, 320, 210);
  expect(await pixel(canvas, 405, 80)).toEqual(white);
  await drawWithShift("菱形", 60, 70, 225, 113);
  expect(await pixel(canvas, 142, 235)).toEqual(white);
  await drawWithShift("三角形", 60, 305, 250, 355);
  expect(await pixel(canvas, 155, 469)).toEqual(white);
  expect(await pixel(canvas, 107, 387)).toEqual(white);
  await drawWithShift("直线", 310, 330, 470, 347);
  expect(await pixel(canvas, 465, 330)).toEqual(white);
  expect(await pixel(canvas, 465, 347)).toEqual(paper);
  await drawWithShift("箭头", 550, 340, 720, 450);
  expect(await pixel(canvas, 630, 420)).toEqual(white);
  expect(await pixel(canvas, 686, 476)).toEqual(white);
  expect(await pixel(canvas, 630, 392)).toEqual(paper);

  await drawWithShift("矩形", 800, 80, 910, 130);
  await drawWithShift("椭圆", 800, 310, 910, 360);
  await screenshot(studio!.app, "studio", "composer-sketch-shift-all-dark", page);
});

test("拖动锥形滑杆改变画笔圆点大小，圆点随颜色且悬停时不落笔", async () => {
  const page = await openDraft();
  const dialog = await openSketch(page);
  const canvas = dialog.getByTestId("sketch-canvas");
  const cursor = dialog.locator(".sketch-pen-tip");
  const slider = dialog.getByRole("slider", { name: "笔画粗细" });
  await dialog.getByRole("button", { name: "画笔", exact: true }).click();
  await dialog.getByRole("button", { name: "红色", exact: true }).click();

  const box = (await canvas.boundingBox())!;
  const point = { x: box.x + box.width * 300 / 960, y: box.y + box.height * 255 / 600 };
  const paper = await pixel(canvas, 300, 255);
  await slider.press("Home");
  await expect(slider).toHaveValue("2");
  await page.mouse.move(point.x, point.y);
  await expect(cursor).toHaveCSS("background-color", "rgb(239, 83, 84)");
  await expect(canvas).toHaveCSS("cursor", "none");
  const small = (await cursor.boundingBox())!;
  expect(small.width).toBeCloseTo(2 * box.width / 960, 0);
  expect(await pixel(canvas, 300, 255)).toEqual(paper);

  const range = (await slider.boundingBox())!;
  const midX = range.x + range.width / 2;
  const track = dialog.locator(".sketch-size");
  const trackShape = () => track.evaluate((el) => getComputedStyle(el, "::before").clipPath);
  const idleTrack = await trackShape();
  expect(idleTrack).toContain("44% 0px");
  await page.mouse.move(midX, range.y + range.height - 12);
  await expect(cursor).toHaveCount(0);
  await page.mouse.down();
  await page.mouse.move(midX, range.y + range.height * 0.25, { steps: 10 });
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(15);
  await expect.poll(trackShape).toContain("100% 0px");
  const size = Number(await slider.inputValue());
  await screenshot(studio!.app, "studio", "composer-sketch-size-drag-dark", page);
  await page.mouse.up();
  await expect.poll(trackShape).toBe(idleTrack);

  await page.mouse.move(point.x, point.y);
  await expect(cursor).toBeVisible();
  const large = (await cursor.boundingBox())!;
  expect(large.width).toBeCloseTo(size * box.width / 960, 0);
  expect(large.height).toBeCloseTo(large.width, 0);
  expect(Math.abs(large.x + large.width / 2 - point.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(large.y + large.height / 2 - point.y)).toBeLessThanOrEqual(1);
  expect(await pixel(canvas, 300, 255)).toEqual(paper);
  await screenshot(studio!.app, "studio", "composer-sketch-brush-tip-dark", page);
  await page.mouse.click(point.x, point.y);
  expect(await pixel(canvas, 300, 255)).toEqual([239, 83, 84, 255]);
});
