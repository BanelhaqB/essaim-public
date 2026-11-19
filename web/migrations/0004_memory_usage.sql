-- Connaissance durable d'un agent : le brief (écrit par le propriétaire) et la mémoire (tenue par l'agent, compacte).
ALTER TABLE agents ADD COLUMN brief TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN memory TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN memory_at TEXT;

-- Consommation de tokens, par session Claude (fin de tâche ou tour de conversation).
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  conversation_id TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX usage_agent ON usage (agent_id, at);
CREATE INDEX usage_task ON usage (task_id) WHERE task_id IS NOT NULL;
