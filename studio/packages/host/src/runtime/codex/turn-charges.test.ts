import type { TurnUsage } from "@amo-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BalanceAsk } from "../balance.js";
import { CodexTurnCharges } from "./turn-charges.js";

const baseline = {
  requests: 4,
  input_tokens: 100,
  cache_creation_tokens: 0,
  cache_read_tokens: 50,
  output_tokens: 10,
  actual_cost: 0.2,
};
const settled = {
  requests: 6,
  input_tokens: 172,
  cache_creation_tokens: 18,
  cache_read_tokens: 110,
  output_tokens: 19,
  actual_cost: 0.2025,
};
const usage: TurnUsage = { input: 150, cachedInput: 60, output: 9, reasoning: 3 };
const wallet = (total: typeof baseline, balance = 10) => ({
  mode: "unrestricted",
  isValid: true,
  unit: "USD",
  balance,
  usage: { total },
});

function meter(responses: object[], template: BalanceAsk["config"]["template"] = "sub2api") {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    return response ? Response.json(response) : new Response(null, { status: 503 });
  });
  const charges = new CodexTurnCharges((profileId) => ({
    profileId,
    baseUrl: "https://balance.example/v1",
    config: { template },
    key: "fixture-key",
    fetch,
  }));
  return { charges, fetch };
}

function startTurn(charges: CodexTurnCharges) {
  charges.start("session", "turn", "channel");
  charges.called("turn");
  charges.called("turn");
}

afterEach(() => vi.useRealTimers());

describe("Codex turn charges", () => {
  it("retains a sub-cent actual charge when the key totals match the turn, even when the wallet is topped up", async () => {
    const { charges, fetch } = meter([wallet(baseline), wallet(settled, 42)]);
    startTurn(charges);
    await expect(charges.finish("turn", usage)).resolves.toEqual({ amount: 0.0025, unit: "USD" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://balance.example/v1/usage");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("waits for the channel to finish recording a turn before publishing its charge", async () => {
    vi.useFakeTimers();
    const { charges } = meter([wallet(baseline), wallet(baseline), wallet(settled)]);
    startTurn(charges);
    const charge = charges.finish("turn", usage);
    await vi.runAllTimersAsync();
    await expect(charge).resolves.toEqual({ amount: 0.0025, unit: "USD" });
  });

  it.each([
    { requests: 7 },
    { input_tokens: 173 },
    { cache_read_tokens: 111, input_tokens: 171 },
    { output_tokens: 20 },
    { actual_cost: 0.19 },
  ])("omits a charge when the counters diverge (%j)", async (change) => {
    vi.useFakeTimers();
    const mismatch = wallet({ ...settled, ...change });
    const { charges } = meter([wallet(baseline), mismatch, mismatch, mismatch]);
    startTurn(charges);
    const charge = charges.finish("turn", usage);
    await vi.runAllTimersAsync();
    await expect(charge).resolves.toBeNull();
  });

  it("does not attribute the total to either of two overlapping turns on the same key", async () => {
    const { charges } = meter([wallet(baseline), wallet(settled)]);
    startTurn(charges);
    charges.start("other-session", "other-turn", "other-channel");
    charges.called("other-turn");
    charges.called("other-turn");
    await expect(charges.finish("turn", usage)).resolves.toBeNull();
    await expect(charges.finish("other-turn", usage)).resolves.toBeNull();
  });

  it("does not use the previous turn's delayed charge for a new turn with identical usage", async () => {
    vi.useFakeTimers();
    const { charges } = meter([wallet(baseline), wallet(baseline), wallet(baseline), wallet(settled)]);
    startTurn(charges);
    const previous = charges.finish("turn", usage);
    await vi.advanceTimersByTimeAsync(0);

    charges.start("session", "next-turn", "channel");
    charges.called("next-turn");
    charges.called("next-turn");
    const next = charges.finish("next-turn", usage);
    await vi.runAllTimersAsync();
    await previous;
    await expect(next).resolves.toBeNull();
  });

  it("omits subscriptions and avoids querying unsupported balance templates", async () => {
    const subscription = { mode: "unrestricted", isValid: true, unit: "USD", remaining: 10, usage: { total: baseline } };
    const { charges } = meter([subscription, wallet(settled)]);
    startTurn(charges);
    await expect(charges.finish("turn", usage)).resolves.toBeNull();

    const unsupported = meter([], "general");
    startTurn(unsupported.charges);
    await expect(unsupported.charges.finish("turn", usage)).resolves.toBeNull();
    expect(unsupported.fetch).not.toHaveBeenCalled();
  });

  it("can start a fresh measurement after a canceled session", async () => {
    const { charges } = meter([wallet(baseline), wallet(baseline), wallet(settled)]);
    startTurn(charges);
    charges.cancelSession("session");
    await expect(charges.finish("turn", usage)).resolves.toBeNull();
    charges.start("session", "next-turn", "channel");
    charges.called("next-turn");
    charges.called("next-turn");
    await expect(charges.finish("next-turn", usage)).resolves.toEqual({ amount: 0.0025, unit: "USD" });
  });
});
