import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@amo-studio/protocol";
import { commandAt, matchScore, matchSlash, slashAt, slashGroups } from "./slash.js";

const COMMANDS: SlashCommand[] = [
  { name: "compact", description: "压缩上下文", group: "studio" },
  { name: "review", description: "打开 Git Review", group: "studio", local: "open-review" },
  { name: "context", description: "Show current context usage", group: "runtime" },
  { name: "code-review", description: "Review the current diff", group: "runtime", aliases: ["review"] },
  { name: "usage", description: "Show session cost", group: "runtime", aliases: ["cost", "stats"] },
  { name: "dataviz", description: "Charts and plots", group: "skill" },
  { name: "deploy", description: "Ship to staging", group: "custom" },
];

describe("slash menu", () => {
  it("finds skill mentions at the caret without consuming the surrounding request", () => {
    expect(commandAt("$", 1)).toEqual({ query: "", start: 0, end: 1, trigger: "$" });
    expect(commandAt("请用 $rel 检查", 7)).toEqual({ query: "rel", start: 3, end: 7, trigger: "$" });
    expect(commandAt("先检查\n$code-review", 15)?.trigger).toBe("$");
    expect(commandAt("foo$rel", 7)).toBeNull();
    expect(commandAt("$rel 说明", 7)).toBeNull();
    expect(commandAt("/", 1)?.trigger).toBe("/");
    expect(commandAt("  /co", 5)).toEqual({ query: "co", start: 2, end: 5, trigger: "/" });
  });
  it("opens only while the name at the start is being typed", () => {
    expect(slashAt("/", 1)).toEqual({ query: "", end: 1 });
    expect(slashAt("/com", 4)).toEqual({ query: "com", end: 4 });
    expect(slashAt("/com", 2)).toEqual({ query: "com", end: 4 });
    expect(slashAt("/compact keep", 13)).toBeNull();
    expect(slashAt("hi /com", 7)).toBeNull();
    expect(slashAt("/usr/bin", 4)).toEqual({ query: "usr", end: 4 });
    expect(slashAt("/usr/bin", 8)).toBeNull();
  });

  it("ranks prefix, alias, substring, letters in order, then description", () => {
    expect(matchScore(COMMANDS[0]!, "comp")).toBe(0);
    expect(matchScore(COMMANDS[4]!, "cost")).toBe(1);
    expect(matchScore(COMMANDS[3]!, "rev")).toBe(1);
    expect(matchScore(COMMANDS[3]!, "view")).toBe(2);
    expect(matchScore(COMMANDS[5]!, "dvz")).toBe(3);
    expect(matchScore(COMMANDS[6]!, "staging")).toBe(4);
    expect(matchScore(COMMANDS[6]!, "x")).toBeNull();
  });

  it("keeps the groups in order and the best matches first", () => {
    expect(slashGroups(COMMANDS, "").map((g) => [g.group, g.commands.length])).toEqual([
      ["studio", 2],
      ["runtime", 3],
      ["skill", 1],
      ["custom", 1],
    ]);
    const co = slashGroups(COMMANDS, "co");
    expect(co.map((g) => g.commands.map((c) => c.name))).toEqual([["compact"], ["context", "code-review", "usage"]]);
  });

  it("matches a message to a command by name or alias, Studio's first", () => {
    expect(matchSlash("/compact 保留接口", COMMANDS)).toEqual({ command: COMMANDS[0], args: "保留接口" });
    expect(matchSlash("/review", COMMANDS)?.command).toBe(COMMANDS[1]);
    expect(matchSlash("/cost", COMMANDS)?.command.name).toBe("usage");
    expect(matchSlash("/Deploy prod", COMMANDS)).toEqual({ command: COMMANDS[6], args: "prod" });
    expect(matchSlash("/nope", COMMANDS)).toBeNull();
    expect(matchSlash("/usr/bin/env", COMMANDS)).toBeNull();
    expect(matchSlash("compact", COMMANDS)).toBeNull();
  });
});
