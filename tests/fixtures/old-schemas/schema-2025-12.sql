-- SPDX-License-Identifier: Apache-2.0
-- ABOUTME: s96-m14 fixture: the shared tables of a TraceLab copy made in December 2025: no learnings, next steps, constraints or session links, and decisions without a status.
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
);
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
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                          -- e.g., PS-2024-11-13-001
  type TEXT NOT NULL,                           -- onboarding, planning, review, etc.
  title TEXT NOT NULL,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  agent TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,                         -- active, completed, canceled
  captures TEXT,                                -- JSON array of captured insights
  next_steps TEXT,                              -- JSON array for handoff actions
  metadata TEXT                                 -- Flexible JSON blob
);
CREATE TABLE strategic_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL DEFAULT 'master_context',
  decision_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sprint_id TEXT,
  snapshot_id INTEGER,
  project_domain TEXT,  -- e.g., 'ai-studio', allows multi-project support
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(id) ON DELETE SET NULL
);
