import { describe, expect, it } from "vitest";
import { splitFileRefItems } from "./refs.js";
import { fileToken, imageToken, resourceMessage, resourceDraft, resourceSpans, resourceText, resourceTitle, urlResource } from "./inlineResources.js";

describe("inline resource messages", () => {
  it("keeps Chinese names, brackets, paths, notes and line ranges without delimiter collisions", () => {
    const ref = { path: "C:/项目/[a](b)/配置.json", startLine: 2, endLine: 5, note: "使用[这段]" };
    const token = fileToken(ref);
    expect(resourceSpans(token)[0]?.resource).toEqual({ kind: "file", ref });
    const result = splitFileRefItems(resourceMessage(`使用${token}。`, []).text);
    expect(result.text).toBe("使用【资源 1：配置.json】。");
    expect(result.refs).toEqual([{ ...ref, note: "文中资源 1；使用[这段]" }]);
  });
  it("orders real image ids by first appearance, deduplicates repeats and excludes deleted resources", () => {
    const a = imageToken({ key: "a", name: "一.png" });
    const b = imageToken({ key: "b", name: "二.png" });
    const result = resourceMessage(`${b}对照${a}，再看${b}`, [{ key: "a", id: "att-a" }, { key: "unused", id: "att-unused" }, { key: "b", id: "att-b" }]);
    expect(result.ids).toEqual(["att-b", "att-a"]);
    expect(result.text).toBe("【图片 1：二.png】对照【图片 2：一.png】，再看【图片 1：二.png】");
  });
  it("never sends an image label without the real attachment", () => {
    expect(() => resourceMessage(imageToken({ key: "missing", name: "未上传.png" }), [])).toThrow("尚未准备好");
  });
  it("uses prose for automatic titles and falls back to the name for image-only tasks", () => {
    const image = imageToken({ key: "a", name: "设计图.png" });
    expect(resourceTitle(`修改这里${image}`)).toBe("修改这里");
    expect(resourceTitle(image)).toBe("设计图.png");
    expect(resourceTitle("普通文字")).toBeUndefined();
  });
  it("restores a stopped message with the same images and marked files for resending", () => {
    const pic = imageToken({ key: "a", name: "图.png" });
    const file = fileToken({ path: "C:/config.json", startLine: 3, endLine: 5, note: "这里" });
    const sent = resourceMessage(`对照${pic}修改${file}`, [{ key: "a", id: "att-a" }]);
    const restored = resourceDraft(sent.text, [{ id: "att-a", path: "C:/attachments/a.png" }]);
    expect(resourceMessage(restored.text, restored.images)).toEqual(sent);
  });
  it("only converts whole http(s) URLs and leaves ordinary text and malformed tokens alone", () => {
    const url = "https://example.com?q=中文&x=[a]";
    expect(resourceMessage(urlResource(url)!, []).text).toBe(url);
    expect(urlResource("说明 https://example.com")).toBeNull();
    expect(urlResource("javascript:alert(1)")).toBeNull();
    const bad = "[[amo:file:bad-json]]";
    expect(resourceSpans(bad)).toEqual([]);
    expect(resourceText(bad)).toBe(bad);
  });
});
