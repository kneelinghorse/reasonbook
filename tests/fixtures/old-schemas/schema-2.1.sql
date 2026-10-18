-- SPDX-License-Identifier: Apache-2.0
-- ABOUTME: s96-m14 fixture: the shared tables of cmos-mcp's store at its commit 670e068 (2026-04-04), schema 2.1: every shared table, no stable ids.
-- ABOUTME: Schema only, read from sqlite_master; a test builds a copy made before sharing from it.
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE sprints (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  focus TEXT,
  status TEXT,
  start_date TEXT,
  end_date TEXT,
  total_missions INTEGER,
  completed_missions INTEGER
);
CREATE TABLE missions (
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

  -- Legacy metadata field (for backward compatibility)
  metadata TEXT
, created_at TEXT, started_at TEXT, updated_at TEXT);
CREATE TABLE mission_dependencies (
  from_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE contexts (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  session_id TEXT,
  source TEXT,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
);
CREATE TABLE strategic_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL DEFAULT 'master_context',
  decision_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sprint_id TEXT,
  snapshot_id INTEGER,
  project_domain TEXT, mission_id TEXT, category TEXT, superseded_by INTEGER, status TEXT DEFAULT 'active', evidence TEXT, session_id TEXT, source_chunk_ids TEXT, content_hash TEXT,  -- e.g., 'ai-studio', allows multi-project support
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(id) ON DELETE SET NULL
);
CREATE TABLE sessions (
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
  metadata TEXT
);
CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    sprint_id TEXT,
    session_id TEXT,
    mission_id TEXT,
    created_at TEXT NOT NULL
  , content_hash TEXT);
CREATE TABLE next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      carried_to_sprint TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      content_hash TEXT
    );
CREATE TABLE session_missions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'capture',
      PRIMARY KEY (session_id, mission_id)
    );
CREATE TABLE constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      archived_at TEXT,
      content_hash TEXT
    );
