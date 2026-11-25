import type { AgentRepo } from "~/lib/types";

export function Switch({ id, name, label, help, defaultChecked }: { id: string; name: string; label: string; help: string; defaultChecked?: boolean }) {
  return (
    <label className="tg" htmlFor={id}>
      <span className="tg-text">
        <b>{label}</b>
        <span>{help}</span>
      </span>
      <span className="switch">
        <input type="checkbox" id={id} name={name} defaultChecked={defaultChecked} />
        <i />
      </span>
    </label>
  );
}

/**
 * Les droits d'un agent sur un repo : accès, merge, déploiement, stores, et à qui passer la main quand il a fini.
 * Les champs se nomment `${prefix}merge`, `${prefix}handoffTo`… (lus par readLink).
 */
export function LinkFields({ prefix, link, mates, agentName = "L'agent" }: { prefix: string; link?: Partial<AgentRepo>; mates: Array<{ id: string; name: string; role?: string }>; agentName?: string }) {
  const id = (n: string) => `${prefix}${n}`;
  const next = mates.find((m) => m.id === link?.handoffTo);
  return (
    <div className="link-fields">
      <div className="field">
        <label htmlFor={id("access")}>Accès</label>
        <select id={id("access")} name={id("access")} defaultValue={link?.access ?? "write"}>
          <option value="write">Lecture et écriture (branches, PR)</option>
          <option value="read">Lecture seule (ne pousse rien)</option>
        </select>
      </div>
      <div className="toggles">
        <Switch id={id("merge")} name={id("merge")} label="Merger seul" help="Quand la CI est verte" defaultChecked={link?.merge ?? true} />
        <Switch id={id("deploy")} name={id("deploy")} label="Déployer sur Cloudflare" help="Quand le ticket le demande" defaultChecked={link?.deploy ?? true} />
        <Switch id={id("store")} name={id("store")} label="Publier sur les stores" help="App Store et Play Console" defaultChecked={link?.store ?? false} />
      </div>
      <div className="field">
        <label htmlFor={id("handoffTo")}>Quand j'ai terminé, passer la main à</label>
        <select id={id("handoffTo")} name={id("handoffTo")} defaultValue={link?.handoffTo ?? ""} disabled={mates.length === 0}>
          <option value="">Personne</option>
          {mates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.role ? ` (${m.role})` : ""}
            </option>
          ))}
        </select>
        <span className="help">
          {mates.length === 0
            ? "Rattache un autre agent à ce repo pour former une équipe."
            : next
              ? `${agentName} termine une PR, ${next.name} la reçoit comme tâche prête. S'il demande des corrections, elles reviennent à l'auteur. Désactive « Merger seul » ici : c'est ${next.name} qui décide.`
              : "Sans relais, l'agent s'arrête à la fin de sa tâche."}
        </span>
      </div>
      <div className="field">
        <label htmlFor={id("maxRounds")}>Allers-retours de corrections avant de t'appeler</label>
        <input type="number" min="1" max="10" id={id("maxRounds")} name={id("maxRounds")} defaultValue={link?.maxRounds ?? 3} />
      </div>
    </div>
  );
}
