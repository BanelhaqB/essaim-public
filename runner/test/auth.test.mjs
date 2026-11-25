import assert from "node:assert/strict";
import { test } from "node:test";

import { authAlert, hitAuthError } from "../src/auth.mjs";

const NOW = Date.parse("2026-11-25T12:00:00Z");

test("une session qui échoue sur la connexion est reconnue, pas une erreur ordinaire", () => {
  assert.equal(hitAuthError({ isError: true, text: "Invalid API key · Please run /login" }), true);
  assert.equal(hitAuthError({ isError: true, text: "OAuth token has expired" }), true);
  assert.equal(hitAuthError(undefined, "Error: Not logged in"), true);
  assert.equal(hitAuthError({ isError: true, text: "Tests failed: 401 cases" }), false);
  assert.equal(hitAuthError({ isError: false, structured: { status: "done" }, text: "ok" }, "token expired in a log line"), false);
});

test("alerte avant l'expiration, jamais trop tôt", () => {
  const status = (loginExpiresAt, loggedIn = true) => ({ loggedIn, loginExpiresAt });
  assert.equal(authAlert(status("2026-11-29T11:55:00Z"), NOW), null);
  assert.equal(authAlert(status("2026-11-27T11:55:00Z"), NOW)?.kind, "auth_expiring");
  assert.equal(authAlert(status("2026-11-24T11:55:00Z"), NOW)?.kind, "auth_expired");
  assert.equal(authAlert(status(undefined, false), NOW)?.kind, "auth_expired");
  assert.equal(authAlert(null, NOW), null);
  assert.match(authAlert(status("2026-11-27T11:55:00Z"), NOW).text, /claude auth login/);
});
