import { useCallback, useEffect, useState } from "react";

/** Apparence choisie : « auto » suit le réglage du système. Gardée par appareil (localStorage). */
export type ThemePref = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "essaim.theme";
/** Couleur de la barre du navigateur / de la web app, alignée sur --bg. */
export const THEME_COLOR: Record<Theme, string> = { dark: "#090C15", light: "#F5F6FA" };
const CHANGE = "essaim:theme";

export const parsePref = (v: unknown): ThemePref => (v === "light" || v === "dark" ? v : "auto");
export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme => (pref === "auto" ? (systemDark ? "dark" : "light") : pref);

/**
 * Script inline du <head> : pose data-theme avant le premier rendu (pas de flash sombre → clair)
 * et suit le système tant que le choix est « auto ».
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,m=matchMedia("(prefers-color-scheme: dark)"),c=${JSON.stringify(THEME_COLOR)};
function p(){try{var v=localStorage.getItem(${JSON.stringify(THEME_KEY)});return v==="light"||v==="dark"?v:"auto"}catch(e){return "auto"}}
function a(){var v=p(),t=v==="auto"?(m.matches?"dark":"light"):v;d.dataset.theme=t;d.style.colorScheme=t;var e=document.querySelector('meta[name="theme-color"]');if(e)e.setAttribute("content",c[t])}
a();m.addEventListener("change",a);addEventListener(${JSON.stringify(CHANGE)},a);addEventListener("storage",function(e){if(e.key===${JSON.stringify(THEME_KEY)})a()})})();`;

/** Choix d'apparence, partagé entre le bouton de la barre du haut et les réglages. */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>("auto");
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const sync = () => {
      let v: string | null = null;
      try {
        v = localStorage.getItem(THEME_KEY);
      } catch {}
      setPrefState(parsePref(v));
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    };
    sync();
    // Le script du <head> applique le thème ; on se recale après lui (autre onglet, système, autre composant).
    const later = () => queueMicrotask(sync);
    const m = matchMedia("(prefers-color-scheme: dark)");
    addEventListener(CHANGE, later);
    addEventListener("storage", later);
    m.addEventListener("change", later);
    return () => {
      removeEventListener(CHANGE, later);
      removeEventListener("storage", later);
      m.removeEventListener("change", later);
    };
  }, []);

  const setPref = useCallback((next: ThemePref) => {
    try {
      if (next === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {}
    dispatchEvent(new Event(CHANGE));
  }, []);

  return { pref, theme, setPref };
}
