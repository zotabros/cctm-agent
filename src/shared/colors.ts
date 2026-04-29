// 12-color palette: warm earth tones + slate + teal. Avoid rainbow.
export const ACCOUNT_COLORS: readonly string[] = [
  "#B4490B", // copper
  "#C2410C", // burnt sienna
  "#A16207", // ochre
  "#854D0E", // bronze
  "#65A30D", // moss
  "#0F766E", // teal
  "#0E7490", // deep cyan
  "#475569", // slate
  "#5B5750", // taupe
  "#92400E", // umber
  "#7C2D12", // rust
  "#3F3F46", // graphite
] as const;

export function pickRandomColor(seed?: string): string {
  if (!seed) {
    return ACCOUNT_COLORS[Math.floor(Math.random() * ACCOUNT_COLORS.length)];
  }
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ACCOUNT_COLORS[Math.abs(h) % ACCOUNT_COLORS.length];
}
