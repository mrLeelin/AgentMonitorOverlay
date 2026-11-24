import electron = require("electron");
import type { TeamTasksDesktop } from "@amo-studio/protocol" with { "resolution-mode": "import" };

const invoke = <K extends keyof TeamTasksDesktop>(name: K, ...args: Parameters<TeamTasksDesktop[K]>): ReturnType<TeamTasksDesktop[K]> => electron.ipcRenderer.invoke(`team-tasks:${name}`, ...args) as ReturnType<TeamTasksDesktop[K]>;
electron.contextBridge.exposeInMainWorld("teamTasks", {
  identity: () => invoke("identity"),
  list: () => invoke("list"),
  detail: (id) => invoke("detail", id),
  create: (input) => invoke("create", input),
  change: (id, input) => invoke("change", id, input),
  saveAttachment: (id, file) => invoke("saveAttachment", id, file),
} satisfies TeamTasksDesktop);
