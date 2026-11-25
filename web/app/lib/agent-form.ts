import type { LinkInput } from "~/.server/repos";

/** Les droits d'un agent sur un repo, lus dans un formulaire sous le préfixe `prefix` (voir LinkFields). */
export function readLink(form: FormData, prefix: string, repoId: string, validMates: string[]): LinkInput {
  const to = String(form.get(`${prefix}handoffTo`) ?? "");
  const rounds = Math.round(Number(form.get(`${prefix}maxRounds`)));
  return {
    repoId,
    access: form.get(`${prefix}access`) === "read" ? "read" : "write",
    merge: form.get(`${prefix}merge`) === "on",
    deploy: form.get(`${prefix}deploy`) === "on",
    store: form.get(`${prefix}store`) === "on",
    handoffTo: validMates.includes(to) ? to : null,
    maxRounds: Number.isFinite(rounds) && rounds >= 1 ? Math.min(rounds, 10) : null,
  };
}
