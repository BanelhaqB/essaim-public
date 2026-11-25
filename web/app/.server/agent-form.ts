import { listAgents } from "~/.server/db";
import { listRepos, type LinkInput } from "~/.server/repos";
import { applyRoleSettings } from "~/lib/agent-role";
import { readLink } from "~/lib/agent-form";
import type { AgentSettings } from "~/lib/types";

const num = (v: FormDataEntryValue | null) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Lit le formulaire d'un agent (création ou réglages) : réglages, repos choisis et droits sur chacun.
 * `base` : les réglages actuels (conservés pour ce que le formulaire ne porte pas). `selfId` : l'agent modifié.
 */
export async function parseAgentForm(db: D1Database, form: FormData, base: AgentSettings, selfId?: string) {
  const [repos, agents] = await Promise.all([listRepos(db), listAgents(db)]);
  const picked = form.getAll("repo").map(String).filter((id, i, all) => repos.some((r) => r.id === id) && all.indexOf(id) === i);
  const primary = picked.includes(String(form.get("primary"))) ? String(form.get("primary")) : picked[0];
  const ordered = primary ? [primary, ...picked.filter((id) => id !== primary)] : [];
  const links: LinkInput[] = ordered.map((repoId) => {
    const mates = agents.filter((a) => a.id !== selfId && a.repos.some((l) => l.repoId === repoId)).map((a) => a.id);
    return readLink(form, `l:${repoId}:`, repoId, mates);
  });
  const main = links[0];
  const settings: AgentSettings = {
    ...applyRoleSettings(base, form),
    // Copie du repo principal : lue par les anciens écrans et par un runner pas encore à jour.
    merge: main?.merge ?? base.merge,
    deploy: main?.deploy ?? base.deploy,
    store: main?.store ?? base.store,
    yieldOnFocus: form.get("yieldOnFocus") === "on",
    maxMinutes: num(form.get("maxMinutes")),
    stallMinutes: num(form.get("stallMinutes")),
  };
  return { repos, links, settings, machine: form.get("machine") === "nuc" ? ("nuc" as const) : ("mac" as const) };
}

/** Pour chaque repo, les agents qui y sont rattachés (hors `selfId`) : les destinataires possibles d'un relais. */
export async function matesByRepo(db: D1Database, selfId?: string) {
  const out: Record<string, Array<{ id: string; name: string; role?: string }>> = {};
  for (const a of await listAgents(db)) {
    if (a.id === selfId) continue;
    for (const l of a.repos) (out[l.repoId] ??= []).push({ id: a.id, name: a.name, role: a.settings.role });
  }
  return out;
}
