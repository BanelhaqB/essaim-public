import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { deleteAgent } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { createSpecialist, deleteProject, getProject, setRepoProject, updateProject } from "~/.server/projects";
import { listRepos } from "~/.server/repos";
import { SPECIALISTS } from "~/lib/agent-role";
import type { Specialty } from "~/lib/types";

import type { Route } from "./+types/projet";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.project.name ?? "Projet"} · Essaim` }];

const KINDS = Object.keys(SPECIALISTS) as Specialty[];

export async function loader({ params }: Route.LoaderArgs) {
  const { DB } = serverEnv();
  const [project, repos] = await Promise.all([getProject(DB, params.id), listRepos(DB)]);
  if (!project) throw data("Ce projet n'existe pas.", { status: 404 });
  return { project, repos };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const project = await getProject(DB, params.id);
  if (!project) throw data("Ce projet n'existe pas.", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "save") {
    const name = String(form.get("name") ?? "").trim().slice(0, 60) || project.name;
    await updateProject(DB, project.id, name, String(form.get("brief") ?? "").slice(0, 20_000));
    return { saved: "save" as const };
  }
  if (intent === "repos") {
    const chosen = new Set(form.getAll("repo").map(String));
    for (const r of await listRepos(DB)) {
      const inProject = r.projectId === project.id;
      if (chosen.has(r.id) && !inProject) await setRepoProject(DB, r.id, project.id);
      if (!chosen.has(r.id) && inProject) await setRepoProject(DB, r.id, null);
    }
    return { saved: "repos" as const };
  }
  if (intent === "create") {
    const kind = String(form.get("specialty")) as Specialty;
    if (!KINDS.includes(kind)) return data({ error: "Spécialiste inconnu." }, { status: 400 });
    if (!(await createSpecialist(DB, project.id, kind))) return data({ error: "Ajoute d'abord au moins un repo au projet (et un spécialiste n'existe qu'une fois)." }, { status: 400 });
    return { saved: "create" as const };
  }
  if (intent === "delete") {
    await deleteProject(DB, project.id, (id) => deleteAgent(DB, id));
    return redirect("/projets");
  }
  return null;
}

export default function ProjetPage({ loaderData, actionData }: Route.ComponentProps) {
  const { project, repos } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [confirm, setConfirm] = useState(false);
  const saved = (k: string) => actionData && "saved" in actionData && actionData.saved === k && !busy;
  const error = actionData && "error" in actionData ? actionData.error : null;
  return (
    <div className="enter">
      <Link className="back" to="/projets">
        <Icon name="left" />
        Projets
      </Link>
      <div className="view-head">
        <div>
          <h1>{project.name}</h1>
          <p>Le brief, les repos et les spécialistes de ce projet.</p>
        </div>
      </div>

      <Form method="post" className="panel settings" key={`save-${project.name}`}>
        <input type="hidden" name="intent" value="save" />
        <h2>Brief du projet</h2>
        <div className="field">
          <label htmlFor="p-name">Nom</label>
          <input type="text" id="p-name" name="name" defaultValue={project.name} maxLength={60} />
        </div>
        <div className="field">
          <label htmlFor="p-brief">Brief</label>
          <textarea id="p-brief" name="brief" rows={6} defaultValue={project.brief} placeholder="Vision, public, règles communes à tous les repos du projet. Lu par tous les agents du projet." />
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            Enregistrer
          </button>
          {saved("save") && (
            <span className="saved" role="status">
              <Icon name="check" /> Enregistré
            </span>
          )}
        </div>
      </Form>

      <Form method="post" className="panel settings">
        <input type="hidden" name="intent" value="repos" />
        <h2>Repos du projet</h2>
        {repos.length === 0 ? (
          <p className="muted">
            Aucun repo dans Essaim. <Link to="/repos/nouveau">Ajoute-en un</Link>.
          </p>
        ) : (
          <div className="repo-links">
            {repos.map((r) => (
              <label key={r.id} className="tg" htmlFor={`pr-${r.id}`}>
                <span className="tg-text">
                  <b className="mono">{r.repo}</b>
                  <span>{r.projectId && r.projectId !== project.id ? "Dans un autre projet : le cocher le déplace ici" : r.projectId === project.id ? "Dans ce projet" : "Hors projet"}</span>
                </span>
                <span className="switch">
                  <input type="checkbox" id={`pr-${r.id}`} name="repo" value={r.id} defaultChecked={r.projectId === project.id} />
                  <i />
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy || repos.length === 0}>
            Enregistrer les repos
          </button>
          {saved("repos") && (
            <span className="saved" role="status">
              <Icon name="check" /> Enregistrés
            </span>
          )}
        </div>
      </Form>

      <section className="panel">
        <h2>Spécialistes</h2>
        <p className="muted small">Ils sont rattachés à tous les repos du projet et gardent une seule mémoire pour tout le projet. Quand un agent commun a besoin d'une décision produit, d'interface ou d'architecture, sa question leur est envoyée et leur réponse lui revient seule.</p>
        <div className="repo-list">
          {KINDS.map((kind) => {
            const preset = SPECIALISTS[kind];
            const existing = project.specialists.find((s) => s.specialty === kind);
            return (
              <div key={kind} className="repo-pick on">
                <h3 className="sub">{preset.label}</h3>
                <p className="muted small">{preset.blurb}</p>
                {existing ? (
                  <p>
                    <Link to={`/agents/${existing.id}`}>{existing.name}</Link> · <span className="muted small">{existing.model || "modèle par défaut"}</span> ·{" "}
                    <Link className="small" to={`/agents/${existing.id}/reglages`}>
                      Réglages
                    </Link>
                  </p>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="create" />
                    <input type="hidden" name="specialty" value={kind} />
                    <button className="btn ghost" disabled={busy || project.repos.length === 0}>
                      <Icon name="plus" /> Créer le {preset.label}
                    </button>
                  </Form>
                )}
              </div>
            );
          })}
        </div>
        {error && <span className="err">{error}</span>}
        {saved("create") && (
          <span className="saved" role="status">
            <Icon name="check" /> Spécialiste créé
          </span>
        )}
      </section>

      <section className="panel danger-zone">
        <h2>Supprimer le projet</h2>
        <p className="muted small">Les repos et les agents communs restent. Les spécialistes du projet sont supprimés.</p>
        {confirm ? (
          <Form method="post" className="row">
            <button className="btn danger" name="intent" value="delete">
              Supprimer {project.name}
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
              Annuler
            </button>
          </Form>
        ) : (
          <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>
            <Icon name="x" /> Supprimer…
          </button>
        )}
      </section>
    </div>
  );
}
