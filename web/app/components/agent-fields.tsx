import { useState } from "react";

import { LinkFields, Switch } from "~/components/link-fields";
import { RoleFields } from "~/components/role-fields";
import { Icon } from "~/components/ui";
import type { Agent, AgentRepo, Repo } from "~/lib/types";

export interface Mate {
  id: string;
  name: string;
  role?: string;
}

/** Les repos auxquels l'agent travaille, avec ses droits sur chacun. */
function RepoLinks({ repos, links, mates, agentName }: { repos: Repo[]; links: AgentRepo[]; mates: Record<string, Mate[]>; agentName: string }) {
  const [picked, setPicked] = useState<string[]>(links.map((l) => l.repoId));
  if (!repos.length) {
    return (
      <p className="help">
        Aucun repo pour l'instant. <a href="/repos/nouveau">Ajoute un repo</a> d'abord, puis reviens rattacher l'agent.
      </p>
    );
  }
  return (
    <div className="repo-links">
      {repos.map((r) => {
        const on = picked.includes(r.id);
        const link = links.find((l) => l.repoId === r.id);
        return (
          <div key={r.id} className={`repo-pick${on ? " on" : ""}`}>
            <label className="tg" htmlFor={`pick-${r.id}`}>
              <span className="tg-text">
                <b className="mono">{r.repo}</b>
                <span>{on ? "L'agent y travaille" : "Pas de droits sur ce repo"}</span>
              </span>
              <span className="switch">
                <input type="checkbox" id={`pick-${r.id}`} name="repo" value={r.id} checked={on} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} />
                <i />
              </span>
            </label>
            {on && <LinkFields prefix={`l:${r.id}:`} link={link} mates={mates[r.id] ?? []} agentName={agentName} />}
          </div>
        );
      })}
      {picked.length > 1 && (
        <div className="field">
          <label htmlFor="primary">Repo principal</label>
          <select id="primary" name="primary" defaultValue={links[0]?.repoId ?? picked[0]}>
            {repos
              .filter((r) => picked.includes(r.id))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.repo}
                </option>
              ))}
          </select>
          <span className="help">Celui des conversations et des actions en un clic.</span>
        </div>
      )}
    </div>
  );
}

/**
 * Tous les réglages d'un agent, identiques à la création et à la modification : identité, rôle et modèle, autonomie,
 * Telegram, et les repos avec les droits de l'agent sur chacun.
 */
export function AgentFields({
  agent,
  repos,
  mates,
  errors = {},
  topic = "",
  nameField,
}: {
  agent?: Agent;
  repos: Repo[];
  mates: Record<string, Mate[]>;
  errors?: Record<string, string>;
  topic?: string;
  /** La création contrôle le nom (aperçu de l'avatar) ; sinon un champ simple. */
  nameField?: React.ReactNode;
}) {
  const s = agent?.settings;
  const p = agent ? "s-" : "";
  return (
    <>
      {nameField ?? (
        <div className="field">
          <label htmlFor={`${p}name`}>Nom</label>
          <input type="text" id={`${p}name`} name="name" autoComplete="off" maxLength={40} defaultValue={agent?.name} />
          {errors.name && <span className="err">{errors.name}</span>}
        </div>
      )}
      <fieldset className="field">
        <legend className="lbl">Machine</legend>
        <div className="choice">
          <label>
            <input type="radio" name="machine" value="mac" defaultChecked={agent?.machine !== "nuc"} />
            <Icon name="laptop" />
            <span>
              <b>PC</b>
              <span>Mon PC, lancé à la demande</span>
            </span>
          </label>
          <label>
            <input type="radio" name="machine" value="nuc" defaultChecked={agent?.machine === "nuc"} />
            <Icon name="server" />
            <span>
              <b>Serveur</b>
              <span>Tâches légères, toujours allumé</span>
            </span>
          </label>
        </div>
      </fieldset>

      <h3 className="sub">Rôle et modèle</h3>
      <RoleFields settings={s} idPrefix={p} />

      <h3 className="sub">Repos et droits</h3>
      <RepoLinks repos={repos} links={agent?.repos ?? []} mates={mates} agentName={agent?.name ?? "L'agent"} />

      <h3 className="sub">Autonomie</h3>
      <div className="toggles">
        <Switch id={`${p}yieldOnFocus`} name="yieldOnFocus" label="Te laisser la place" help="Pause quand « Je travaille » est actif" defaultChecked={s?.yieldOnFocus ?? true} />
      </div>
      <div className="field">
        <label htmlFor={`${p}max`}>Temps max par ticket (minutes)</label>
        <input type="number" min="0" step="30" id={`${p}max`} name="maxMinutes" defaultValue={s?.maxMinutes || ""} placeholder="Aucune limite" />
        <span className="help">Vide : aucune limite. Au-delà, l'agent pousse son travail et te pose la question.</span>
      </div>
      <div className="field">
        <label htmlFor={`${p}stall`}>Alerte si aucun jalon depuis (minutes)</label>
        <input type="number" min="0" step="30" id={`${p}stall`} name="stallMinutes" defaultValue={s?.stallMinutes ?? 180} />
        <span className="help">Une notification Telegram, l'agent continue. 0 : jamais.</span>
      </div>

      <h3 className="sub">Telegram</h3>
      <div className="field">
        <label htmlFor={`${p}topic`}>Sujet Telegram</label>
        <input type="text" inputMode="url" id={`${p}topic`} name="topic" autoComplete="off" key={topic} defaultValue={topic} placeholder="https://t.me/c/1234567890/42" aria-invalid={Boolean(errors.topic)} />
        {errors.topic ? <span className="err">{errors.topic}</span> : <span className="help">Lien du sujet de l'agent dans le groupe (appui long → Copier le lien). Vide : le bot tente de le créer.</span>}
      </div>
    </>
  );
}
