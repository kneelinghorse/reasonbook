-- Reasonbook SQLite Schema
-- Version: 2.1
-- Generated for zero-dependency project initialization

PRAGMA foreign_keys = ON;

-- Project-level metadata
-- Standard keys:
--   project_id: UUID or slug uniquely identifying this Reasonbook project
--   project_name: Human-readable project name
--   tracelab_project_id: UUID of linked TraceLab project (for cross-referencing)
--   created_at: ISO timestamp when project was initialized
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Initialize standard metadata keys (no-op if already exists)
--
-- No identity rows are seeded: rbook_project(init) writes project_id and project_name. An empty
-- row would satisfy NOT NULL while meaning nothing, and reads treat an absent row as empty anyway.
INSERT INTO metadata (key, value) SELECT 'created_at', datetime('now') WHERE NOT EXISTS (SELECT 1 FROM metadata WHERE key = 'created_at');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '2.1');

CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  focus TEXT,
  status TEXT,
  start_date TEXT,
  end_date TEXT,
  total_missions INTEGER,
  completed_missions INTEGER,
  -- Per-row event columns (nullable here; the lazy migration upgrades
  -- to NOT NULL + CHECK on first genesis write — see schema-migrations.ts).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_sprints_aggkey ON sprints (project_id, event_type, occurred_at);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT,
  notes TEXT,

  -- Full mission specification fields
  objective TEXT,
  context TEXT,
  success_criteria TEXT,  -- JSON array
  deliverables TEXT,      -- JSON array
  reference_docs TEXT,    -- JSON array (renamed from 'references' to avoid SQL keyword)
  domain_fields TEXT,     -- Full JSON of domainFields section

  -- Timestamp fields for KPI calculations
  created_at TEXT,        -- When mission was added
  started_at TEXT,        -- When mission first moved to In Progress
  updated_at TEXT,        -- Last state change timestamp

  -- Legacy metadata field (for backward compatibility)
  metadata TEXT,

  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_missions_aggkey ON missions (project_id, event_type, occurred_at);

