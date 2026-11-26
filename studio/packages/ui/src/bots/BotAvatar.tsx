import { createContext, useState, type CSSProperties } from "react";
import { botMascotAvatar, botMascotId, PICKABLE_BOT_MASCOT_IDS, type BotMascotId, type StudioBot } from "@amo-studio/protocol";
import { IconPeople } from "../chat/icons.js";

export const TranscriptBots = createContext<readonly StudioBot[]>([]);

// Orca 的形象自带 128×128 天蓝底（SVG 里的 --avatar-bg 默认 #b3dbf4），按文件 URL 引用，不内联进脚本。
const MASCOTS = import.meta.glob<string>("./mascots/*.svg", { eager: true, query: "?url", import: "default" });
export const botMascotUrl = (id: BotMascotId): string => MASCOTS[`./mascots/${id}.svg`]!;

/** 头像要显示的图片地址；null 表示显示默认线条脸（包括较新版本才有的形象编号）。 */
export function botAvatarSrc(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  if (!avatar.startsWith("mascot:")) return avatar;
  const id = botMascotId(avatar);
  return id ? botMascotUrl(id) : null;
}

/** 随机换一个可选形象，且不同于当前这个；2026-11-26 用户定：新建 Bot 时预填一个。 */
export function randomBotMascot(current?: string | null, random = Math.random): string {
  const shown = botMascotId(current);
  const pool = PICKABLE_BOT_MASCOT_IDS.filter((id) => id !== shown);
  return botMascotAvatar(pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!);
}

export function botAvatarHue(name: string) {
  return [...name.trim()].reduce((value, char) => (value * 31 + char.codePointAt(0)!) % 360, 88);
}

export function BotAvatar({ name, avatar, size = 24 }: { name: string; avatar?: string | null; size?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  const hue = botAvatarHue(name);
  const src = botAvatarSrc(avatar);
  const style = { width: size, height: size, fontSize: Math.round(size * .47), "--avatar-hue": hue } as CSSProperties;
  return <span className="bot-avatar" aria-hidden="true" style={style}>
    {src && broken !== src ? <img src={src} alt="" draggable={false} onError={() => setBroken(src)} /> :
      <span className="bot-avatar-face" />}
  </span>;
}

export function BotGroupAvatar({ members, size = 21 }: { members: readonly StudioBot[]; size?: number }) {
  return <span className="bot-group-faces" aria-hidden="true">
    {members.slice(0, 2).map((bot) => <BotAvatar key={bot.id} name={bot.name} avatar={bot.avatar} size={size} />)}
    {!members.length && <span className="bot-group-empty-face" style={{ width: size, height: size }}><IconPeople /></span>}
  </span>;
}

export async function encodeBotAvatar(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error("请选择 8 MB 以内的 PNG、JPG 或 WebP 图片。");
  }
  const image = await createImageBitmap(file).catch(() => { throw new Error("无法读取图片，请换一张头像。"); });
  try {
    const side = Math.min(image.width, image.height);
    if (!side) throw new Error("图片没有可用尺寸。");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前窗口无法处理头像。");
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128);
    return canvas.toDataURL("image/png");
  } finally {
    image.close();
  }
}
