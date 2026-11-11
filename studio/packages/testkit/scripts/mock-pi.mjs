// Scripted Pi RPC peer. Tests never contact a provider or read the person's Pi configuration.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2), flag = (name) => args[args.indexOf(name) + 1];
const sessionId = args.includes("--session-id") ? flag("--session-id") : "mock-session";
const dir = args.includes("--session-dir") ? flag("--session-dir") : null;
const file = dir ? join(dir, "mock.jsonl") : null;
let count = 0, timer, active = false, waitingQuestion, name = "", model = { provider: "mock", id: "pi-test", name: "Pi 测试模型", reasoning: true, contextWindow: 128000 };
try { count = JSON.parse(readFileSync(file, "utf8")).count; } catch { /* A new session. */ }
const send = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const response = (req, data = {}) => send({ type: "response", id: req.id, command: req.type, success: true, data });
const message = (role, text, extra = {}) => ({ role, content: [{ type: "text", text }], timestamp: Date.now(), ...extra });
function settle(aborted = false) {
  if (!active) return;
  active = false;
  send({ type: "agent_end", messages: [], willRetry: false });
  send({ type: "agent_settled", aborted });
}
function finish(text) {
  count++;
  if (file) { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify({ count })); }
  const answer = `MOCK-PI ${count}: ${text}`;
  send({ type: "message_start", message: message("assistant", "") });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer } });
  send({ type: "message_end", message: message("assistant", answer, { stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2 } }) });
  settle();
}
async function handle(req) {
  switch (req.type) {
    case "get_state":
      if (process.env.MOCK_PI_START_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_PI_START_DELAY)));
      return response(req, { sessionId, sessionFile: file, model, thinkingLevel: "medium", isStreaming: active, sessionName: name });
    case "get_available_models": return response(req, { models: [model, { provider: "mock", id: "pi-other", name: "Pi 另一个模型", reasoning: false }] });
    case "set_model":
      if (req.modelId === "missing") return send({ type: "response", id: req.id, command: req.type, success: false, error: "Model not found" });
      model = { ...model, provider: req.provider, id: req.modelId }; return response(req, model);
    case "set_thinking_level": return response(req, { level: req.level });
    case "get_available_thinking_levels": return response(req, { levels: ["off", "low", "medium", "high"] });
    case "set_session_name": name = req.name; return response(req);
    case "get_commands": return response(req, { commands: [{ name: "mock-command", description: "模拟扩展命令", source: "extension" }] });
    case "clear_queue": return response(req, { steering: [], followUp: [] });
    case "abort": clearTimeout(timer); waitingQuestion = null; settle(true); return response(req);
    case "compact":
      send({ type: "compaction_start", reason: "manual" });
      send({ type: "compaction_end", reason: "manual", aborted: false, result: { tokensBefore: 100, estimatedTokensAfter: 25, summary: "Mock summary" } });
      return response(req, { summary: "Mock summary", tokensBefore: 100 });
    case "extension_ui_response":
      if (waitingQuestion) { const text = waitingQuestion; waitingQuestion = null; finish(`${text} -> ${req.value ?? req.confirmed ?? "cancelled"}`); }
      return;
    case "prompt": {
      active = true;
      response(req, { disposition: "started" });
      send({ type: "agent_start" });
      send({ type: "message_end", message: message("user", req.message) });
      if (req.message.includes("[[crash]]")) return process.exit(3);
      if (req.message.includes("[[hold]]")) return;
      if (req.message.includes("[[question]]")) {
        waitingQuestion = req.message;
        return send({ type: "extension_ui_request", id: "question-1", method: "select", title: "选择下一步", options: ["继续", "停止"] });
      }
      if (req.message.includes("[[tool]]")) {
        send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
        send({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: [{ type: "text", text: "mock file content" }] }, isError: false, durationMs: 2 });
      }
      if (req.message.includes("[[retry]]")) send({ type: "agent_end", messages: [], willRetry: true });
      timer = setTimeout(() => {
        if (req.message.includes("[[fail]]")) {
          send({ type: "message_end", message: message("assistant", "", { stopReason: "error", errorMessage: "mock provider failed" }) });
          settle();
        } else finish(req.message + (req.images?.length ? ` [images:${req.images.length}]` : ""));
      }, req.message.includes("[[retry]]") ? 100 : 30);
      return;
    }
    default: send({ type: "response", id: req.id, command: req.type, success: false, error: `Unsupported: ${req.type}` });
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { clearTimeout(timer); process.exit(0); });
