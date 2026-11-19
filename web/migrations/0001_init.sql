-- Essaim : agents, runs (un ticket traité par un agent), journal des runs, machines, réglages globaux.

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seed TEXT NOT NULL,
  hue INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dev',          -- dev | svc
  repo TEXT NOT NULL,                        -- owner/name
  machine TEXT NOT NULL DEFAULT 'mac',       -- mac | nuc
  paused INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,       -- 0 = premier servi sur le quota
  settings TEXT NOT NULL DEFAULT '{}',       -- AgentSettings (JSON)
  status TEXT NOT NULL DEFAULT 'idle',       -- état rapporté par le runner
  status_detail TEXT,                        -- JSON : ticket en cours, tickets prêts, questions en attente
  status_at TEXT,
  telegram_topic INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  issue_number INTEGER,
  issue_title TEXT,
  issue_url TEXT,
  status TEXT NOT NULL,                      -- running | interrupted | needs_human | done | failed
  reason TEXT,
  session_id TEXT,
  pr_url TEXT,
  summary TEXT,
  question TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX runs_agent ON runs (agent_id, updated_at DESC);
CREATE INDEX runs_status ON runs (status);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  run_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- log | started | resumed | milestone | done | needs_human | failed | interrupted | stall | quota_hit | quota_reset | error
  level TEXT,                                -- pour kind = log : tool | run | think | error
  text TEXT NOT NULL
);
CREATE INDEX events_run ON events (run_id, id);
CREATE INDEX events_agent ON events (agent_id, id);

CREATE TABLE machines (
  name TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  version TEXT,
  capacity INTEGER,
  quota TEXT,                                -- JSON : status, fiveHour, sevenDay, resetsAt, blockedUntil
  offline_notified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
