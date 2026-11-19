/**
 * Avatars des agents : un petit robot ailé dessiné à partir d'une graine (forme de tête, yeux, antenne, bouche, ailes en haut ou sur les côtés)
 * et d'une teinte. Le même dessin que la maquette ; ses animations viennent d'app.css (classes eo/ec/ex, body…).
 */
function hash(s: string) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function rng(seed: string) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEADS = { square: [20, 34, 60, 52, 16], round: [18, 32, 64, 56, 28], tall: [24, 28, 52, 60, 18], wide: [14, 38, 72, 46, 20] } as const;

export function avatarSvg(seed: string, hue: number): string {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const head = pick(["square", "round", "tall", "wide"] as const);
  const eyes = pick(["duo", "duo", "visor", "mono"] as const);
  const ant = pick(["ball", "double", "bolt", "ball"] as const);
  const mouth = pick(["smile", "grill", "dot", "smile", "none"] as const);
  const ears = r() > 0.35;
  const cheeks = r() > 0.45;
  // Tiré après les autres traits : les avatars existants gardent leur tête, leurs yeux et leurs antennes.
  const wings = pick(["top", "side"] as const);
  const B = `hsl(${hue} 70% 66%)`, S = `hsl(${hue} 48% 46%)`, F = `hsl(${hue} 45% 12%)`, G = `hsl(${hue} 100% 89%)`, C = `hsl(${(hue + 35) % 360} 90% 72%)`;
  const [hx, hy, hw, hh, hr] = HEADS[head];
  const cx = 50, fx = hx + 7, fy = hy + 8, fw = hw - 14, fh = hh - 18, fr = Math.max(6, hr - 6), ey = fy + fh * 0.44, my = fy + fh * 0.79;
  let s = `<ellipse class="shadow" cx="50" cy="95" rx="24" ry="3.2" fill="#000" opacity=".4"/><g class="body">`;
  const wing = (x: number, y: number, rot: number) =>
    `<g transform="rotate(${rot} ${x} ${y})"><ellipse class="wing" cx="${x}" cy="${y}" rx="17" ry="9" fill="#fff" fill-opacity=".28" stroke="${G}" stroke-opacity=".7" stroke-width="1.4"/></g>`;
  s += wings === "top" ? wing(hx + 2, hy + 2, -32) + wing(hx + hw - 2, hy + 2, 32) : wing(hx - 6, hy + hh - 8, -14) + wing(hx + hw + 6, hy + hh - 8, 14);
  if (ant === "ball") s += `<line x1="50" y1="${hy}" x2="50" y2="${hy - 12}" stroke="${S}" stroke-width="3" stroke-linecap="round"/><circle class="light" cx="50" cy="${hy - 16}" r="5" fill="${G}"/>`;
  if (ant === "double") s += `<path d="M41 ${hy + 1}L34 ${hy - 10}M59 ${hy + 1}L66 ${hy - 10}" stroke="${S}" stroke-width="3" stroke-linecap="round"/><circle class="light" cx="33" cy="${hy - 13}" r="4" fill="${G}"/><circle class="light" cx="67" cy="${hy - 13}" r="4" fill="${G}"/>`;
  if (ant === "bolt") s += `<polyline points="50,${hy} 45,${hy - 6} 55,${hy - 11} 50,${hy - 16}" fill="none" stroke="${S}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle class="light" cx="50" cy="${hy - 19}" r="3.6" fill="${G}"/>`;
  if (ears) s += `<rect x="${hx - 6}" y="${hy + hh / 2 - 9}" width="9" height="18" rx="3.5" fill="${S}"/><rect x="${hx + hw - 3}" y="${hy + hh / 2 - 9}" width="9" height="18" rx="3.5" fill="${S}"/>`;
  s += `<rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="${hr}" fill="${B}"/><rect x="${hx + hr * 0.6 + 2}" y="${hy + 3}" width="${hw * 0.3}" height="3.5" rx="1.75" fill="#fff" opacity=".3"/><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="${fr}" fill="${F}"/>`;
  const cross = (x: number, y: number, k: number) => `<path d="M${x - k} ${y - k}L${x + k} ${y + k}M${x + k} ${y - k}L${x - k} ${y + k}" stroke="${G}" stroke-width="2.6" stroke-linecap="round"/>`;
  let eo = "", ec = "", ex = "";
  if (eyes === "duo") {
    const o = Math.min(12, fw * 0.24);
    eo = `<circle cx="${cx - o}" cy="${ey}" r="6" fill="${G}"/><circle cx="${cx + o}" cy="${ey}" r="6" fill="${G}"/><circle class="pupil" cx="${cx - o + 1.2}" cy="${ey + 0.8}" r="2.5" fill="${F}"/><circle class="pupil" cx="${cx + o + 1.2}" cy="${ey + 0.8}" r="2.5" fill="${F}"/>`;
    ec = `<path d="M${cx - o - 6} ${ey}q6 4.5 12 0M${cx + o - 6} ${ey}q6 4.5 12 0" fill="none" stroke="${G}" stroke-width="2.6" stroke-linecap="round"/>`;
    ex = cross(cx - o, ey, 4) + cross(cx + o, ey, 4);
  } else if (eyes === "visor") {
    const w = Math.min(36, fw - 10);
    eo = `<rect x="${cx - w / 2}" y="${ey - 5.5}" width="${w}" height="11" rx="5.5" fill="${G}" opacity=".22"/><circle class="scan" cx="${cx}" cy="${ey}" r="4.2" fill="${G}"/>`;
    ec = `<path d="M${cx - w / 2 + 3} ${ey}H${cx + w / 2 - 3}" stroke="${G}" stroke-width="2.6" stroke-linecap="round" opacity=".75"/>`;
    ex = cross(cx - 8, ey, 3.5) + cross(cx + 8, ey, 3.5);
  } else {
    eo = `<circle cx="${cx}" cy="${ey}" r="9" fill="${G}"/><circle class="pupil" cx="${cx + 1.5}" cy="${ey + 1}" r="3.8" fill="${F}"/><circle cx="${cx + 3.6}" cy="${ey - 3}" r="1.4" fill="#fff"/>`;
    ec = `<path d="M${cx - 9} ${ey}q9 6 18 0" fill="none" stroke="${G}" stroke-width="2.6" stroke-linecap="round"/>`;
    ex = cross(cx, ey, 5);
  }
  s += `<g class="eo" style="animation-delay:-${(r() * 5).toFixed(2)}s">${eo}</g><g class="ec">${ec}</g><g class="ex">${ex}</g>`;
  if (cheeks) s += `<circle cx="${cx - fw * 0.36}" cy="${ey + 7.5}" r="3.2" fill="${C}" opacity=".45"/><circle cx="${cx + fw * 0.36}" cy="${ey + 7.5}" r="3.2" fill="${C}" opacity=".45"/>`;
  if (mouth === "smile") s += `<path d="M${cx - 6} ${my - 1.5}q6 4.5 12 0" fill="none" stroke="${G}" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>`;
  if (mouth === "grill") s += `<path d="M${cx - 6} ${my - 3}v4.5M${cx} ${my - 3}v4.5M${cx + 6} ${my - 3}v4.5" stroke="${G}" stroke-width="2.2" stroke-linecap="round" opacity=".7"/>`;
  if (mouth === "dot") s += `<rect x="${cx - 4}" y="${my - 2}" width="8" height="4" rx="2" fill="${G}" opacity=".8"/>`;
  return `<svg viewBox="0 0 100 100" focusable="false">${s}</g></svg>`;
}

/** Teinte reçue d'un formulaire : entier de 0 à 359 ; `fallback` si la valeur est vide ou invalide (0, le rouge, reste valable). */
export function parseHue(value: unknown, fallback = 200): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return ((Math.round(n) % 360) + 360) % 360;
}
