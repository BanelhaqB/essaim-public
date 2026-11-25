import { Form, Link, redirect, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { serverEnv } from "~/.server/env";
import { createProject, listProjects } from "~/.server/projects";
import { SPECIALISTS } from "~/lib/agent-role";

import type { Route } from "./+types/projets";

export const meta: Route.MetaFunction = () => [{ title: "Projets · Essaim" }];

export async function loader() {
  return { projects: await listProjects(serverEnv().DB) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  if (!name) return { error: "Donne un nom au projet." };
  const id = await createProject(serverEnv().DB, name, String(form.get("brief") ?? "").slice(0, 20_000));
  return redirect(`/projets/${id}`);
}

export default function Projets({ loaderData, actionData }: Route.ComponentProps) {
  const { projects } = loaderData;
  const busy = useNavigation().state === "submitting";
  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Projets</h1>
          <p>Un projet regroupe plusieurs repos. Ses spécialistes (PO, UX/UI, architecte) en connaissent tout le contexte : les agents communs les consultent quand une décision les dépasse.</p>
        </div>
      </div>
      {projects.length > 0 && (
        <div className="repo-list">
          {projects.map((p) => (
            <Link key={p.id} to={`/projets/${p.id}`} className="panel repo-card">
              <h2>{p.name}</h2>
              <span className="muted small">{p.repos.length ? p.repos.map((r) => r.repo).join(" · ") : "Aucun repo"}</span>
              <span className="muted small">{p.specialists.length ? p.specialists.map((s) => SPECIALISTS[s.specialty].label).join(" · ") : "Aucun spécialiste"}</span>
            </Link>
          ))}
        </div>
      )}
      <Form method="post" className="panel settings">
        <h2>Nouveau projet</h2>
        <div className="field">
          <label htmlFor="p-name">Nom</label>
          <input type="text" id="p-name" name="name" autoComplete="off" maxLength={60} placeholder="Ex. : Poker Tracker" />
          {actionData && "error" in actionData && <span className="err">{actionData.error}</span>}
        </div>
        <div className="field">
          <label htmlFor="p-brief">Brief du projet (optionnel)</label>
          <textarea id="p-brief" name="brief" rows={4} placeholder="Vision, public, règles communes à tous les repos du projet." />
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            <Icon name="plus" /> Créer le projet
          </button>
        </div>
      </Form>
    </div>
  );
}
