import type { ModelProfile, codex } from "@amo-studio/protocol";
import { codexThreadParams, type CodexConfig } from "../profiles.js";
import type { ReplyOnlyInput } from "../runtime.js";
import type { CodexRpcClient, ServerNotification, ServerRequest } from "./rpc-client.js";

const replyItems = new Set(["userMessage", "agentMessage", "reasoning"]);
const toolItems = new Set(["local_shell_call", "function_call", "custom_tool_call", "tool_search_call", "web_search_call", "image_generation_call", "agent_message"]);
const managedLayers = new Set(["legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]);

async function replyConfig(client: CodexRpcClient, cwd: string): Promise<CodexConfig> {
  const { config, origins } = await client.request("config/read", { cwd, includeLayers: false }) as codex.v2.ConfigReadResponse;
  const servers = config?.mcp_servers ?? {};
  if (!config || !origins || typeof servers !== "object" || Array.isArray(servers)) throw new Error("无法确认 Codex 的工具已关闭，记忆整理未启动。");
  const result: CodexConfig = {
    web_search: "disabled", project_doc_max_bytes: 0,
    "agents.enabled": false, "multi_agent_v2.disable_native_tools": true, "tools.update_plan.enabled": false,
  };
  // Model metadata can still declare built-in apply_patch. The read-only sandbox rejects writes from it.
  for (const feature of ["hooks", "plugins", "shell_tool", "unified_exec", "code_mode_host", "view_image", "image_generation", "apps", "browser_use", "browser_use_external", "in_app_browser", "in_app_local_automation", "computer_use", "multi_agent", "multi_agent_v2", "memories", "goals", "skill_search", "skill_mcp_dependency_install", "artifact"]) {
    result[`features.${feature}`] = false;
  }
  for (const name of Object.keys(servers)) {
    const key = `mcp_servers.${name}.enabled`;
    const layer = origins[key]?.name.type;
    if (!/^[A-Za-z0-9_-]+$/u.test(name) || (layer && managedLayers.has(layer))) {
      throw new Error("无法关闭 Codex 的 MCP 服务，记忆整理未启动。");
    }
    result[key] = false;
  }
  return result;
}

export async function codexReplyOnly(client: CodexRpcClient, profile: ModelProfile, input: ReplyOnlyInput): Promise<string> {
  const { cwd, options, signal } = input;
  signal.throwIfAborted();
  const config = await replyConfig(client, cwd);
  signal.throwIfAborted();
  const preset = codexThreadParams(profile);
  // The negotiated experimental fields keep the temporary thread disconnected from any working environment
  // and surface raw calls, including tools rejected before Codex creates a visible item.
  const start: codex.v2.ThreadStartParams & { experimentalRawEvents: boolean; environments: [] } = {
    ...preset, cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", serviceTier: "default",
    ...(options.model ? { model: options.model } : {}),
    config: { ...preset.config, ...config, ...(options.effort ? { model_reasoning_effort: options.effort } : {}) },
    baseInstructions: input.instructions,
    experimentalRawEvents: true, environments: [],
  };
  const { thread } = await client.request("thread/start", start);

  let turnId: string | undefined;
  let ended = false;
  let reply = "";
  let resolve!: (reply: string) => void;
  let reject!: (reason: unknown) => void;
  const completed = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
  const attemptedTool = () => reject(new Error("整理模型尝试调用工具，本次结果未保存。"));
  const onClose = () => reject(new Error("Codex 连接已关闭。"));
  const onAbort = () => reject(signal.reason);
  const onRequest = ({ method, params, id }: ServerRequest) => {
    if (!("threadId" in params) || params.threadId !== thread.id) return;
    client.respondError(id, -32000, `Text-only turn refused ${method}`);
    attemptedTool();
  };
  const onNotification = (event: ServerNotification) => {
    if (!("threadId" in event.params) || event.params.threadId !== thread.id) return;
    switch (event.method) {
      case "turn/started":
        turnId = event.params.turn.id;
        break;
      case "rawResponseItem/completed":
        if (toolItems.has(event.params.item.type)) attemptedTool();
        break;
      case "item/started":
      case "item/completed": {
        const { item } = event.params;
        if (!replyItems.has(item.type) || (item.type === "agentMessage" && item.delivery === "async")) attemptedTool();
        if (event.method === "item/completed" && item.type === "agentMessage" && item.phase !== "commentary") reply = item.text;
        break;
      }
      case "turn/completed":
        ended = true;
        if (event.params.turn.status === "completed" && reply.trim()) resolve(reply);
        else reject(new Error("Codex 未完成记忆整理回复。"));
        break;
    }
  };

  client.on("notification", onNotification).on("request", onRequest).on("close", onClose);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    else void client.request("turn/start", {
      threadId: thread.id, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: input.text, text_elements: [] }],
    })
      .then(({ turn }) => { turnId ??= turn.id; }, reject);
    return await completed;
  } finally {
    signal.removeEventListener("abort", onAbort);
    client.off("notification", onNotification).off("request", onRequest).off("close", onClose);
    if (turnId && !ended) await client.request("turn/interrupt", { threadId: thread.id, turnId }, { timeoutMs: 5000 }).catch(() => undefined);
    void client.request("thread/unsubscribe", { threadId: thread.id }, { timeoutMs: 5000 }).catch(() => undefined);
  }
}
