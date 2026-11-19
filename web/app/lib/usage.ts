import type { Usage } from "./types";

/** 1 234 567 → « 1,2 M », 45 600 → « 46 k ». */
export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString("fr-FR")} k`;
  return String(n);
}

/** Part du contexte relue depuis le cache : plus elle est haute, moins la session coûte. */
export function cacheShare(u: Usage) {
  const total = u.input + u.cacheRead + u.cacheWrite;
  return total ? Math.round((u.cacheRead / total) * 100) : 0;
}

export const totalTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite + u.output;
