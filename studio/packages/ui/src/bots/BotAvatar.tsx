import { useState, type CSSProperties } from "react";

export function BotAvatar({ name, avatar, size = 24 }: { name: string; avatar?: string | null; size?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  const label = name.trim();
  const hue = [...label].reduce((value, char) => (value * 31 + char.codePointAt(0)!) % 360, 88);
  const style = { width: size, height: size, fontSize: Math.round(size * .47), "--avatar-hue": hue } as CSSProperties;
  return <span className="bot-avatar" aria-hidden="true" style={style}>
    {avatar && broken !== avatar ? <img src={avatar} alt="" draggable={false} onError={() => setBroken(avatar)} /> : [...label][0] || "B"}
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
