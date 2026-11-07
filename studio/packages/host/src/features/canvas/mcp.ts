import { z } from "zod";
import { HostError } from "../../core/shared.js";
import { NotFoundError } from "../../mcp/read-model.js";
import { write, fail, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function canvasTools({ service, caller, model, ownTopic, inOwnTopic }: ToolContext): AmoTool[] {
  return [
    {
      name: "canvas_read",
      title: "画布",
      description: "A topic's canvas as structure (your own topic's when no topic id or title is given): groups with their tasks, reference cards (引用: tasks of other topics, with their own topic and project) and notes, ungrouped items, the topic's tasks not placed yet, dependencies, review items (#n, status, conclusion) and the remarks and questions on cards not put away yet, with the person's answers. Returns a readable outline and the same data as JSON, without coordinates by default. Set layout: true to include group rectangles and card positions/sizes in JSON for moving or arranging them.",
      inputSchema: { topic: z.string().optional(), layout: z.boolean().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => {
        try {
          const topic = args.topic === undefined ? undefined : String(args.topic);
          const { outline, json: data } = model.canvasRead(topic);
          const doc = args.layout === true ? service.canvases.canvas(model.topicRef(topic).id) : null;
          const result = doc ? {
            ...data,
            layout: {
              groups: doc.groups.map(({ id, rect }) => ({ id, rect })),
              nodes: doc.nodes.map((n) => ({ id: n.id, kind: n.kind, ...("taskId" in n ? { taskId: n.taskId } : {}), groupId: n.groupId, pos: n.pos, ...(n.size ? { size: n.size } : {}) })),
            },
          } : data;
          return { content: [{ type: "text", text: outline }, { type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          if (err instanceof NotFoundError || err instanceof HostError) return fail(err.message);
          throw err;
        }
      },
    },
    {
      name: "canvas_group_create",
      title: "画布建组",
      description: "Create a group on your topic's canvas (optionally bound to a project, by id or name). Studio places it. Leads manage directly; other roles need the person's approval.",
      inputSchema: { title: z.string(), workspace: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => service.canvases.canvasCreateGroup(ownTopic(c), args, c.sessionId)),
    },
    {
      name: "canvas_depend",
      title: "画布连依赖",
      description: "Record on your topic's canvas that toTaskId depends on fromTaskId (fromTaskId must finish first); both must be tasks of your topic. Refused if it would make a cycle. Leads manage directly; other roles need the person's approval.",
      inputSchema: { fromTaskId: z.string(), toTaskId: z.string() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => (inOwnTopic(c, args.fromTaskId, args.toTaskId), service.canvases.canvasAddDependency(args.fromTaskId, args.toTaskId, c.sessionId))),
    },
    {
      name: "canvas_collaborate",
      title: "画布协作关系",
      description: "Create or remove an undirected collaboration relation between two task cards on your topic's canvas. It grants no management permission and does not block task start. Ordinary links and dependency arrows remain separate. Both tasks must be in your management range; use the person's canvas entry point for peer or cross-team collaboration.",
      inputSchema: { fromTaskId: z.string(), toTaskId: z.string(), remove: z.boolean().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => service.canvases.canvasCollaborate(ownTopic(c), args, c.sessionId)),
    },
    {
      name: "canvas_color",
      title: "画布标颜色",
      description: "Mark a task card, reference card, note or group on your topic's canvas with a colour (red, yellow, green, blue), or take the mark off (none). The colour is the card's outline; what each colour means is the person's (state, priority…). target: a task id, or a group's or note's id from canvas_read.",
      inputSchema: { target: z.string(), color: z.enum(["red", "yellow", "green", "blue", "none"]) },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.canvases.canvasSetColor(ownTopic(c), args, c.sessionId)),
    },
    {
      name: "canvas_place",
      title: "画布归组",
      description: "Put a task of your topic into a group on its canvas (groupId), or take it out of its group (omit groupId). Studio picks the position. Leads manage directly; other roles need the person's approval.",
      inputSchema: { taskId: z.string(), groupId: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => (inOwnTopic(c, args.taskId), service.canvases.canvasPlaceTask(args.taskId, args.groupId ?? null, c.sessionId))),
    },
    {
      name: "canvas_arrange",
      title: "画布移动排序",
      description: "Arrange cards or groups on your topic's canvas in the given targets order, vertically (default) or horizontally. Targets: task ids, node/group ids from canvas_read, or #n for review items. Cards must share a group, or be ungrouped (ungrouped cards may be arranged with groups). Studio starts at the selection's top-left and uses actual card sizes; moving a group moves its cards. Keeps memberships, content and connections. Refuses missing/duplicate targets, or selecting a group together with its card. Returns the resulting positions.",
      inputSchema: { targets: z.array(z.string()).min(1).max(200), direction: z.enum(["vertical", "horizontal"]).optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => service.canvases.canvasArrange(ownTopic(c), args, c.sessionId)),
    },
    {
      name: "canvas_move",
      title: "画布移动",
      description: "Move a card or group on your topic's canvas to x/y. Target: a task id, node/group id from canvas_read, or #n for a review item. Moving a group carries its cards; moving a grouped card keeps its membership and grows the group to contain it. Keeps card content and connections. Returns the resulting position.",
      inputSchema: { target: z.string(), x: z.number().finite(), y: z.number().finite() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => service.canvases.canvasMove(ownTopic(c), args, c.sessionId)),
    },
  ];
}
