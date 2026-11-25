-- Repos et équipes : un repo existe seul, des agents y sont rattachés avec leurs droits.
-- agents.repo, agents.brief et agents.memory restent (repo principal de l'agent, ancien format) mais ne font plus foi :
-- le brief est celui du repo, la mémoire celle du lien agent × repo.

CREATE TABLE repos (
  id TEXT PRIMARY KEY,                                      -- owner-name en minuscules
  repo TEXT NOT NULL UNIQUE,                                -- owner/name
  brief TEXT NOT NULL DEFAULT '',                           -- ce qu'est le projet : partagé par toute l'équipe du repo
  create_mode TEXT,                                         -- private | public : le runner crée ce repo GitHub s'il n'existe pas (puis NULL)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agent_repos (
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  access TEXT NOT NULL DEFAULT 'write',                     -- write | read (lecture seule : ne pousse rien)
  merge INTEGER NOT NULL DEFAULT 1,                         -- merger seul quand la CI est verte
  deploy INTEGER NOT NULL DEFAULT 1,                        -- déployer sur Cloudflare
  store INTEGER NOT NULL DEFAULT 0,                         -- publier sur les stores
  handoff_to TEXT,                                          -- agent du même repo à qui passer la main
  max_rounds INTEGER,                                       -- allers-retours de corrections avant d'appeler le propriétaire
  memory TEXT NOT NULL DEFAULT '',                          -- MEMOIRE.md de cet agent sur ce repo
  memory_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,                      -- le plus petit : repo principal de l'agent
  PRIMARY KEY (agent_id, repo_id)
);
CREATE INDEX agent_repos_repo ON agent_repos (repo_id);

ALTER TABLE tasks ADD COLUMN repo_id TEXT REFERENCES repos (id) ON DELETE SET NULL;

-- Reprise de l'existant : un repo par repo d'agent (brief du premier agent qui en a un), un lien par agent.
INSERT INTO repos (id, repo, brief, create_mode)
SELECT lower(replace(a.repo, '/', '-')),
       MIN(a.repo),
       COALESCE((SELECT x.brief FROM agents x WHERE lower(x.repo) = lower(a.repo) AND x.brief <> '' ORDER BY x.priority LIMIT 1), ''),
       (SELECT json_extract(x.settings, '$.createRepo') FROM agents x WHERE lower(x.repo) = lower(a.repo) AND json_extract(x.settings, '$.createRepo') IS NOT NULL LIMIT 1)
FROM agents a
GROUP BY lower(a.repo);

INSERT INTO agent_repos (agent_id, repo_id, merge, deploy, store, memory, memory_at, position)
SELECT a.id,
       lower(replace(a.repo, '/', '-')),
       COALESCE(json_extract(a.settings, '$.merge'), 1),
       COALESCE(json_extract(a.settings, '$.deploy'), 1),
       COALESCE(json_extract(a.settings, '$.store'), 0),
       COALESCE(a.memory, ''),
       a.memory_at,
       0
FROM agents a;

UPDATE tasks SET repo_id = (SELECT lower(replace(a.repo, '/', '-')) FROM agents a WHERE a.id = tasks.agent_id) WHERE agent_id IS NOT NULL;

-- Deux repos d'un même agent peuvent avoir la même issue #n.
DROP INDEX tasks_issue;
CREATE UNIQUE INDEX tasks_issue ON tasks (agent_id, repo_id, issue_number) WHERE issue_number IS NOT NULL;
