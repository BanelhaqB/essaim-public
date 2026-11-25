-- Projets : un projet regroupe plusieurs repos et a ses propres spécialistes (PO, UX/UI, architecte).
-- Un spécialiste est un agent rattaché au projet : il garde une seule mémoire pour tout le projet (agents.memory),
-- et les agents communs lui adressent leurs questions (tâches de source 'expert').

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                                      -- slug du nom
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',                           -- vision, public, règles communes à tous les repos du projet
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE repos ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE CASCADE;
ALTER TABLE agents ADD COLUMN specialty TEXT;                -- po | ux | architect ; NULL : agent commun
CREATE INDEX agents_project ON agents (project_id, specialty);
