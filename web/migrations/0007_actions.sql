-- Actions en un clic d'un agent (installer l'app sur l'iPhone, générer l'APK, publier…) : une commande que le runner
-- lance dans le repo à jour, ou une consigne envoyée à l'agent dans une nouvelle discussion. L'agent tient la liste
-- dans ACTIONS.json (dossier de sa mémoire) ; le propriétaire peut aussi la modifier dans Essaim.
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  command TEXT,                        -- commande shell (si présente, elle prime)
  prompt TEXT,                         -- sinon : consigne donnée à l'agent
  confirm INTEGER NOT NULL DEFAULT 0,  -- demander confirmation avant de lancer (publication, action coûteuse)
  timeout_minutes INTEGER,             -- NULL : 60 min
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX actions_agent ON actions (agent_id, position);

-- Lancements : la sortie s'écrit dans la conversation du lancement. Nom et commande sont copiés (l'action peut changer).
CREATE TABLE action_runs (
  id TEXT PRIMARY KEY,
  action_id TEXT REFERENCES actions (id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT,                        -- NULL : consigne (discussion avec l'agent)
  timeout_minutes INTEGER,
  status TEXT NOT NULL,                -- demandee | en_cours | reussie | echouee | arretee | discussion
  stop INTEGER NOT NULL DEFAULT 0,     -- arrêt demandé dans Essaim
  exit_code INTEGER,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX action_runs_agent ON action_runs (agent_id, requested_at DESC);
CREATE INDEX action_runs_conversation ON action_runs (conversation_id);
CREATE INDEX action_runs_open ON action_runs (status) WHERE status IN ('demandee', 'en_cours');
