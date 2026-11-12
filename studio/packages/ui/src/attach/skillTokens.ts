export interface SkillToken { start: number; end: number; name: string }

/** Match complete, available skill names; a variable, a partial name or a file path stays ordinary text. */
export function skillTokens(text: string, skills: readonly { name: string }[]): SkillToken[] {
  const names = new Set(skills.map((skill) => skill.name));
  const tokens: SkillToken[] = [];
  for (const match of text.matchAll(/(^|\s)([$/])([A-Za-z0-9][\w:.-]*)(?![\w:./-])/g)) {
    const start = match.index! + match[1]!.length;
    if (!names.has(match[3]!) || (match[2] === "/" && text.slice(0, start).trim())) continue;
    tokens.push({ start, end: start + match[2]!.length + match[3]!.length, name: match[3]! });
  }
  return tokens;
}
