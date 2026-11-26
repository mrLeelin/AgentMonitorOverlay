import type { StudioBot } from "@amo-studio/protocol";

export type GroupReplyChoice = "all" | "mentions" | `bot:${string}`;
export const EVERYONE = "everyone";
const normalized = (text: string) => text.normalize("NFKC").toLowerCase();
const mentionStart = /(^|[\s([{【“‘、。,.!?;:])@/gu;
const mentionEnd = /^($|[\s)\]}）】"'”’，、。；：！？!?.,:;])/u;

export function groupMentionNames(text: string, members: readonly StudioBot[]): string[] {
  const source = normalized(text);
  const choices = [EVERYONE, ...members.map((bot) => bot.name)].map((name) => ({ name, token: normalized(name) }))
    .sort((a, b) => b.token.length - a.token.length);
  return [...new Set([...source.matchAll(mentionStart)].flatMap((match) => {
    const start = match.index + match[0].length;
    const hit = choices.find(({ token }) => source.startsWith(token, start) && mentionEnd.test(source.slice(start + token.length, start + token.length + 1)));
    return hit ? [hit.name] : [];
  }))];
}

export function groupReplyTargets(text: string, members: readonly StudioBot[], choice: GroupReplyChoice): string[] {
  const mentioned = groupMentionNames(text, members);
  const enabled = members.filter((bot) => bot.enabled);
  if (mentioned.includes(EVERYONE)) return enabled.map((bot) => bot.id);
  if (mentioned.length) return enabled.filter((bot) => mentioned.includes(bot.name)).map((bot) => bot.id);
  if (choice === "all") return enabled.map((bot) => bot.id);
  return enabled.filter((bot) => choice === `bot:${bot.id}`).map((bot) => bot.id);
}
