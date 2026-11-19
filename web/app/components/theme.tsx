import { Icon } from "~/components/ui";
import { useTheme, type ThemePref } from "~/lib/theme";

/** Bouton de la barre du haut : bascule entre clair et sombre (le choix fin, « Automatique » compris, est dans Réglages). */
export function ThemeToggle() {
  const { theme, setPref } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = next === "light" ? "Passer en mode clair" : "Passer en mode sombre";
  return (
    <button type="button" className="focus-btn theme-btn" onClick={() => setPref(next)} aria-label={label} title={label}>
      <Icon name={next === "light" ? "sun" : "moon"} />
    </button>
  );
}

const CHOICES: { value: ThemePref; label: string; icon: string }[] = [
  { value: "auto", label: "Automatique", icon: "monitor" },
  { value: "light", label: "Clair", icon: "sun" },
  { value: "dark", label: "Sombre", icon: "moon" },
];

/** Choix de l'apparence dans les réglages, gardé sur cet appareil. */
export function ThemeChoice() {
  const { pref, setPref } = useTheme();
  return (
    <div className="seg" role="radiogroup" aria-label="Apparence">
      {CHOICES.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={pref === c.value} onClick={() => setPref(c.value)}>
          <Icon name={c.icon} />
          <span>{c.label}</span>
        </button>
      ))}
    </div>
  );
}
