/// <reference lib="dom" />
import { arch, cpus, release, totalmem } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { canvasScenarios, measuredLeafNode, measuredRootNode, seedCanvasPerformance } from "../support/canvas-performance.js";
import { launchStudio, screenshot } from "../support/studio.js";

const rounds = 5;
const quietMs = 500;

type BrowserProbe = Window & { canvasBenchmark?: { socket?: WebSocket; opens: number; start: number } };

async function installSocketProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: NonNullable<BrowserProbe["canvasBenchmark"]> = { opens: 0, start: 0 };
    (window as BrowserProbe).canvasBenchmark = probe;
    // Keep the native connection and messages. Only retain a handle to close one real socket on demand.
    window.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(this.url).pathname !== "/api/events") return;
        probe.socket = this;
        this.addEventListener("open", () => { probe.opens++; });
      }
    };
  });
  await page.reload();
  await page.waitForFunction(() => (window as BrowserProbe).canvasBenchmark?.socket?.readyState === WebSocket.OPEN);
}

type HttpEntry = { method: string; path: string; status?: number; failed?: boolean; responseBodyBytes?: number };

function measureHostTraffic(page: Page, origin: string) {
  const requests = new Map<Request, HttpEntry>();
  const pending = new Set<Request>();
  let socketAttempts = 0;
  let lastActivity = performance.now();
  const host = new URL(origin).host;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.host !== host || !url.pathname.startsWith("/api/")) return;
    requests.set(request, { method: request.method(), path: url.pathname });
    pending.add(request);
    lastActivity = performance.now();
  };
  const done = (request: Request) => {
    if (pending.delete(request)) lastActivity = performance.now();
  };
  const onSocket = (socket: { url(): string }) => {
    const url = new URL(socket.url());
    if (url.host === host && url.pathname === "/api/events") {
      socketAttempts++;
      lastActivity = performance.now();
    }
  };
  page.on("request", onRequest);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("websocket", onSocket);
  return {
    async read() {
      // Count background requests scheduled during render as well as fetches on the critical path.
      const renderedAt = performance.now();
      await expect.poll(() => pending.size === 0 && performance.now() - Math.max(lastActivity, renderedAt) >= quietMs, {
        intervals: [50], timeout: 8_000,
      }).toBe(true);
      const http = await Promise.all([...requests].map(async ([request, entry]) => ({
        ...entry,
        status: (await request.response())?.status(),
        failed: request.failure() !== null,
        responseBodyBytes: request.failure() ? undefined : (await request.sizes()).responseBodySize,
      })));
      return { httpRequests: http.length, socketAttempts, http };
    },
    stop() {
      page.off("request", onRequest);
      page.off("requestfinished", done);
      page.off("requestfailed", done);
      page.off("websocket", onSocket);
    },
  };
}

function clickForTiming(button: Locator) {
  return button.evaluate((node) => {
    (window as BrowserProbe).canvasBenchmark!.start = performance.now();
    (node as HTMLElement).click();
  });
}

async function paintedCanvas(page: Page, condition: { cards: number; management?: number; dependencies?: number; leafX?: number; socketOpens?: number }) {
  await page.waitForFunction(({ cards, management, dependencies, leafX, socketOpens, rootId, leafId }) => {
    const viewport = document.querySelector('[data-testid="canvas-viewport"]')?.getBoundingClientRect();
    const root = document.querySelector(`[data-node-id="${rootId}"]`)?.getBoundingClientRect();
    if (!viewport || !root || root.left >= viewport.right || root.right <= viewport.left || root.top >= viewport.bottom || root.bottom <= viewport.top) return false;
    if (document.querySelectorAll('[data-testid="canvas-card"]').length !== cards) return false;
    if (management !== undefined && document.querySelectorAll('[data-testid="canvas-management-line"]').length !== management) return false;
    if (dependencies !== undefined && document.querySelectorAll('[data-testid="canvas-edge"]').length !== dependencies) return false;
    const leaf = document.querySelector<HTMLElement>(`[data-node-id="${leafId}"]`);
    if (leafX !== undefined && leaf?.style.left !== `${leafX}px`) return false;
    return socketOpens === undefined || (window as BrowserProbe).canvasBenchmark!.opens === socketOpens;
  }, { ...condition, rootId: measuredRootNode, leafId: measuredLeafNode });
  return page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - (window as BrowserProbe).canvasBenchmark!.start)));
  }));
}

async function sample(page: Page, origin: string, action: () => Promise<void>, condition: Parameters<typeof paintedCanvas>[1]) {
  const traffic = measureHostTraffic(page, origin);
  try {
    await action();
    const elapsedMs = Math.round(await paintedCanvas(page, condition) * 10) / 10;
    const counts = await traffic.read();
    expect(counts.http.filter((request) => request.failed || (request.status ?? 500) >= 400)).toEqual([]);
    return { elapsedMs, ...counts };
  } finally {
    traffic.stop();
  }
}

