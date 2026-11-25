import { useState } from "react";
import { EFFORTS, MODELS, ROLE_PRESETS } from "~/lib/agent-role";
import type { AgentSettings } from "~/lib/types";

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  model: string;
  handoffTo: string;
}

const MODEL_LABEL: Record<string, string> = Object.fromEntries(MODELS.map((m) => [m.value, m.label.split(" ")[0]]));

/** La chaîne de relais d'un repo : qui passe la main à qui, avec le rôle et le modèle de chacun. */
export function TeamFlow({ team, currentId }: { team: TeamMember[]; currentId?: string }) {
  const byId = new Map(team.map((m) => [m.id, m]));
  const targets = new Set(team.map((m) => m.handoffTo).filter(Boolean));
  // On part des agents que personne ne précède, puis on suit les relais (en s'arrêtant aux boucles).
  const starts = team.filter((m) => !targets.has(m.id));
  const chains = (starts.length ? starts : team.slice(0, 1)).map((s) => {
    const seen = new Set<string>();
    const chain: TeamMember[] = [];
    for (let m: TeamMember | undefined = s; m && !seen.has(m.id); m = byId.get(m.handoffTo)) {
      seen.add(m.id);
      chain.push(m);
    }
    return chain;
  });
  const inChain = new Set(chains.flat().map((m) => m.id));
  const alone = team.filter((m) => !inChain.has(m.id));
  const card = (m: TeamMember) => (
    <span key={m.id} className={`tf-node${m.id === currentId ? " me" : ""}`}>
      <b>{m.name}</b>
      <span>{[m.role || "sans rôle", MODEL_LABEL[m.model] || "modèle par défaut"].join(" · ")}</span>
    </span>
  );
  return (
    <div className="team-flow">
      {chains.map((chain, i) => (
        <div className="tf-row" key={i}>
          {chain.map((m, j) => (
            <span className="tf-step" key={m.id}>
              {j > 0 && <i aria-hidden="true">→</i>}
              {card(m)}
            </span>
          ))}
        </div>
      ))}
      {alone.length > 0 && <div className="tf-row">{alone.map(card)}</div>}
      <p className="help">Quand un agent termine, la tâche passe à l'agent suivant. S'il demande des corrections, elles reviennent automatiquement à l'auteur.</p>
    </div>
  );
}

/** Rôle, consignes, modèle et effort d'un agent ; partagé par la création et les réglages. `idPrefix` évite les ids en double. */
export function RoleFields({ settings, idPrefix = "" }: { settings?: AgentSettings; idPrefix?: string }) {
  const [role, setRole] = useState(settings?.role ?? "");
  const [instructions, setInstructions] = useState(settings?.instructions ?? "");
  const [model, setModel] = useState(settings?.model ?? "");
  const [effort, setEffort] = useState(settings?.effort ?? "");
  const id = (n: string) => `${idPrefix}${n}`;

  const applyPreset = (presetId: string) => {
    const p = ROLE_PRESETS.find((r) => r.id === presetId);
    if (!p) return;
    setRole(p.role);
    setInstructions(p.instructions);
    setModel(p.model);
    setEffort(p.effort);
  };

  return (
    <>
      <div className="field">
        <label htmlFor={id("preset")}>Rôle type (optionnel)</label>
        <select id={id("preset")} defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
          <option value="">Choisir pour pré-remplir…</option>
          {ROLE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.role}
            </option>
          ))}
        </select>
        <span className="help">Plusieurs agents peuvent partager un repo : donne à chacun une responsabilité distincte.</span>
      </div>
      <div className="field">
        <label htmlFor={id("role")}>Rôle</label>
        <input type="text" id={id("role")} name="role" autoComplete="off" maxLength={60} placeholder="Ex. : reviewer, testeur, dev backend" value={role} onChange={(e) => setRole(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id("instructions")}>Consignes du rôle</label>
        <textarea id={id("instructions")} name="instructions" rows={4} maxLength={2000} placeholder="Ce que cet agent fait et ne fait pas." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id("model")}>Modèle</label>
        <select id={id("model")} name="model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Par défaut de la machine</option>
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={id("effort")}>Effort de réflexion</label>
        <select id={id("effort")} name="effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">Par défaut de la machine</option>
          {EFFORTS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
