import { useFetcher } from "react-router";

import { Icon } from "~/components/ui";

/**
 * Bouton « Actualiser » (en haut à droite) : les runners se synchronisent tout de suite et retentent leurs essais
 * différés, puis la page recharge ses données. Utile quand un état semble figé.
 */
export function RefreshButton() {
  const fetcher = useFetcher<{ reached: string[] }>();
  const busy = fetcher.state !== "idle";
  const label = busy ? "Actualisation…" : "Actualiser : relance la synchro des machines et recharge la page";
  return (
    <button
      type="button"
      className={`focus-btn refresh-btn ${busy ? "spinning" : ""}`}
      onClick={() => fetcher.submit(null, { method: "post", action: "/actualiser" })}
      disabled={busy}
      aria-label={label}
      title={label}
    >
      <Icon name="reroll" />
    </button>
  );
}
