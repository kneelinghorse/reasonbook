/**
 * Embedded Reasonbook Schema
 *
 * Contains the full Reasonbook SQLite schema as a constant string for bundling.
 * This allows rbook_project_init to create databases without external file dependencies.
 *
 * Schema version: 2.0 (with project identifier support)
 * Last updated: 2025-12-27
 *
 * @module tools/rbook/schema
 */

import { PROPOSALS_TABLE_SQL } from './proposals';
import { RECORD_LINKS_TABLE_SQL, RECORD_LINKS_INDEX_SQL } from './record-link-schema';
import {
  PARKED_MISSION_STATUSES,
  missionCompletedSql,
  statusInSql,
  statusNotInSql,
} from './terminal-status';

/**
 * Current Reasonbook schema version identifier.
 * Update this when making breaking schema changes.
 */
export const RBOOK_SCHEMA_VERSION = '2.1';

/**
 * s86-m08 — the `sprint_summary` view, declared ONCE and interpolated into {@link RBOOK_SCHEMA}.
 *
 * IT LIVES IN ITS OWN CONSTANT so the fresh-store path and the upgrade path cannot drift:
 * `ensureSprintSummaryView` (schema-migrations.ts) compares a store's stored definition against
 * THIS text and rewrites it when they differ. `CREATE VIEW IF NOT EXISTS` never updates an
 * existing view, so without that migration every store created before this change would keep
 * the old counting rule forever while new stores got the new one — two fleets, one column name.
 *
 * WHY total_missions EXCLUDES Deferred AND Dropped. The old `COUNT(m.id)` counted every row a
 * sprint ever held, so a sprint was PUNISHED for parking work honestly: sprint-85 read 9 total /
 * 5 completed = 56% while every mission it actually owned was Completed. Parked work is not
 * hidden — it moves to its own `parked_missions` column, which is the whole reason this is a
 * split rather than a filter. Blocked STAYS in the denominator (work the sprint owned and failed
 * to land; `blocked_missions` already reports it separately), and so does Archived.
 *
 * THE THREE-PART GUARD IN EACH COUNT IS LOAD-BEARING — each clause fixes a case the obvious
 * form gets wrong, verified empirically against {Completed, Deferred, NULL, 'deferred'} rows
 * plus a mission-less sprint:
 *
 *   - `m.id IS NOT NULL` — without it the LEFT JOIN's phantom row for a sprint with ZERO
 *     missions coalesces to '' and lands in total_missions, so an empty sprint reports 1.
 *   - `COALESCE(m.status, '')` — without it a NULL status makes both `NOT IN` and `IN` yield
 *     NULL, so the row vanishes from BOTH counts and the two no longer sum to COUNT(m.id).
 *   - `UPPER(...)` — without it a case-drifted 'deferred' is counted as NON-parked, the exact
 *     drift `statusNotInSql` (terminal-status.ts) exists to prevent.
 *
 * INVARIANT, asserted in tests against every sprint on a real store:
 * `total_missions + parked_missions = COUNT(m.id)`.
 *
 * s94-m05: completed_missions recognizes historical complete/completed case aliases without
 * rewriting rows. Blocked and active counts retain their existing comparisons.
 */
export const SPRINT_SUMMARY_VIEW_SQL = `CREATE VIEW IF NOT EXISTS sprint_summary AS
SELECT
  s.id AS sprint_id,
  s.title,
  s.status,
  s.focus,
  s.start_date,
  s.end_date,
  COUNT(CASE WHEN m.id IS NOT NULL AND ${statusNotInSql("COALESCE(m.status, '')", PARKED_MISSION_STATUSES)} THEN 1 END) AS total_missions,
  COUNT(CASE WHEN ${missionCompletedSql('m.status')} THEN 1 END) AS completed_missions,
  COUNT(CASE WHEN m.status = 'Blocked' THEN 1 END) AS blocked_missions,
  COUNT(CASE WHEN m.status IN ('Current', 'In Progress') THEN 1 END) AS active_missions,
  COUNT(CASE WHEN m.id IS NOT NULL AND ${statusInSql("COALESCE(m.status, '')", PARKED_MISSION_STATUSES)} THEN 1 END) AS parked_missions,
  (
    SELECT COUNT(DISTINCT sd.id)
    FROM strategic_decisions sd
    WHERE sd.sprint_id = s.id
  ) AS decisions_count
FROM sprints s
LEFT JOIN missions m ON m.sprint_id = s.id
GROUP BY s.id, s.title, s.status, s.focus, s.start_date, s.end_date;`;

/**
 * Complete Reasonbook SQLite schema.
 *
 * Tables:
 * - metadata: Project-level key-value metadata
 * - sprints: Sprint definitions with dates and focus
 * - missions: Work items with full spec fields
 * - mission_dependencies: Relationships between missions
 * - contexts: Project/master context storage
 * - context_snapshots: Historical context timeline
 * - session_events: Legacy event log
 * - sessions: Universal session registry
 * - telemetry_events: Runtime telemetry
 * - prompt_mappings: Prompt behavior mappings
 * - strategic_decisions: Queryable decision index
 * - sync_event_queue: Persistent WAL-backed sync event delivery queue
 *
 * Views:
 * - project_identity: Easy access to project metadata
 * - active_missions: Currently active missions
 * - mission_details: Full mission info with sprint
 * - sprint_summary: Sprint stats with counts
 */
export const RBOOK_SCHEMA = `-- Reasonbook SQLite Schema
-- Version: ${RBOOK_SCHEMA_VERSION}
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
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '${RBOOK_SCHEMA_VERSION}');

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
${RECORD_LINKS_TABLE_SQL.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')};
${RECORD_LINKS_INDEX_SQL.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS')};

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
${PROPOSALS_TABLE_SQL}

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
${SPRINT_SUMMARY_VIEW_SQL}
`;

/**
 * Template for initial project context.
 */
export const INITIAL_PROJECT_CONTEXT = {
  session_id: null,
  active_mission: null,
  session_count: 0,
  working_memory: [],
  context_health: {
    last_updated: new Date().toISOString(),
    stale_threshold_hours: 24,
  },
};

/**
 * Template for initial master context.
 */
export const INITIAL_MASTER_CONTEXT = {
  project_identity: {
    name: '',
    description: '',
    status: 'active_development',
  },
  technical_foundation: {
    stack: [],
    architecture_notes: [],
  },
  decisions_made: [],
  constraints: [],
  learnings: [],
};
