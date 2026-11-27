const paths = {
  plus: "M8 3v10M3 8h10",
  close: "m4 4 8 8m0-8-8 8",
  check: "m3 8 3 3 7-7",
  folder: "M2 5V3h4l2 2h6v8H2z",
  back: "m9 4-4 4 4 4",
  next: "m6 4 4 4-4 4",
  goal: "M13 8a5 5 0 1 1-5-5m7 5a7 7 0 1 1-7-7m.1 7L14 2m-1 0h1v1",
  pen: "M1.5 10C4 7 8.2 2.8 9 4s-5.2 7.3-3.5 7.7 4-4.5 5.2-3.5-1.8 3.7-.5 4.3c.8.4 1.7-.4 3.8-2",
  select: "m3 2 11 4.5-5 2-2 5z",
  text: "M3 4h10M8 4v9m-2 0h4M3 4v2m10-2v2",
  shapes: "M4.7 10.5A4 4 0 1 1 9.8 5M8 6h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  eraser: "m2.5 9 6.7-6.7a1.2 1.2 0 0 1 1.7 0l2.8 2.8a1.2 1.2 0 0 1 0 1.7L7.5 13H5l-2.5-2.4a1.2 1.2 0 0 1 0-1.6zm2.4-2.2L9 11",
  undo: "M6 3 2 7l4 4M2 7h8a3 3 0 0 1 0 6H8",
  redo: "m10 3 4 4-4 4m4-4H6a3 3 0 0 0 0 6h2",
  line: "M3 13 13 3",
  arrow: "M3 13 13 3m-6 0h6v6",
  rect: "M3 3h10v10H3z",
  ellipse: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11",
  triangle: "m8 3 6 10H2z",
  diamond: "m8 3 6 5-6 5-6-5z",
  star: "m8 2 1.7 3.7 4.3.6-3 3 .7 4.2L8 11.6l-3.7 1.9.7-4.2-3-3 4.3-.6z",
  heart: "M8 13 3 8a3 3 0 0 1 5-3.2A3 3 0 0 1 13 8z",
} satisfies Record<string, string>;

export function ComposerToolIcon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