CREATE TABLE IF NOT EXISTS mission_dependencies (
  from_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  session_id TEXT,
  source TEXT,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT,
  -- Content-tombstone marker: NULL = content intact; a timestamp = the snapshot prune emptied
  -- this row's content, or it was written without content (row, metadata, FK and event kept).
  content_pruned_at TEXT,
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_ctx ON context_snapshots (context_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_hash ON context_snapshots (context_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_aggkey ON context_snapshots (project_id, event_type, occurred_at);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  agent TEXT,
  mission TEXT,
  action TEXT,
  status TEXT,
  summary TEXT,
  next_hint TEXT,
  raw_event TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission TEXT,
  source_path TEXT NOT NULL,
  ts TEXT,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  captures TEXT DEFAULT '[]',
  next_steps TEXT,
  metadata TEXT,
  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; user_id is the author author_session_id
  -- points at, bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT,
  user_id TEXT,
  -- Implicit sessions: 1 for a session the server opened because a write
  -- named none; owner_key says whose it is (an explicit one's starter, NULL before 3.3.0).
  implicit INTEGER NOT NULL DEFAULT 0,
  owner_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_aggkey ON sessions (project_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions (type);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS prompt_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  behavior TEXT NOT NULL
);

-- Strategic decisions index for a queryable project record
-- Keeps decisions from MASTER_CONTEXT searchable without parsing JSON
CREATE TABLE IF NOT EXISTS strategic_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL DEFAULT 'master_context',
  decision_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sprint_id TEXT,
  snapshot_id INTEGER,
  project_domain TEXT,
  author_session_id TEXT,  -- formerly session_id: the project-scoped session of origin
  mission_id TEXT,  -- Reference to mission that produced this decision
  source_chunk_ids TEXT,  -- JSON array of TraceLab chunk UUIDs for decision provenance
  category TEXT,          -- architectural | process | tooling | design | business
  superseded_by INTEGER,  -- FK to newer decision that replaces this one
  status TEXT NOT NULL DEFAULT 'active',  -- active | superseded | archived
  evidence TEXT,          -- JSON array of TraceLab evidence references [{type, id}]
  content_hash TEXT,      -- SHA-256 hash for client-side dedup (decision_text + project_domain)
  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT,
  -- Decision reasoning and effects; omitted legacy fields remain NULL.
  context_text TEXT,
  alternatives TEXT,     -- JSON array of strings
  consequences TEXT,
  deciders TEXT,         -- JSON array of strings
  -- Approval or declared execution mode (NULL means not recorded).
  approval_mode TEXT,     -- approved | agent-judged | agent-attested | autonomous
  approval_draft TEXT,    -- the draft it came from (P<n>)
  approval_words TEXT,    -- the operator's message, for approved and agent-judged
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(id) ON DELETE SET NULL,
  FOREIGN KEY (author_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL,
  FOREIGN KEY (superseded_by) REFERENCES strategic_decisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_strategic_decisions_created ON strategic_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_sprint ON strategic_decisions (sprint_id);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_domain ON strategic_decisions (project_domain);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_author_session ON strategic_decisions (author_session_id);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_mission ON strategic_decisions (mission_id);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_status ON strategic_decisions (status);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_category ON strategic_decisions (category);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_hash ON strategic_decisions (content_hash);
CREATE INDEX IF NOT EXISTS idx_strategic_decisions_aggkey ON strategic_decisions (project_id, event_type, occurred_at);

-- Structured learnings for queryable project knowledge
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT,            -- technical | process | agent-behavior | tooling
  status TEXT NOT NULL DEFAULT 'active',  -- active | archived | superseded | stale (set only by an explicit status update; no CHECK constraint)
  sprint_id TEXT,
  author_session_id TEXT,  -- formerly session_id: the project-scoped session of origin
  mission_id TEXT,
  created_at TEXT NOT NULL,
  content_hash TEXT,    -- SHA-256 hash for client-side dedup (content + category)
  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL,
  FOREIGN KEY (author_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_learnings_aggkey ON learnings (project_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_learnings_author_session ON learnings (author_session_id);
CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings (status);
CREATE INDEX IF NOT EXISTS idx_learnings_sprint ON learnings (sprint_id);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings (category);
CREATE INDEX IF NOT EXISTS idx_learnings_mission ON learnings (mission_id);
CREATE INDEX IF NOT EXISTS idx_learnings_hash ON learnings (content_hash);

-- Derived local citation links; the write migration backfills and stamps its version.
CREATE TABLE IF NOT EXISTS record_links (
  from_kind TEXT NOT NULL CHECK (from_kind IN ('decision', 'learning')),
  from_id INTEGER NOT NULL CHECK (from_id > 0),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('decision', 'learning')),
  to_id INTEGER NOT NULL CHECK (to_id > 0),
  resolution TEXT NOT NULL CHECK (resolution IN ('typed', 'bare')),
  PRIMARY KEY (from_kind, from_id, to_kind, to_id)
);
CREATE INDEX IF NOT EXISTS idx_record_links_target ON record_links (to_kind, to_id);

-- FTS5 full-text search index for strategic decisions
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  decision_text,
  context_text,
  alternatives,
  consequences,
  deciders,
  content='strategic_decisions',
  content_rowid='id'
);

-- Auto-sync triggers for FTS5 index
CREATE TRIGGER IF NOT EXISTS decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
  INSERT INTO decisions_fts(rowid, decision_text, context_text, alternatives, consequences, deciders)
  VALUES (new.id, new.decision_text, new.context_text, new.alternatives, new.consequences, new.deciders);
END;

CREATE TRIGGER IF NOT EXISTS decisions_fts_delete AFTER DELETE ON strategic_decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision_text, context_text, alternatives, consequences, deciders)
  VALUES('delete', old.id, old.decision_text, old.context_text, old.alternatives, old.consequences, old.deciders);
END;

CREATE TRIGGER IF NOT EXISTS decisions_fts_update AFTER UPDATE OF decision_text, context_text, alternatives, consequences, deciders ON strategic_decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision_text, context_text, alternatives, consequences, deciders)
  VALUES('delete', old.id, old.decision_text, old.context_text, old.alternatives, old.consequences, old.deciders);
  INSERT INTO decisions_fts(rowid, decision_text, context_text, alternatives, consequences, deciders)
  VALUES (new.id, new.decision_text, new.context_text, new.alternatives, new.consequences, new.deciders);
END;

-- Persistent sync event queue for WAL-backed event delivery
-- Events are written here before HTTP push, surviving MCP restarts.
CREATE TABLE IF NOT EXISTS sync_event_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  envelope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_event_queue (status, created_at);

-- Session-mission association tracking
-- Links sessions to missions via captures or explicit association
CREATE TABLE IF NOT EXISTS session_missions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'capture',
  PRIMARY KEY (session_id, mission_id)
);

CREATE INDEX IF NOT EXISTS idx_session_missions_mission ON session_missions (mission_id);

-- Structured next-steps with lifecycle management
-- Extracted from session completions, supports status tracking
CREATE TABLE IF NOT EXISTS next_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  carried_to_sprint TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  content_hash TEXT,
  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_next_steps_aggkey ON next_steps (project_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_next_steps_status ON next_steps (status);
CREATE INDEX IF NOT EXISTS idx_next_steps_sprint ON next_steps (sprint_id);
CREATE INDEX IF NOT EXISTS idx_next_steps_mission ON next_steps (mission_id);
CREATE INDEX IF NOT EXISTS idx_next_steps_hash ON next_steps (content_hash);

-- Structured constraints with lifecycle and expiry
-- Extracted from session captures, supports staleness detection and archival
CREATE TABLE IF NOT EXISTS constraints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  archived_at TEXT,
  content_hash TEXT,
  -- Per-row event columns (nullable here; the lazy migration upgrades them).
  project_id TEXT,
  stable_event_id TEXT,
  occurred_at INTEGER,
  origin_seq INTEGER,
  event_type TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Author identity (nullable; bound when the multi-user layer lands).
  author_user_id TEXT,
  author_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_constraints_aggkey ON constraints (project_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_constraints_status ON constraints (status);
CREATE INDEX IF NOT EXISTS idx_constraints_expires ON constraints (expires_at);
CREATE INDEX IF NOT EXISTS idx_constraints_hash ON constraints (content_hash);

-- Drafted records awaiting the operator: a carve-out outside FTS and sync events
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- shown as P<id>
  text TEXT NOT NULL,                        -- the line after "Would record…:"
  kind TEXT NOT NULL DEFAULT 'decision',     -- decision | constraint | rule | profile
  source_session TEXT,                       -- the harness session hash (16 hex), never a raw id
  assistant_excerpt TEXT,                    -- up to 600 characters of the reply before the lines
  evidence TEXT,                             -- JSON array of links and documents the line names
  outside_content INTEGER,                   -- 1 seen in the session, 0 none, NULL unknown
  created_at TEXT NOT NULL,
  offered_at TEXT,
  answered_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | declined | replaced | answered
  replaced_by INTEGER,                       -- the draft that revised this one
  record_id TEXT,                            -- the record it became: d:N, c:N, l:N or profile
  approval_mode TEXT                         -- approved | agent-judged | agent-attested
);
CREATE INDEX IF NOT EXISTS idx_proposals_outcome ON proposals (outcome);

-- Project identity view for easy access to project-level metadata
CREATE VIEW IF NOT EXISTS project_identity AS
SELECT
  (SELECT value FROM metadata WHERE key = 'project_id') AS project_id,
  (SELECT value FROM metadata WHERE key = 'project_name') AS project_name,
  (SELECT value FROM metadata WHERE key = 'tracelab_project_id') AS tracelab_project_id,
  (SELECT value FROM metadata WHERE key = 'created_at') AS created_at,
  (SELECT value FROM metadata WHERE key = 'schema_version') AS schema_version;

CREATE VIEW IF NOT EXISTS active_missions AS
SELECT m.id,
       m.name,
       m.status,
       m.completed_at,
       m.notes,
       s.id AS sprint_id,
       s.title AS sprint_title
  FROM missions m
  LEFT JOIN sprints s ON s.id = m.sprint_id
 WHERE m.status IN ('Current', 'In Progress');

-- Mission detail view for easy inspection
CREATE VIEW IF NOT EXISTS mission_details AS
SELECT m.id,
       m.name,
       m.status,
       s.id AS sprint_id,
       s.title AS sprint_title,
       m.objective,
       m.context,
       m.success_criteria,
       m.deliverables,
       m.reference_docs,
       m.domain_fields,
       m.completed_at,
       m.notes
  FROM missions m
  LEFT JOIN sprints s ON s.id = m.sprint_id;

-- Sprint summary view for retrospectives and analysis
CREATE VIEW IF NOT EXISTS sprint_summary AS
SELECT
  s.id AS sprint_id,
  s.title,
  s.status,
  s.focus,
  s.start_date,
  s.end_date,
  COUNT(CASE WHEN m.id IS NOT NULL AND UPPER(COALESCE(m.status, '')) NOT IN ('DEFERRED', 'DROPPED') THEN 1 END) AS total_missions,
  COUNT(CASE WHEN UPPER(m.status) IN ('COMPLETED', 'COMPLETE') THEN 1 END) AS completed_missions,
  COUNT(CASE WHEN m.status = 'Blocked' THEN 1 END) AS blocked_missions,
  COUNT(CASE WHEN m.status IN ('Current', 'In Progress') THEN 1 END) AS active_missions,
  COUNT(CASE WHEN m.id IS NOT NULL AND UPPER(COALESCE(m.status, '')) IN ('DEFERRED', 'DROPPED') THEN 1 END) AS parked_missions,
  (
    SELECT COUNT(DISTINCT sd.id)
    FROM strategic_decisions sd
    WHERE sd.sprint_id = s.id
  ) AS decisions_count
FROM sprints s
LEFT JOIN missions m ON m.sprint_id = s.id
GROUP BY s.id, s.title, s.status, s.focus, s.start_date, s.end_date;
