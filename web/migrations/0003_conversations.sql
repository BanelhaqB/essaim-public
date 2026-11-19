-- Conversations avec un agent : celle d'une tâche (même identifiant que la tâche) ou une conversation libre.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX conversations_agent ON conversations (agent_id, updated_at DESC);

-- Fil d'une conversation : messages du propriétaire (user), réponses de l'agent (agent), appels d'outils (tool), notes (system).
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  level TEXT,
  text TEXT NOT NULL,
  mid TEXT,                              -- identifiant donné par l'émetteur : pas de doublon entre le direct et l'historique
  delivered INTEGER NOT NULL DEFAULT 1,  -- message du propriétaire pas encore remis au runner : 0
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);
CREATE INDEX messages_pending ON messages (agent_id) WHERE delivered = 0;
CREATE UNIQUE INDEX messages_mid ON messages (mid) WHERE mid IS NOT NULL;

-- Les tâches déjà lancées ont leur conversation.
INSERT INTO conversations (id, agent_id, task_id, title, created_at, updated_at)
SELECT id, agent_id, id, title, created_at, updated_at FROM tasks WHERE run_id IS NOT NULL AND agent_id IS NOT NULL;
