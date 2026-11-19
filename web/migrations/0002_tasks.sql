-- Tâches rédigées dans Essaim : brouillon → prete (dans la file de l'agent, ordonnée) → en_cours → question → terminee | abandonnee.
-- Essaim fait foi ; l'issue GitHub en est le miroir (créée par le runner quand la tâche devient prête).
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL, -- NULL : boîte de réception (pas encore attribuée)
  parent_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,  -- sous-tâche (découpage par l'agent)
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'brouillon',
  position REAL NOT NULL DEFAULT 0,                         -- ordre dans la file de l'agent
  source TEXT,                                              -- 'project4', 'github'… pour les tâches importées
  source_ref TEXT,                                          -- identifiant d'origine (élément du Project 4) : pas d'import en double
  source_label TEXT,                                        -- étiquette d'origine (champ Projet du Project 4)
  issue_number INTEGER,
  issue_url TEXT,
  gh_dirty INTEGER NOT NULL DEFAULT 0,                      -- l'issue doit être mise à jour par le runner
  run_id TEXT,
  pr_url TEXT,
  summary TEXT,
  question TEXT,
  reply TEXT,                                               -- réponse écrite dans Essaim, en attente du runner
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX tasks_agent ON tasks (agent_id, status, position);
CREATE UNIQUE INDEX tasks_source ON tasks (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE UNIQUE INDEX tasks_issue ON tasks (agent_id, issue_number) WHERE issue_number IS NOT NULL;

-- Les tickets déjà traités ou en attente deviennent des tâches (même identifiant que leur run).
INSERT INTO tasks (id, agent_id, title, status, issue_number, issue_url, run_id, pr_url, summary, question, created_at, updated_at, source)
SELECT id, agent_id, COALESCE(issue_title, 'Ticket #' || issue_number),
  CASE status WHEN 'done' THEN 'terminee' WHEN 'needs_human' THEN 'question' WHEN 'failed' THEN 'question' ELSE 'en_cours' END,
  issue_number, issue_url, id, pr_url, summary, question, COALESCE(started_at, updated_at), updated_at, 'github'
FROM runs WHERE issue_number IS NOT NULL;
