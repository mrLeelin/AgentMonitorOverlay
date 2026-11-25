import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_BOARD_PORT } from "@amo-studio/protocol";
import { startTeamBoardServer } from "./server.js";

const relay = process.env.AMO_TEAM_BOARD_RELAY;
if (!relay) throw new Error("请设置 AMO_TEAM_BOARD_RELAY 为 AMO 团队账号服务地址");
const data = process.env.AMO_TEAM_BOARD_DATA_DIR ?? join(process.env.APPDATA ?? homedir(), "AMO Team Board");
const server = await startTeamBoardServer({ path: join(data, "board.sqlite"), relay, web: fileURLToPath(new URL("../dist-web", import.meta.url)), host: process.env.AMO_TEAM_BOARD_HOST ?? "127.0.0.1", port: Number(process.env.AMO_TEAM_BOARD_PORT ?? TEAM_BOARD_PORT), origin: process.env.AMO_TEAM_BOARD_ORIGIN });
console.log(`AMO 团队看板监听 ${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void server.close());
