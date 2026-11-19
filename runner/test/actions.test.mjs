import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { actionOutcome, actionsText, changedActions, cleanOutput, commandEnv, createOutput, normalizeActions, runCommand } from "../src/actions.mjs";
import { prepareActionDir } from "../src/github.mjs";
import { writeMemory } from "../src/memory.mjs";

test("ACTIONS.json : actions valides seulement, bornées, sans doublon de nom", () => {
  const list = normalizeActions([
    { id: "a1", name: "  Générer   l'APK ", command: " ./gradlew assembleRelease ", timeoutMinutes: 900, extra: 1 },
    { name: "générer l'apk", command: "echo doublon" },
    { name: "Publier", prompt: "Publie la dernière version", confirm: true, command: "" },
    { name: "Sans rien" },
    { command: "echo sans nom" },
    "n'importe quoi",
  ]);
  assert.deepEqual(list, [
    { id: "a1", name: "Générer l'APK", description: "", command: "./gradlew assembleRelease", timeoutMinutes: 240 },
    { name: "Publier", description: "", prompt: "Publie la dernière version", confirm: true },
  ]);
  assert.deepEqual(normalizeActions({ actions: [{ name: "x", command: "y" }] }), [{ name: "x", description: "", command: "y" }]);
  assert.deepEqual(normalizeActions(null), []);
});

test("ACTIONS.json : écrit avant la session, renvoyé seulement si l'agent l'a changé", () => {
  const home = mkdtempSync(path.join(tmpdir(), "essaim-actions-"));
  const agent = { id: "ag", brief: "", memory: "", actions: [{ id: "a1", name: "Installer", description: "", command: "make install" }] };
  const dir = writeMemory(home, agent);
  const base = actionsText(agent.actions);
  assert.equal(readFileSync(path.join(dir, "ACTIONS.json"), "utf8"), base);
  assert.equal(changedActions(dir, base), null);

  // Même contenu, autre mise en forme : rien à renvoyer.
  writeFileSync(path.join(dir, "ACTIONS.json"), JSON.stringify(agent.actions));
  assert.equal(changedActions(dir, base), null);

  const next = [...agent.actions, { name: "Générer l'APK", command: "./gradlew assembleRelease" }];
  writeFileSync(path.join(dir, "ACTIONS.json"), JSON.stringify(next, null, 4));
  const changed = changedActions(dir, base);
  assert.equal(changed.actions.length, 2);
  assert.equal(changed.content, actionsText(next));

  writeFileSync(path.join(dir, "ACTIONS.json"), "[{ oups");
  assert.match(changedActions(dir, base).error, /pas du JSON valide/);

  // Une autre session de l'agent l'a modifié : on n'écrase pas.
  writeFileSync(path.join(dir, "ACTIONS.json"), "[]\n");
  writeMemory(home, agent, { keepActions: true });
  assert.equal(readFileSync(path.join(dir, "ACTIONS.json"), "utf8"), "[]\n");
});

test("sortie : sans couleurs, barres de progression réduites à leur dernière version", () => {
  assert.equal(cleanOutput("\x1b[32mBUILD\x1b[0m OK\r\n"), "BUILD OK\n");
  assert.equal(cleanOutput("10%\r50%\r100%\nfin"), "100%\nfin");
  assert.equal(cleanOutput("ligne\r"), "ligne");
});

test("sortie regroupée : morceaux gardés jusqu'au plafond, puis en direct seulement ; la fin reste disponible", () => {
  const chunks = [];
  const out = createOutput({ flushMs: 60_000, maxStored: 10, tailSize: 8, onChunk: (text, store) => chunks.push([text, store]) });
  out.write("abcdef");
  out.write("ghijkl\n");
  out.flush();
  out.write("suite\n");
  out.flush();
  out.flush();
  assert.deepEqual(chunks, [
    ["abcdefghijkl\n", true],
    ["suite\n", false],
  ]);
  assert.equal(out.truncated, true);
  assert.equal(out.tail(), "l\nsuite\n");
});

test("commande : sortie, code de retour, environnement sans secrets", async () => {
  let output = "";
  const env = commandEnv({ PATH: "/usr/bin:/bin", RUNNER_TOKEN: "secret", HOME: process.env.HOME }, { ESSAIM_ACTION: "Test" });
  assert.equal(env.RUNNER_TOKEN, undefined);
  const cmd = runCommand({ command: 'echo "action $ESSAIM_ACTION ${RUNNER_TOKEN:-sans jeton}"; echo erreur >&2; exit 3', cwd: tmpdir(), env, shell: "/bin/sh", onData: (d) => (output += d) });
  const exit = await cmd.done;
  assert.equal(exit.code, 3);
  assert.match(output, /action Test sans jeton/);
  assert.match(output, /erreur/);
  assert.deepEqual(actionOutcome("Test", exit, 1500, 60), { status: "echouee", text: "« Test » en échec (code 3) après 2 s." });
  assert.equal(actionOutcome("Test", { code: 0 }, 65_000, 60).text, "« Test » terminée en 1 min 05 s.");
});

test("commande : arrêt et durée max coupent tout le groupe de processus", async () => {
  const stopped = runCommand({ command: "sleep 30 & sleep 30; echo jamais", cwd: tmpdir(), env: process.env, shell: "/bin/sh", onData: () => {} });
  setTimeout(stopped.stop, 100);
  const a = await stopped.done;
  assert.equal(a.reason, "stop");
  assert.equal(actionOutcome("X", a, 100, 60).status, "arretee");

  const slow = runCommand({ command: "sleep 30", cwd: tmpdir(), env: process.env, shell: "/bin/sh", timeoutMs: 100, onData: () => {} });
  const b = await slow.done;
  assert.equal(b.reason, "timeout");
  assert.deepEqual(actionOutcome("X", b, 100, 1), { status: "echouee", text: "« X » coupée : durée max dépassée (1 min)." });
});

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" }).toString().trim();

test("copie du repo des actions : remise sur la dernière version, fichiers ignorés gardés", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "essaim-actiondir-"));
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dev = path.join(root, "dev");
  execFileSync("git", ["clone", "-q", remote, dev], { stdio: "pipe" });
  writeFileSync(path.join(dev, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(dev, "app.txt"), "v1\n");
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "v1");
  git(dev, "push", "-q", "origin", "main");
  const home = path.join(root, "home");
  mkdirSync(path.join(home, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", remote, path.join(home, "repos", "o__r")], { stdio: "pipe" });

  const first = await prepareActionDir(home, "o/r");
  assert.equal(first.defaultBranch, "main");
  assert.equal(readFileSync(path.join(first.dir, "app.txt"), "utf8"), "v1\n");
  writeFileSync(path.join(first.dir, "app.txt"), "modifié par un build\n");
  mkdirSync(path.join(first.dir, "node_modules"));
  writeFileSync(path.join(first.dir, "node_modules", "x"), "gardé");

  writeFileSync(path.join(dev, "app.txt"), "v2\n");
  git(dev, "commit", "-qam", "v2");
  git(dev, "push", "-q", "origin", "main");

  const second = await prepareActionDir(home, "o/r");
  assert.equal(second.dir, first.dir);
  assert.notEqual(second.commit, first.commit);
  assert.equal(readFileSync(path.join(second.dir, "app.txt"), "utf8"), "v2\n");
  assert.ok(existsSync(path.join(second.dir, "node_modules", "x")));
});
