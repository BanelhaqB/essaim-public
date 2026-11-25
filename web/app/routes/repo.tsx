import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { LinkFields } from "~/components/link-fields";
import { TeamFlow } from "~/components/role-fields";
import { Avatar, Icon } from "~/components/ui";
import { listAgents } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { addLink, deleteRepoRow, getRepo, removeLink, teamOfRepo, updateLink, updateRepoBrief } from "~/.server/repos";
import { readLink } from "~/lib/agent-form";

import type { Route } from "./+types/repo";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.repo.repo ?? "Repo"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const { DB } = serverEnv();
  const repo = await getRepo(DB, params.id);
  if (!repo) throw data("Ce repo n'existe pas.", { status: 404 });
  const [members, agents] = await Promise.all([teamOfRepo(DB, repo.id), listAgents(DB)]);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const team = members.flatMap((m) => {
    const a = byId.get(m.agentId);
    return a ? [{ agent: { id: a.id, name: a.name, seed: a.seed, hue: a.hue, role: a.settings.role ?? "", model: a.settings.model ?? "", otherRepos: a.repos.length - 1 }, link: m.link }] : [];
  });
  const free = agents.filter((a) => !byId.has(a.id) || !members.some((m) => m.agentId === a.id)).map((a) => ({ id: a.id, name: a.name }));
  return { repo, team, free };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const repo = await getRepo(DB, params.id);
  if (!repo) throw data("Ce repo n'existe pas.", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "brief") {
    await updateRepoBrief(DB, repo.id, String(form.get("brief") ?? "").slice(0, 60_000));
    return { saved: "brief" as const };
  }
  if (intent === "add") {
    const id = String(form.get("agent") ?? "");
    if ((await listAgents(DB)).some((a) => a.id === id)) await addLink(DB, id, repo.id);
    return { saved: "add" as const };
  }
  if (intent === "delete") {
    if (!(await deleteRepoRow(DB, repo.id))) return data({ error: "Retire d'abord tous les agents de ce repo." }, { status: 400 });
    return redirect("/repos");
  }
  // « team » : droits de chaque agent, et retraits.
  const members = await teamOfRepo(DB, repo.id);
  const removed = new Set(form.getAll("remove").map(String));
  const kept: string[] = [];
  const refused: string[] = [];
  for (const m of members) {
    if (removed.has(m.agentId)) {
      if (!(await removeLink(DB, m.agentId, repo.id))) {
        refused.push(m.agentId);
        kept.push(m.agentId);
      }
    } else kept.push(m.agentId);
  }
  for (const id of kept) {
    await updateLink(DB, id, readLink(form, `l:${id}:`, repo.id, kept.filter((x) => x !== id)));
  }
  if (refused.length) return data({ error: `${refused.join(", ")} : c'est son seul repo, il ne peut pas en être retiré. Rattache-le d'abord à un autre repo.` }, { status: 400 });
  return { saved: "team" as const };
}

export default function RepoPage({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, team, free } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [confirm, setConfirm] = useState(false);
  const saved = (k: string) => actionData && "saved" in actionData && actionData.saved === k && !busy;
  const error = actionData && "error" in actionData ? actionData.error : null;
  const mates = (id: string) => team.filter((t) => t.agent.id !== id).map((t) => ({ id: t.agent.id, name: t.agent.name, role: t.agent.role }));
  return (
    <div className="enter">
      <Link className="back" to="/repos">
        <Icon name="left" />
        Repos
      </Link>
      <div className="view-head">
        <div>
          <h1 className="mono">{repo.repo}</h1>
          <p>
            <a href={`https://github.com/${repo.repo}`} target="_blank" rel="noreferrer">
              Ouvrir sur GitHub
            </a>
            {repo.createMode && " · sera créé par l'agent au premier ticket"}
          </p>
        </div>
      </div>

      <Form method="post" className="panel task-editor">
        <input type="hidden" name="intent" value="brief" />
        <h2>Brief</h2>
        <p className="muted small">Ce qu'est le projet, ses objectifs et ses règles. Lu par tous les agents de ce repo au début de chaque session.</p>
        <textarea name="brief" rows={8} defaultValue={repo.brief} placeholder="Ce qu'est le projet, à qui il s'adresse, ses conventions…" />
        <div className="row">
          <button className="btn primary" disabled={busy}>
            Enregistrer le brief
          </button>
          {saved("brief") && (
            <span className="saved" role="status">
              <Icon name="check" /> Enregistré
            </span>
          )}
        </div>
      </Form>

      <section className="panel">
        <h2>Équipe</h2>
        {team.length === 0 ? (
          <p className="muted">Aucun agent n'est rattaché à ce repo.</p>
        ) : (
          <>
            {team.length > 1 && <TeamFlow team={team.map((t) => ({ id: t.agent.id, name: t.agent.name, role: t.agent.role, model: t.agent.model, handoffTo: t.link.handoffTo ?? "" }))} />}
            <Form method="post" className="settings">
              <input type="hidden" name="intent" value="team" />
              {team.map(({ agent, link }) => (
                <details key={agent.id} className="repo-pick on" open={team.length <= 2}>
                  <summary className="member">
                    <Avatar seed={agent.seed} hue={agent.hue} size={28} status="idle" />
                    <b>{agent.name}</b>
                    <span className="muted small">{agent.role || "sans rôle"}</span>
                    <Link className="small" to={`/agents/${agent.id}/reglages`}>
                      Réglages de l'agent
                    </Link>
                  </summary>
                  <LinkFields prefix={`l:${agent.id}:`} link={link} mates={mates(agent.id)} agentName={agent.name} />
                  <label className="remove">
                    <input type="checkbox" name="remove" value={agent.id} /> Retirer {agent.name} de ce repo{agent.otherRepos < 1 ? " (impossible : c'est son seul repo)" : ""}
                  </label>
                </details>
              ))}
              {error && <span className="err">{error}</span>}
              <div className="row">
                <button className="btn primary" disabled={busy}>
                  Enregistrer l'équipe
                </button>
                {saved("team") && (
                  <span className="saved" role="status">
                    <Icon name="check" /> Enregistrée
                  </span>
                )}
              </div>
            </Form>
          </>
        )}
        {free.length > 0 && (
          <Form method="post" className="row add-agent">
            <input type="hidden" name="intent" value="add" />
            <select name="agent" aria-label="Agent à rattacher" defaultValue={free[0].id}>
              {free.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button className="btn ghost" disabled={busy}>
              <Icon name="plus" /> Rattacher à ce repo
            </button>
          </Form>
        )}
        {free.length === 0 && team.length === 0 && (
          <p className="help">
            Aucun agent à rattacher. <Link to="/agents/nouveau">Crée un agent</Link>.
          </p>
        )}
      </section>

      <section className="panel danger-zone">
        <h2>Retirer le repo d'Essaim</h2>
        <p className="muted small">Le repo GitHub n'est pas touché. Possible seulement quand plus aucun agent n'y est rattaché.</p>
        {confirm ? (
          <Form method="post" className="row">
            <button className="btn danger" name="intent" value="delete">
              Retirer {repo.repo}
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
              Annuler
            </button>
          </Form>
        ) : (
          <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>
            <Icon name="x" /> Retirer…
          </button>
        )}
      </section>
    </div>
  );
}
