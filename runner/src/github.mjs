/**
 * Tickets et code : `gh` et `git` de la machine, avec le compte GitHub déjà connecté.
 *
 * Étiquettes posées sur les issues :
 *   agent:ready        tâche prête, dans la file de l'agent (posée par le runner : Essaim fait foi)
 *   agent:wip          en cours
 *   agent:needs-human  l'agent attend une réponse ; répondre en commentaire (ou remettre agent:ready) relance
 *   agent:done         traité
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LABELS = {
  ready: { name: "agent:ready", color: "5FE0B0", description: "Prêt pour un agent d’Essaim" },
  wip: { name: "agent:wip", color: "72B8FF", description: "Un agent travaille dessus" },
  human: { name: "agent:needs-human", color: "F5B04F", description: "L'agent attend ta réponse en commentaire" },
  done: { name: "agent:done", color: "A99BFF", description: "Traité par un agent" },
};
/** Marque invisible des commentaires écrits par le runner : une réponse est un commentaire sans elle. */
export const MARKER = "<!-- essaim -->";
/** Marqueur des commentaires écrits avant le renommage en Essaim : toujours reconnus comme ceux du runner. */
const OLD_MARKERS = ["<!-- equipe-de-nuit -->"];
const fromRunner = (body) => [MARKER, ...OLD_MARKERS].some((m) => String(body).includes(m));

async function gh(args, input) {
  if (input == null) {
    const { stdout } = await run("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(input);
  });
}
/**
 * Plusieurs agents peuvent partager un repo, donc son clone : clone, fetch et ajout ou retrait de worktree
 * (qui prennent des verrous git) passent un par un, sans bloquer les autres repos.
 */
