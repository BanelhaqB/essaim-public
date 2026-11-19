import { useEffect } from "react";
import { useRevalidator } from "react-router";

/** Recharge les données de la page toutes les `ms` tant que `active`, onglet visible seulement. */
export function usePolling(active: boolean, ms: number) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && state === "idle") void revalidate();
    }, ms);
    return () => clearInterval(id);
  }, [active, ms, revalidate, state]);
}
