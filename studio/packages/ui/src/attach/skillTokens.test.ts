import { describe, expect, it } from "vitest";
import { skillTokens } from "./skillTokens.js";

const skills = [{ name: "release-notes" }, { name: "plugin:review" }];

describe("skill references in editable input", () => {
  it("recognizes available full names and preserves their exact text positions", () => {
    expect(skillTokens("请用 $release-notes 和 $plugin:review 检查", skills)).toEqual([
      { start: 3, end: 17, name: "release-notes" },
      { start: 20, end: 34, name: "plugin:review" },
    ]);
    expect(skillTokens("  /release-notes 参数", skills)).toEqual([{ start: 2, end: 16, name: "release-notes" }]);
  });

  it("does not highlight partial names, variables, paths, embedded dollars or unavailable skills", () => {
    for (const text of ["$release", "$release-notes-other", "$HOME", "foo$release-notes", "$release-notes/file", "/release-notes/file", "请用 /release-notes"]) expect(skillTokens(text, skills)).toEqual([]);
    expect(skillTokens("$release-notes", [])).toEqual([]);
  });
});