const repoLocks = new Map();
export function withRepoLock(repo, fn) {
  const run = (repoLocks.get(repo) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  repoLocks.set(repo, tail);
  tail.then(() => {
    if (repoLocks.get(repo) === tail) repoLocks.delete(repo);
  });
  return run;
}

const git = async (cwd, args) => (await run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

/** gh a répondu que le repo n'existe pas (ou que le compte connecté n'y a pas accès). */
export const isMissingRepo = (error) => /could not resolve to a repository|HTTP 404/i.test(String(error?.stderr ?? error?.message ?? error));

const labelled = new Set();
export async function ensureLabels(repo) {
  if (labelled.has(repo)) return;
  try {
    for (const l of Object.values(LABELS)) {
      await gh(["label", "create", l.name, "-R", repo, "--color", l.color, "--description", l.description, "--force"]);
    }
  } catch (error) {
    // Le message brut de gh (« HTTP 404 … /labels ») ne dit pas que c'est le repo lui-même qui manque.
    if (isMissingRepo(error)) throw new Error(`Le repo ${repo} n'existe pas sur GitHub (ou le compte gh n'y a pas accès). Crée-le, ou recrée l'agent en cochant « Nouveau projet ».`);
    throw error;
  }
  labelled.add(repo);
}

/** Description GitHub d'un nouveau repo : la première ligne du brief, courte. */
export const repoDescription = (brief) =>
  String(brief ?? "")
    .trim()
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .slice(0, 200);

const existing = new Set();
/**
 * Nouveau projet : crée le repo (avec un README, pour avoir une branche par défaut à cloner) s'il n'existe pas.
 * Renvoie true seulement s'il vient d'être créé.
 */
export async function ensureRepo(repo, { visibility = "private", description = "" } = {}) {
  if (existing.has(repo)) return false;
  const found = await gh(["repo", "view", repo, "--json", "name"]).then(
    () => true,
    (error) => {
      if (/could not resolve|not found|404/i.test(String(error.stderr ?? error.message))) return false;
      throw error;
    },
  );
  if (!found) {
    const args = ["repo", "create", repo, visibility === "public" ? "--public" : "--private", "--add-readme"];
    if (description) args.push("--description", description);
    await gh(args);
  }
  existing.add(repo);
  return !found;
}

const FOOTER = "\n\n---\n<sub>Tâche gérée dans Essaim : c'est là qu'on la modifie et qu'on l'ordonne.</sub>";
const mirrorBody = (body) => `${String(body ?? "").trim() || "_(sans description)_"}${FOOTER}`;

/** Crée l'issue miroir d'une tâche prête. Renvoie son numéro et son URL. */
export async function createIssue(repo, title, body) {
  await ensureLabels(repo);
  const out = await gh(["issue", "create", "-R", repo, "--title", title, "--label", LABELS.ready.name, "--body-file", "-"], mirrorBody(body));
  const url = out.trim().split("\n").pop();
  const number = Number(url.match(/\/issues\/(\d+)/)?.[1]);
  if (!number) throw new Error(`Issue créée mais URL illisible : ${url}`);
  return { number, url };
}

/** Recopie une tâche modifiée dans Essaim sur son issue : texte, étiquette, fermeture si abandonnée, réouverture si reprise. */
export async function updateIssue(repo, number, { title, body, status }) {
  await ensureLabels(repo);
  const args = ["issue", "edit", String(number), "-R", repo, "--title", title, "--body-file", "-"];
  const others = Object.values(LABELS).map((l) => l.name);
  if (status === "prete") args.push("--add-label", LABELS.ready.name, "--remove-label", others.filter((n) => n !== LABELS.ready.name).join(","));
  if (status === "brouillon" || status === "abandonnee") args.push("--remove-label", others.join(","));
  await gh(args, mirrorBody(body));
  // Tâche reprise après un abandon (ou étape qui rouvre sa tâche mère) : l'issue fermée est rouverte. Sans effet si
  // elle est déjà ouverte.
  if (status === "prete" || status === "en_cours") await gh(["issue", "reopen", String(number), "-R", repo]).catch(() => "");
  if (status === "abandonnee") await gh(["issue", "close", String(number), "-R", repo, "--reason", "not planned", "--comment", `Tâche abandonnée dans Essaim.\n\n${MARKER}`]).catch(() => "");
}

/** Change l'étiquette d'agent d'une issue (retire les autres). */
export async function setStage(repo, number, stage) {
  const target = LABELS[stage].name;
  const others = Object.values(LABELS).map((l) => l.name).filter((n) => n !== target);
  await gh(["issue", "edit", String(number), "-R", repo, "--add-label", target, "--remove-label", others.join(",")]);
}

export async function comment(repo, number, body) {
  await gh(["issue", "comment", String(number), "-R", repo, "--body-file", "-"], `${body.trim()}\n\n${MARKER}`);
}

/**
 * Réponse à une question : les commentaires postés après `sinceIso` sans la marque du runner, joints.
 * Remettre l'étiquette agent:ready sans commenter relance aussi (réponse vide). null : pas encore de réponse.
 */
export async function replySince(repo, number, sinceIso) {
  const out = JSON.parse(await gh(["issue", "view", String(number), "-R", repo, "--json", "comments,labels,state"]));
  const since = Date.parse(sinceIso);
  const replies = (out.comments ?? []).filter((c) => Date.parse(c.createdAt) > since && !fromRunner(c.body));
  if (replies.length) return replies.map((c) => c.body.trim()).join("\n\n---\n\n");
  if ((out.labels ?? []).some((l) => l.name === LABELS.ready.name)) return "";
  return null;
}

const slug = (text) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ticket";

/**
 * Un worktree pour le ticket, dans le clone de travail du repo (créé au premier passage).
 * Si la branche existe déjà sur GitHub (reprise sur une autre machine, ou après nettoyage), on repart d'elle.
 */
export const prepareWorktree = (home, repo, issue) => withRepoLock(repo, () => prepareWorktreeUnlocked(home, repo, issue));

async function prepareWorktreeUnlocked(home, repo, issue) {
  const key = repo.replace("/", "__");
  const base = path.join(home, "repos", key);
  if (!existsSync(base)) {
    mkdirSync(path.dirname(base), { recursive: true });
    await gh(["repo", "clone", repo, base, "--", "--quiet"]);
  }
  await git(base, ["fetch", "origin", "--prune", "--quiet"]);
  await git(base, ["remote", "set-head", "origin", "--auto"]).catch(() => "");
  const defaultBranch = (await git(base, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "");
  const branch = `agent/${issue.number}-${slug(issue.title)}`;
  const worktree = path.join(home, "worktrees", key, String(issue.number));
  if (!existsSync(worktree)) {
    mkdirSync(path.dirname(worktree), { recursive: true });
    await git(base, ["worktree", "prune"]);
    const remote = await git(base, ["ls-remote", "--heads", "origin", branch]);
    if (remote) await git(base, ["worktree", "add", "-B", branch, worktree, `origin/${branch}`]);
    else await git(base, ["worktree", "add", "-B", branch, worktree, `origin/${defaultBranch}`]);
    return { worktree, branch, defaultBranch, existing: Boolean(remote) };
  }
  return { worktree, branch, defaultBranch, existing: true };
}

/**
 * Copie du repo où tournent les actions en un clic : un worktree détaché, remis sur la dernière version de la branche
 * par défaut avant chaque lancement. Les fichiers ignorés (node_modules, builds) restent d'une fois sur l'autre.
 */
export const prepareActionDir = (home, repo) => withRepoLock(repo, () => prepareActionDirUnlocked(home, repo));

async function prepareActionDirUnlocked(home, repo) {
  const key = repo.replace("/", "__");
  const base = path.join(home, "repos", key);
  if (!existsSync(base)) {
    mkdirSync(path.dirname(base), { recursive: true });
    await gh(["repo", "clone", repo, base, "--", "--quiet"]);
  }
  await git(base, ["fetch", "origin", "--prune", "--quiet"]);
  await git(base, ["remote", "set-head", "origin", "--auto"]).catch(() => "");
  const defaultBranch = (await git(base, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "");
  const dir = path.join(home, "worktrees", key, "actions");
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(base, ["worktree", "prune"]);
    await git(base, ["worktree", "add", "--detach", dir, `origin/${defaultBranch}`]);
  } else {
    await git(dir, ["checkout", "--detach", "--force", `origin/${defaultBranch}`]);
    await git(dir, ["reset", "--hard", "--quiet"]);
  }
  const commit = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return { dir, defaultBranch, commit };
}

export const removeWorktree = (home, repo, worktree) =>
  withRepoLock(repo, async () => {
    const base = path.join(home, "repos", repo.replace("/", "__"));
    await git(base, ["worktree", "remove", "--force", worktree]).catch(() => "");
  });

/** Rattache une issue à sa tâche parente (sous-issue GitHub). Sans effet si c'est déjà fait. */
export async function linkSubIssue(repo, parentNumber, childNumber) {
  const id = (await gh(["api", `repos/${repo}/issues/${childNumber}`, "--jq", ".id"])).trim();
  await gh(["api", "-X", "POST", `repos/${repo}/issues/${parentNumber}/sub_issues`, "-F", `sub_issue_id=${id}`]).catch((error) => {
    if (!/already|exists|422/i.test(String(error.stderr ?? error.message))) throw error;
  });
}
