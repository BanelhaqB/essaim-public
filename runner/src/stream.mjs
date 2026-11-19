/**
 * Lecture du flux `--output-format stream-json` de `claude -p` : une ligne JSON par message.
 * Le runner n'en garde que ce qu'il suit : l'identifiant de session (pour reprendre plus tard),
 * des lignes de journal lisibles, les jalons annoncés par l'agent, l'état du quota et le résultat final.
 */

/** Ligne que l'agent écrit quand il franchit un jalon : « JALON: écrans principaux terminés ». */
const MILESTONE = /^\s*JALON\s*:\s*(.+)$/gim;
const MAX_TEXT = 400;

const short = (text, max = MAX_TEXT) => {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Une ligne de journal pour un appel d'outil de Claude Code. */
export function describeTool(name, input = {}) {
  const file = input.file_path || input.path || input.notebook_path;
  switch (name) {
    case "Bash":
      return { level: "run", text: `$ ${short(input.command, 300)}` };
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { level: "tool", text: `${name} ${file ?? ""}`.trim() };
    case "Grep":
      return { level: "tool", text: `Grep "${short(input.pattern, 120)}"${input.path ? ` dans ${input.path}` : ""}` };
    case "Glob":
      return { level: "tool", text: `Glob ${short(input.pattern, 120)}` };
    case "Task":
    case "Agent":
      return { level: "tool", text: `Sous-agent : ${short(input.description || input.prompt, 160)}` };
    case "WebFetch":
    case "WebSearch":
      return { level: "tool", text: `${name} ${short(input.url || input.query, 200)}` };
    case "TodoWrite":
      return { level: "tool", text: "Mise à jour de sa liste de tâches" };
    default:
      return { level: "tool", text: short(`${name} ${JSON.stringify(input)}`, 200) };
  }
}

/**
 * Ce qu'un message du flux apprend au runner.
 * `texts` : les textes complets de l'agent ; `delta` : un morceau de texte en cours d'écriture (direct seulement) ;
 * `active` : l'agent travaille (un nouveau tour a commencé).
 * @returns {{ sessionId?: string, logs: {level: string, text: string}[], texts: string[], delta?: string, active?: boolean, milestones: string[],
 *   rateLimit?: {status: string, resetsAt?: number, fiveHour?: number, sevenDay?: number},
 *   result?: {isError: boolean, text: string, structured?: unknown, turns?: number, costUsd?: number, sessionId?: string} }}
 */
export function readMessage(msg) {
  const out = { logs: [], texts: [], milestones: [] };
  if (!msg || typeof msg !== "object") return out;
  if (typeof msg.session_id === "string") out.sessionId = msg.session_id;

  if (msg.type === "stream_event") {
    out.active = true;
    const ev = msg.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) out.delta = ev.delta.text;
  } else if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    out.active = true;
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        for (const m of block.text.matchAll(MILESTONE)) out.milestones.push(short(m[1], 200));
        out.logs.push({ level: "think", text: short(block.text) });
        out.texts.push(block.text.trim());
      } else if (block.type === "tool_use") {
        out.logs.push(describeTool(block.name, block.input));
      }
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join(" ") : block.content;
        out.logs.push({ level: "error", text: short(text, 240) });
      }
    }
  } else if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
    const info = msg.rate_limit_info;
    const windows = info.unifiedWindows ?? {};
    out.rateLimit = {
      status: String(info.status ?? "allowed"),
      resetsAt: Number(info.resetsAt) || undefined,
      fiveHour: windows.five_hour?.utilization,
      sevenDay: windows.seven_day?.utilization,
    };
  } else if (msg.type === "result") {
    out.result = {
      isError: Boolean(msg.is_error) || (msg.subtype && msg.subtype !== "success"),
      text: String(msg.result ?? msg.subtype ?? ""),
      structured: msg.structured_output,
      turns: msg.num_turns,
      costUsd: msg.total_cost_usd,
      sessionId: msg.session_id,
      usage: msg.usage
        ? {
            input: msg.usage.input_tokens ?? 0,
            cacheRead: msg.usage.cache_read_input_tokens ?? 0,
            cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
            output: msg.usage.output_tokens ?? 0,
          }
        : undefined,
    };
  }
  return out;
}

/** Messages d'erreur de Claude Code quand la limite de l'abonnement est atteinte. */
const LIMIT_TEXT = /usage limit|hit your limit|limit reached|rate.?limit|resets? (at|in)|429/i;

/** Le run s'est-il arrêté sur la limite d'usage de l'abonnement ? */
export function hitUsageLimit(result, lastRateLimit) {
  if (lastRateLimit?.status === "rejected") return true;
  return Boolean(result?.isError && LIMIT_TEXT.test(result.text));
}

/** Coupe un flux de texte en lignes complètes ; renvoie le reste à garder pour le morceau suivant. */
export function splitLines(buffer) {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines: lines.filter((l) => l.trim()), rest };
}
