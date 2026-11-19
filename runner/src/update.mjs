/**
 * Mise à jour du runner : son checkout suit la branche par défaut du repo d'Essaim. Sans ça, un correctif mergé
 * (ex. la création de repo des nouveaux projets) n'arrive sur la machine qu'après un `git pull` fait à la main.
 *
 * On n'avance que par fast-forward, et seulement si le checkout est propre, sur la branche par défaut et sans
 * commit local : jamais de fusion ni d'écrasement du travail du propriétaire.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Récupère la branche par défaut et avance le checkout qui contient `dir`.
 * @returns {Promise<{pulled: number, changed: boolean, skipped?: string}>}
 *   pulled : commits récupérés ; changed : des fichiers sous `dir` ont changé (il faut redémarrer) ;
 *   skipped : pourquoi le checkout n'a pas été touché.
 */
export async function pullUpdate(dir) {
  const git = async (...args) => (await run("git", ["-C", dir, ...args])).stdout.trim();
  const upstream = await git("rev-parse", "--abbrev-ref", "@{u}").catch(() => "");
  const remoteHead = (await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "")) || "origin/main";
  if (!upstream || upstream !== remoteHead) return { pulled: 0, changed: false, skipped: `pas sur ${remoteHead}` };
  if (await git("status", "--porcelain", "--untracked-files=no")) return { pulled: 0, changed: false, skipped: "modifications locales" };
  await git("fetch", "--quiet", "origin");
  const [ahead, behind] = (await git("rev-list", "--left-right", "--count", "HEAD...@{u}")).split(/\s+/).map(Number);
  if (!behind) return { pulled: 0, changed: false };
  if (ahead) return { pulled: 0, changed: false, skipped: "commits locaux pas encore poussés" };
  const before = await git("rev-parse", "HEAD");
  await git("merge", "--ff-only", "--quiet", "@{u}");
  // Pathspec « . » relatif à `dir` : seuls les fichiers du runner comptent pour redémarrer.
  const changed = Boolean(await git("diff", "--name-only", before, "HEAD", "--", "."));
  return { pulled: behind, changed };
}

/** Au-delà, les tickets en cours sont coupés pour redémarrer (ils reprennent juste après, même session). */
export const RESTART_WAIT_MS = 30 * 60_000;

/**
 * Peut-on redémarrer sur le nouveau code ? Une action en cours ou une discussion en train de répondre : non.
 * Une discussion ouverte mais au repos ne bloque pas (elle se rouvre avec --resume au message suivant) : avant,
 * le propriétaire qui discutait sans arrêt bloquait le runner, sans nouveau ticket ni reprise, pendant des heures.
 * Des tickets en cours : on les attend au plus RESTART_WAIT_MS.
 */
export function readyToRestart({ since, now, runs, busyChats, actions, maxWaitMs = RESTART_WAIT_MS }) {
  if (actions || busyChats) return false;
  return !runs || now - since >= maxWaitMs;
}
