import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pullUpdate, readyToRestart, RESTART_WAIT_MS } from "../src/update.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" }).toString().trim();
const commit = (repo, file, text) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", file);
  git(repo, "push", "-q");
};

/** Un repo distant, le checkout du runner, et un autre clone qui pousse les nouveautés. */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "essaim-update-"));
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const dev = path.join(root, "dev");
  execFileSync("git", ["clone", "-q", origin, dev], { stdio: "pipe" });
  git(dev, "checkout", "-qb", "main");
  commit(dev, "runner/src/runner.mjs", "v1");
  git(dev, "push", "-q", "-u", "origin", "main");
  const mac = path.join(root, "mac");
  execFileSync("git", ["clone", "-q", origin, mac], { stdio: "pipe" });
  return { root, dev, mac, runnerDir: path.join(mac, "runner") };
}

test("avance le checkout et signale un changement du runner", async () => {
  const { root, dev, mac, runnerDir } = setup();
  try {
    assert.deepEqual(await pullUpdate(runnerDir), { pulled: 0, changed: false });
    commit(dev, "web/app.ts", "web");
    assert.deepEqual(await pullUpdate(runnerDir), { pulled: 1, changed: false });
    commit(dev, "runner/src/runner.mjs", "v2");
    assert.deepEqual(await pullUpdate(runnerDir), { pulled: 1, changed: true });
    assert.equal(git(mac, "show", "HEAD:runner/src/runner.mjs"), "v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ne touche pas un checkout modifié, en avance ou sur une autre branche", async () => {
  const { root, dev, mac, runnerDir } = setup();
  try {
    commit(dev, "runner/src/runner.mjs", "v2");
    writeFileSync(path.join(runnerDir, "src/runner.mjs"), "local");
    assert.equal((await pullUpdate(runnerDir)).skipped, "modifications locales");
    git(mac, "checkout", "-q", "--", ".");

    git(mac, "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "local");
    assert.equal((await pullUpdate(runnerDir)).skipped, "commits locaux pas encore poussés");
    git(mac, "reset", "-q", "--hard", "origin/main~1");

    git(mac, "checkout", "-qb", "essai");
    assert.match((await pullUpdate(runnerDir)).skipped, /pas sur origin\/main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redémarrage : une discussion au repos ne bloque pas, une réponse en cours ou une action si", () => {
  const base = { since: 0, now: 60_000, runs: 0, busyChats: 0, actions: 0 };
  assert.equal(readyToRestart(base), true);
  assert.equal(readyToRestart({ ...base, busyChats: 1 }), false);
  assert.equal(readyToRestart({ ...base, actions: 1 }), false);
  assert.equal(readyToRestart({ ...base, actions: 1, now: RESTART_WAIT_MS * 10 }), false);
});

test("redémarrage : les tickets en cours sont attendus 30 min au plus", () => {
  const base = { since: 1_000, runs: 2, busyChats: 0, actions: 0 };
  assert.equal(readyToRestart({ ...base, now: 1_000 + RESTART_WAIT_MS - 1 }), false);
  assert.equal(readyToRestart({ ...base, now: 1_000 + RESTART_WAIT_MS }), true);
  assert.equal(readyToRestart({ ...base, busyChats: 1, now: 1_000 + RESTART_WAIT_MS * 2 }), false);
});
