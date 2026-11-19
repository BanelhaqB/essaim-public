import { describe, expect, it } from "vitest";

import { THEME_SCRIPT, parsePref, resolveTheme } from "~/lib/theme";

describe("apparence", () => {
  it("garde seulement les choix connus", () => {
    expect(parsePref("light")).toBe("light");
    expect(parsePref("dark")).toBe("dark");
    expect(parsePref(null)).toBe("auto");
    expect(parsePref("sepia")).toBe("auto");
  });

  it("« auto » suit le système, sinon le choix prime", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("le script du <head> applique le thème et la couleur de la barre", () => {
    const listeners: Record<string, () => void> = {};
    const meta = { content: "", setAttribute(_: string, v: string) { this.content = v; } };
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    const store = new Map([["essaim.theme", "light"]]);
    const run = new Function("document", "matchMedia", "localStorage", "addEventListener", THEME_SCRIPT);
    run(
      { documentElement: root, querySelector: () => meta },
      () => ({ matches: true, addEventListener: () => {} }),
      { getItem: (k: string) => store.get(k) ?? null },
      (t: string, f: () => void) => (listeners[t] = f),
    );
    expect(root.dataset.theme).toBe("light");
    expect(meta.content).toBe("#F5F6FA");
    store.delete("essaim.theme");
    listeners["essaim:theme"]();
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});
