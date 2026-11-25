import { Link } from "react-router";

import { Avatar, Icon } from "~/components/ui";
import { listAgents } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { listRepos } from "~/.server/repos";

import type { Route } from "./+types/repos";

export const meta: Route.MetaFunction = () => [{ title: "Repos · Essaim" }];

export async function loader() {
  const { DB } = serverEnv();
  const [repos, agents] = await Promise.all([listRepos(DB), listAgents(DB)]);
  return {
    repos: repos.map((r) => ({
      ...r,
      team: agents.flatMap((a) => {
        const l = a.repos.find((x) => x.repoId === r.id);
        return l ? [{ id: a.id, name: a.name, seed: a.seed, hue: a.hue, role: a.settings.role ?? "", access: l.access }] : [];
      }),
    })),
  };
}

export default function Repos({ loaderData }: Route.ComponentProps) {
  const { repos } = loaderData;
  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Repos</h1>
          <p>Les projets GitHub sur lesquels travaillent tes agents. Chaque repo a son brief et son équipe, avec les droits de chaque agent.</p>
        </div>
        <Link className="btn primary" to="/repos/nouveau">
          <Icon name="plus" /> Ajouter un repo
        </Link>
      </div>
      {repos.length === 0 ? (
        <p className="muted">Aucun repo pour l'instant. Ajoute le premier, puis rattache-lui des agents.</p>
      ) : (
        <div className="repo-list">
          {repos.map((r) => (
            <Link key={r.id} to={`/repos/${r.id}`} className="panel repo-card">
              <h2 className="mono">{r.repo}</h2>
              {r.createMode && <span className="muted small">À créer par l'agent ({r.createMode === "public" ? "public" : "privé"})</span>}
              {r.team.length === 0 ? (
                <span className="muted small">Aucun agent rattaché.</span>
              ) : (
                <ul className="repo-team">
                  {r.team.map((m) => (
                    <li key={m.id}>
                      <Avatar seed={m.seed} hue={m.hue} size={28} status="idle" />
                      <span>
                        {m.name}
                        <small>{[m.role, m.access === "read" ? "lecture seule" : ""].filter(Boolean).join(" · ")}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