test.describe("isolated topic canvas benchmark", () => {
  test.skip(process.env.AMO_E2E_CANVAS_PERF !== "1", "Set AMO_E2E_CANVAS_PERF=1 to collect timing samples.");

  for (const { cards, leavesPerBranch } of canvasScenarios) {
    test(`${cards} cards: first view, one expanded tree, event socket reconnect`, async ({}, info) => {
      test.setTimeout(120_000);
      const studio = await launchStudio();
      const { page } = studio;
      try {
        const fixture = await seedCanvasPerformance(studio, leavesPerBranch);
        const origin = new URL(JSON.parse(readFileSync(join(studio.dataDir, "host.json"), "utf8")).url).origin;
        expect(new URL(page.url()).origin).toBe(origin);
        expect(fixture.saved.nodes).toHaveLength(cards);
        await installSocketProbe(page);
        await page.getByTestId(`scope-topic-${fixture.topic.title}`).click();
        const board = page.getByRole("button", { name: "看板", exact: true });
        const canvas = page.getByRole("button", { name: "画布", exact: true });
        const collapse = page.getByRole("button", { name: "收起间接下辖", exact: true });
        const expand = page.getByRole("button", { name: "展开全部层级", exact: true });
        const root = page.locator(`[data-node-id="${measuredRootNode}"]`);
        const leaf = page.locator(`[data-node-id="${measuredLeafNode}"]`);
        const fullCanvas = { cards, management: cards - 2, dependencies: fixture.saved.edges.length };
        const observed = [];
        let doc = fixture.saved;

        for (let round = 0; round <= rounds; round++) {
          await board.click();
          await expect(page.getByTestId("canvas-viewport")).toHaveCount(0);
          await expect(canvas).toBeEnabled();
          const firstView = await sample(page, origin, () => clickForTiming(canvas), fullCanvas);
          expect(firstView.http).toEqual(expect.arrayContaining([expect.objectContaining({ path: `/api/topics/${fixture.topic.id}/canvas`, status: 200 })]));

          await root.click();
          await collapse.click();
          await expect(page.getByTestId("canvas-card")).toHaveCount(fixture.collapsedCards);
          await expect(leaf).toHaveCount(0);
          await expect(page.locator('[data-node-id="perf-leaf-1-0-0"]')).toHaveCount(1);
          const expandTree = await sample(page, origin, () => clickForTiming(expand), fullCanvas);
          await expect(collapse).toHaveAttribute("aria-pressed", "true");

          const leafX = 81 + round % 2;
          const socketOpens = await page.evaluate(() => (window as BrowserProbe).canvasBenchmark!.opens);
          const reconnect = await sample(page, origin, async () => {
            await page.evaluate(async () => {
              const probe = (window as BrowserProbe).canvasBenchmark!;
              const socket = probe.socket!;
              if (socket.readyState !== WebSocket.OPEN) throw new Error("Host event socket was not open");
              probe.start = performance.now();
              const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
              socket.close();
              await closed;
            });
            // This driver-side write is intentionally missed by the renderer and is outside its request count.
            doc = await fixture.writeCanvas({ ...doc, nodes: doc.nodes.map((node) => node.id === measuredLeafNode ? { ...node, pos: { ...node.pos, x: leafX } } : node) });
            expect(await page.evaluate(() => (window as BrowserProbe).canvasBenchmark!.socket?.readyState === WebSocket.CLOSED)).toBe(true);
            expect(await leaf.evaluate((node) => (node as HTMLElement).style.left)).not.toBe(`${leafX}px`);
          }, { ...fullCanvas, leafX, socketOpens: socketOpens + 1 });
          expect(reconnect.socketAttempts).toBe(1);
          expect(reconnect.http).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: "/api/state", status: 200 }),
            expect.objectContaining({ path: `/api/topics/${fixture.topic.id}/canvas`, status: 200 }),
          ]));
          await expect(collapse).toHaveAttribute("aria-pressed", "true");
          expect((await fixture.readCanvas()).version).toBe(doc.version);
          observed.push({ round, warmup: round === 0, firstView, expandTree, reconnect });
        }

        const runtime = await studio.app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
        const evidence = {
          capturedAt: new Date().toISOString(), sourceRevision: process.env.AMO_E2E_CANVAS_REVISION ?? null,
          cards, management: fullCanvas.management, dependencies: fullCanvas.dependencies,
          oneTreeHiddenCards: cards - fixture.collapsedCards, quietMs, runtime,
          machine: { platform: process.platform, release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30), runnerNode: process.version },
          viewport: await page.getByTestId("canvas-viewport").evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight, dpr: window.devicePixelRatio })),
          samples: observed,
        };
        const evidencePath = info.outputPath("canvas-performance.json");
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
        await info.attach("canvas-performance", { path: evidencePath, contentType: "application/json" });
        const image = await screenshot(studio.app, "studio", `canvas-performance-${cards}`, page);
        await info.attach("expanded-after-reconnect", { path: image, contentType: "image/png" });
      } finally {
        await studio.close();
      }
    });
  }
});
