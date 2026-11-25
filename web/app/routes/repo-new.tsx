import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { createTask, listAgents } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { addLink, ensureRepoRow, getRepo, repoSlug } from "~/.server/repos";
import { initTask, MIN_DESCRIPTION, parseRepo, usualOwner } from "~/lib/new-project";

import type { Route } from "./+types/repo-new";

export const meta: Route.MetaFunction = () => [{ title: "Ajouter un repo · Essaim" }];

export async function loader() {
  const agents = await listAgents(serverEnv().DB);
  return { owner: usualOwner(agents.flatMap((a) => a.repos.map((r) => r.repo))), agents: agents.map((a) => ({ id: a.id, name: a.name })) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const { DB } = serverEnv();
  const repo = parseRepo(form.get("repo"));
  // Nouveau projet : le repo n'existe pas encore, un agent le crée et part de la description.
  const fresh = form.get("fresh") === "on";
  const description = String(form.get("description") ?? "").trim().slice(0, 4000);
  const errors: Record<string, string> = {};
  if (!repo) errors.repo = "Au format propriétaire/nom, par exemple ton-compte/mon-app.";
  else if (await getRepo(DB, repoSlug(repo))) errors.repo = "Ce repo est déjà dans Essaim.";
  if (fresh && description.length < MIN_DESCRIPTION) errors.description = "Décris le projet en quelques phrases : c'est le point de départ de l'agent.";
  const agents = await listAgents(DB);
  const starter = agents.find((a) => a.id === form.get("agent"));
  if (fresh && !starter) errors.agent = "Choisis l'agent qui va créer et initialiser le projet.";
  if (Object.keys(errors).length || !repo) return data({ errors }, { status: 400 });
  const id = await ensureRepoRow(DB, repo, { brief: description, createMode: fresh ? (form.get("public") === "on" ? "public" : "private") : null });
  if (starter) {
    await addLink(DB, starter.id, id);
    if (fresh) await createTask(DB, { agentId: starter.id, repoId: id, ...initTask(repo, description), status: "prete" });
  }
  return redirect(`/repos/${id}`);
}

export default function NewRepo({ actionData, loaderData }: Route.ComponentProps) {
  const [fresh, setFresh] = useState(false);
  const nav = useNavigation();
  const errors = (actionData as { errors?: Record<string, string> } | undefined)?.errors ?? {};
  const busy = nav.state === "submitting";
  return (
    <div className="enter">
      <Link className="back" to="/repos">
        <Icon name="left" />
        Repos
      </Link>
      <div className="view-head">
        <div>
          <h1>Ajouter un repo</h1>
          <p>Un repo existant, ou un nouveau projet que l'agent crée. Tu rattacheras ensuite des agents, chacun avec ses droits.</p>
        </div>
      </div>
      <Form method="post" className="panel settings" noValidate>
        <label className="tg" htmlFor="fresh">
          <span className="tg-text">
            <b>Nouveau projet</b>
            <span>Pas encore de repo : un agent le crée et pose les fondations à partir de ta description.</span>
          </span>
          <span className="switch">
            <input type="checkbox" id="fresh" name="fresh" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
            <i />
          </span>
        </label>
        <div className="field">
          <label htmlFor="repo">{fresh ? "Repo à créer" : "Repo GitHub"}</label>
          <input type="text" id="repo" name="repo" autoComplete="off" placeholder={loaderData.owner ? `${loaderData.owner}/mon-app` : "ton-compte/mon-app"} aria-invalid={Boolean(errors.repo)} />
          {errors.repo ? <span className="err">{errors.repo}</span> : <span className="help">Le compte GitHub connecté sur la machine du runner doit pouvoir y pousser.</span>}
        </div>
        <div className="field">
          <label htmlFor="description">{fresh ? "Description du projet" : "Brief du projet (optionnel)"}</label>
          <textarea id="description" name="description" rows={fresh ? 5 : 3} maxLength={4000} placeholder="Ce qu'est le projet, pour qui, les fonctions clés, la stack, les règles à respecter." aria-invalid={Boolean(errors.description)} />
          {errors.description ? <span className="err">{errors.description}</span> : <span className="help">Le brief est partagé par tous les agents du repo ; tu pourras le modifier ensuite.</span>}
        </div>
        {fresh && (
          <label className="tg" htmlFor="public">
            <span className="tg-text">
              <b>Repo public</b>
              <span>Privé sinon</span>
            </span>
            <span className="switch">
              <input type="checkbox" id="public" name="public" />
              <i />
            </span>
          </label>
        )}
        <div className="field">
          <label htmlFor="agent">{fresh ? "Agent qui crée le repo" : "Rattacher un agent maintenant (optionnel)"}</label>
          <select id="agent" name="agent" defaultValue="" aria-invalid={Boolean(errors.agent)}>
            <option value="">{fresh ? "Choisir un agent…" : "Plus tard"}</option>
            {loaderData.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {errors.agent ? <span className="err">{errors.agent}</span> : <span className="help">Il reçoit les droits par défaut ; tu les ajusteras sur la page du repo.</span>}
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? "Ajout…" : "Ajouter le repo"}
          </button>
        </div>
      </Form>
    </div>
  );
}
