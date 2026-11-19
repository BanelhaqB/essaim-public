-- Services des machines (le NUC) : déclarés et relevés par le veilleur (runner/src/services-main.mjs),
-- mis en pause depuis Essaim. `paused` est la volonté d'Essaim ; `status` l'état constaté sur la machine.
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT '',              -- groupe affiché (« Prospection »)
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pausable INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',    -- working | active | paused | disabled | down | unknown
  detail TEXT NOT NULL DEFAULT '{}',         -- JSON : résumé, faits, compteurs, jobs, pause en attente, erreur
  status_at TEXT,
  version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX services_machine ON services (machine, position);
