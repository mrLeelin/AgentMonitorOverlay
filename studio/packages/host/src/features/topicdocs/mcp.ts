import { z } from "zod";
import { HostError } from "../../core/shared.js";
import { answer, write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { roleFacts } from "../guide/role.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function topicDocsTools({ service, caller, model, ownTopic }: ToolContext): AmoTool[] {
  return [
    {
      name: "topic_docs",
      title: "专题文档",
      description: "A topic's documents (your own topic's when no topic is given): without docId the list (titles, ids, when changed); with docId one document in full (Markdown). They are about driving the topic's tasks: plans, decisions, how the parts fit.",
      inputSchema: { topic: z.string().optional(), docId: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) =>
        answer(() => {
          if (args.docId !== undefined) return service.topicDocs.get(String(args.docId));
          const topic = model.topicRef(args.topic === undefined ? undefined : String(args.topic));
          return { topic: topic.title, docs: service.topicDocs.list(topic.id).map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, length: d.body.length })) };
        }),
    },
    {
      name: "topic_doc_write",
      title: "写专题文档",
      description: "The topic's own session or a lead may maintain its Studio topic documents — a new one (no docId; title required) or a new version of one (docId; title and/or body). This does not edit local project files. Keep it about driving the topic's tasks; point at specialised documents in the projects by path.",
      inputSchema: { docId: z.string().optional(), title: z.string().optional(), body: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const topicId = ownTopic(c);
          const facts = roleFacts(service, c.sessionId);
          if (facts.role !== "topic" && !facts.task?.lead) throw new HostError("bad_request", "只有主控或专题会话能写专题文档。请用 mailbox_send 把内容发给主控或专题会话。");
          if (args.docId === undefined) return service.topicDocs.create(topicId, { title: args.title, body: args.body });
          const doc = service.topicDocs.get(String(args.docId));
          if (doc.topicId !== topicId) throw new HostError("bad_request", `文档 ${doc.id} 不在你的专题里`);
          return service.topicDocs.update(doc.id, { ...(args.title !== undefined ? { title: args.title } : {}), ...(args.body !== undefined ? { body: args.body } : {}) });
        }),
    },
  ];
}
