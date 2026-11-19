import assert from "node:assert/strict";
import { test } from "node:test";

import { hitUsageLimit, readMessage, splitLines } from "../src/stream.mjs";

test("session, outils et jalons d'un message assistant", () => {
  const info = readMessage({
    type: "assistant",
    session_id: "s1",
    message: {
      content: [
        { type: "text", text: "Écrans faits.\nJALON: écrans principaux terminés\nSuite : tests." },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
      ],
    },
  });
  assert.equal(info.sessionId, "s1");
  assert.deepEqual(info.milestones, ["écrans principaux terminés"]);
  assert.deepEqual(info.logs.slice(1), [
    { level: "run", text: "$ npm test" },
    { level: "tool", text: "Edit src/a.ts" },
  ]);
});

test("état du quota (format réel de Claude Code 2.1)", () => {
  const info = readMessage({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1794837000,
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1794837000, status: "rejected" }, seven_day: { utilization: 0.4 } },
    },
  });
  assert.deepEqual(info.rateLimit, { status: "rejected", resetsAt: 1794837000, fiveHour: 1, sevenDay: 0.4 });
  assert.equal(hitUsageLimit({ isError: true, text: "" }, info.rateLimit), true);
});

test("résultat structuré et détection de la limite par le texte", () => {
  const ok = readMessage({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { status: "done", summary: "ok" }, num_turns: 12 });
  assert.equal(ok.result.isError, false);
  assert.deepEqual(ok.result.structured, { status: "done", summary: "ok" });
  assert.equal(hitUsageLimit(ok.result), false);
  const limited = readMessage({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3am" });
  assert.equal(hitUsageLimit(limited.result), true);
  const other = readMessage({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  assert.equal(hitUsageLimit(other.result), false);
});

test("découpe des lignes", () => {
  assert.deepEqual(splitLines('{"a":1}\n{"b"'), { lines: ['{"a":1}'], rest: '{"b"' });
});

test("flux en direct : morceaux de texte, texte complet et activité", () => {
  const delta = readMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bonj" } } });
  assert.equal(delta.delta, "Bonj");
  assert.equal(delta.active, true);
  const full = readMessage({ type: "assistant", message: { content: [{ type: "text", text: "  Bonjour, je regarde.\nJALON: lecture faite " }] } });
  assert.deepEqual(full.texts, ["Bonjour, je regarde.\nJALON: lecture faite"]);
  assert.deepEqual(full.milestones, ["lecture faite"]);
  assert.equal(readMessage({ type: "system", subtype: "task_summary" }).active, undefined);
});

test("consommation de tokens lue dans le résultat", () => {
  const r = readMessage({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, output_tokens: 450 } });
  assert.deepEqual(r.result.usage, { input: 12, cacheRead: 9000, cacheWrite: 300, output: 450 });
});
