/**
 * Lance Claude Code (`claude -p`) avec l'abonnement Claude du compte connecté sur la machine : jamais avec une clé
 * d'API (facturée au token). L'entrée reste ouverte (`--input-format stream-json`) : un message du propriétaire écrit
 * pendant le travail est glissé dans la session en cours, comme dans Claude Code. `end()` ferme l'entrée : Claude
 * termine son tour puis s'arrête (la session reste reprenable avec --resume).
 */
import { spawn } from "node:child_process";

import { readMessage, splitLines } from "./stream.mjs";

/**
 * @param {object} o
 * @param {string} o.bin        binaire claude
 * @param {string} o.cwd        worktree du ticket
 * @param {string} o.prompt
 * @param {string} o.system     ajouté au prompt système de Claude Code
 * @param {object} [o.schema]   JSON Schema de la réponse finale (tâches ; absent pour une conversation libre)
 * @param {string} [o.resume]   session à reprendre
 * @param {string} [o.model]
 * @param {string} [o.effort]
 * @param {string[]} [o.addDirs]  dossiers accessibles en plus du worktree (mémoire de l'agent)
 * @param {object} [o.agents]     sous-agents (`--agents`)
 * @param {(info: ReturnType<typeof readMessage>) => void} o.onMessage
 * @returns {{ child: import("node:child_process").ChildProcess, send: (text: string) => boolean, end: () => void,
 *   done: Promise<{code: number|null, signal: string|null, result?: object, stderr: string}> }}
 */
export function runClaude({ bin, cwd, prompt, system, schema, resume, model, effort, addDirs = [], agents, onMessage }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--dangerously-skip-permissions"];
  args.push("--append-system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (resume) args.push("--resume", resume);
  for (const dir of addDirs) args.push("--add-dir", dir);
  if (agents) args.push("--agents", JSON.stringify(agents));

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.RUNNER_TOKEN;
  delete env.CF_ACCESS_CLIENT_SECRET;

  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let open = true;
  const send = (text) => {
    if (!open || child.stdin.destroyed) return false;
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    return true;
  };
  const end = () => {
    if (!open) return;
    open = false;
    child.stdin.end();
  };
  send(prompt);
  let buffer = "";
  let stderr = "";
  let result;

  const done = new Promise((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const { lines, rest } = splitLines(buffer + chunk);
      buffer = rest;
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const info = readMessage(msg);
        if (info.result) result = info.result;
        try {
          onMessage(info);
        } catch (error) {
          console.error("onMessage :", error);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (code, signal) => resolve({ code, signal, result, stderr }));
  });
  return { child, send, end, done };
}

/** Arrête Claude proprement (la session reste reprenable), puis de force après 15 s. */
export function stopClaude(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGINT");
  setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  }, 15_000).unref();
}
