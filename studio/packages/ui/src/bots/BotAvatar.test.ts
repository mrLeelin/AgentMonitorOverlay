import { expect, it } from "vitest";
import { BOT_MASCOT_IDS } from "@amo-studio/protocol";
import { botAvatarSrc, botMascotUrl, randomBotMascot } from "./BotAvatar.js";

it("shuffles to a different pickable mascot", () => {
  expect(randomBotMascot(null, () => 0)).toBe("mascot:A1");
  expect(randomBotMascot("mascot:A1", () => 0)).toBe("mascot:B1");
  expect(randomBotMascot(null, () => 0.9999)).toBe("mascot:T1");
  for (let i = 0; i < 50; i++) expect(randomBotMascot("mascot:H2")).not.toMatch(/H2|S2/);
});

it("resolves every Orca mascot to its bundled picture", () => {
  for (const id of BOT_MASCOT_IDS) expect(botMascotUrl(id)).toMatch(new RegExp(`${id}.*\\.svg`));
  expect(botAvatarSrc("mascot:A1")).toBe(botMascotUrl("A1"));
});

it("keeps uploads as they are and falls back to the default face otherwise", () => {
  const upload = "data:image/png;base64,iVBORw0KGgo=";
  expect(botAvatarSrc(upload)).toBe(upload);
  expect(botAvatarSrc(null)).toBeNull();
  expect(botAvatarSrc(undefined)).toBeNull();
  expect(botAvatarSrc("mascot:Z9")).toBeNull();
});
