import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkNetwork, networkEnv, testNetwork } from "./network.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); });
async function listen(handler: RequestListener) {
  const s = createServer(handler); servers.push(s);
  for (let port = 47970; port <= 47999; port++) {
    const ok = await new Promise<boolean>((resolve) => { s.once("error", () => resolve(false)); s.listen(port, "127.0.0.1", () => resolve(true)); });
    if (ok) return `http://127.0.0.1:${port}`;
  }
  throw new Error("test ports busy");
}

describe("model network", () => {
  it("overrides mixed-case inherited proxies without mutating them and preserves local bypass", () => {
    const old = { HTTP_PROXY: "old", https_proxy: "old", All_Proxy: "old", NO_PROXY: "internal.test", PATH: "keep" };
    const env = networkEnv({ mode: "manual", proxyUrl: "http://127.0.0.1:7890" }, old);
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.https_proxy).toBe(env.HTTP_PROXY);
    expect(env.All_Proxy).toBeUndefined();
    expect(env.NO_PROXY).toContain("internal.test,localhost,127.0.0.1,::1");
    expect(old.HTTP_PROXY).toBe("old");
    expect(env.PATH).toBe("keep");
    const direct = networkEnv({ mode: "direct", proxyUrl: "" }, old);
    expect(Object.keys(direct).filter((k) => /^(http|https|all)_proxy$/i.test(k))).toEqual([]);
    expect(networkEnv({ mode: "inherit", proxyUrl: "" }, old).HTTP_PROXY).toBe("old");
  });

  it("validates URLs and strips irrelevant addresses in other modes", () => {
    expect(checkNetwork({ mode: "manual", proxyUrl: " http://localhost:7890/ " }).proxyUrl).toBe("http://localhost:7890");
    for (const proxyUrl of ["bad", "socks5://localhost:7890", "http://user:secret@localhost", "http://localhost/path"]) expect(() => checkNetwork({ mode: "manual", proxyUrl })).toThrow();
    expect(checkNetwork({ mode: "direct", proxyUrl: "bad" }).proxyUrl).toBe("");
    expect(() => checkNetwork({ mode: "oops" })).toThrow();
  });

  it("reaches an otherwise unresolvable service through a proxy and reports authentication separately", async () => {
    let hits = 0;
    const proxy = await listen((_req, res) => { hits++; res.writeHead(401); res.end(); });
    const targets = [{ name: "fixture", url: "http://model-service.invalid/" }];
    const direct = await testNetwork({ mode: "direct", proxyUrl: "" }, {}, targets);
    expect(direct.checks[0]?.ok).toBe(false);
    const via = await testNetwork({ mode: "manual", proxyUrl: proxy }, {}, targets);
    expect(via.checks[0]?.ok).toBe(true);
    expect(via.checks[0]?.message).toContain("401");
    expect(hits).toBe(1);
    const authProxy = await listen((_req, res) => { res.writeHead(407); res.end(); });
    const auth = await testNetwork({ mode: "manual", proxyUrl: authProxy }, {}, targets);
    expect(auth.checks[0]).toMatchObject({ ok: false, message: "代理要求身份验证" });
  });
});
