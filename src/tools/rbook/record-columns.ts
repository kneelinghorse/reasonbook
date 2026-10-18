// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The shared record's column classes (ADR s96 §4): which columns of each shared table are recorded, which
// ABOUTME: are per copy, which name another row, and the project identity's recorded, per-copy and immutable keys.

/** The tables a shared record shares (ADR s96 §4); s96-m01's SHARED_TABLES holds the same nine. */
export type SharedTable =
  | 'strategic_decisions'
  | 'learnings'
  | 'missions'
  | 'sprints'
  | 'sessions'
  | 'next_steps'
  | 'constraints'
  | 'mission_dependencies'
  | 'session_missions';

/** A recorded column that names another shared row; a change carries that row's stable id. */
export interface Reference {
  readonly column: string;
  readonly table: SharedTable;
}

export interface TableClasses {
  /** The columns that name a row locally: its id, or a link's pair. */
  readonly key: readonly string[];
  /** Guarded and recorded. */
  readonly recorded: readonly string[];
  /** Per copy and never recorded, such as the per-store `origin_seq` (ADR §4). */
  readonly perCopyLocal: readonly string[];
  /** Per copy and derived from recorded columns, such as an embedding hash. */
  readonly perCopyDerived: readonly string[];
  readonly references: readonly Reference[];
  /** Recorded text columns whose extension is an `append`, not a `set` (ADR §5): mission notes. */
  readonly appends: readonly string[];
  /** Recorded JSON-array columns appended by element (ADR §5): session captures. */
  readonly arrayAppends: readonly string[];
  /** A link table: its rows are `link` and `unlink` changes, keyed by the pair. */
  readonly link: boolean;
}

/** The genesis stamp's recorded columns on the seven logged shared tables; `origin_seq` is per copy. */
export const GENESIS = [
  'project_id',
  'stable_event_id',
  'occurred_at',
  'event_type',
  'schema_version',
  'author_user_id',
  'author_name',
] as const;

function entity(
  recorded: readonly string[],
  extra: Partial<Omit<TableClasses, 'recorded' | 'key' | 'link'>> = {}
): TableClasses {
  return {
    key: ['id'],
    recorded: ['id', ...recorded, ...GENESIS],
    perCopyLocal: ['origin_seq', ...(extra.perCopyLocal ?? [])],
    perCopyDerived: extra.perCopyDerived ?? [],
    references: extra.references ?? [],
    appends: extra.appends ?? [],
    arrayAppends: extra.arrayAppends ?? [],
    link: false,
  };
}

export const RECORD_COLUMNS: Readonly<Record<SharedTable, TableClasses>> = {
  strategic_decisions: entity(
    [
      'context_id',
      'decision_text',
      'created_at',
      'sprint_id',
      'project_domain',
      'mission_id',
      'category',
      'superseded_by',
      'status',
      'evidence',
      'author_session_id',
      'source_chunk_ids',
      'last_reviewed_at',
      'context_text',
      'alternatives',
      'consequences',
      'deciders',
      'approval_mode',
      'approval_draft',
      'approval_words',
    ],
    {
      // ADR §2: `context_id` is a fixed name and `snapshot_id` is per copy.
      perCopyLocal: ['snapshot_id'],
      perCopyDerived: ['content_hash', 'last_embedded_hash'],
      references: [
        { column: 'sprint_id', table: 'sprints' },
        { column: 'mission_id', table: 'missions' },
        { column: 'superseded_by', table: 'strategic_decisions' },
        { column: 'author_session_id', table: 'sessions' },
      ],
    }
  ),
  learnings: entity(
    [
      'content',
      'category',
      'status',
      'sprint_id',
      'author_session_id',
      'mission_id',
      'created_at',
      'last_reviewed_at',
      'evergreen',
    ],
    {
      perCopyDerived: ['content_hash', 'last_embedded_hash'],
      references: [
        { column: 'sprint_id', table: 'sprints' },
        { column: 'author_session_id', table: 'sessions' },
        { column: 'mission_id', table: 'missions' },
      ],
    }
  ),
  missions: entity(
    [
      'sprint_id',
      'name',
      'status',
      'completed_at',
      'notes',
      'objective',
      'context',
      'success_criteria',
      'deliverables',
      'reference_docs',
      'domain_fields',
      'metadata',
      'created_at',
      'started_at',
    ],
    {
      // A copy's own time of its last local edit; the log holds when each change was made.
      perCopyLocal: ['updated_at'],
      perCopyDerived: ['last_embedded_hash'],
      references: [{ column: 'sprint_id', table: 'sprints' }],
      appends: ['notes'],
    }
  ),
  sprints: entity(['title', 'focus', 'status', 'start_date', 'end_date'], {
    // Counts only the retired sync wrote; the missions hold the truth.
    perCopyDerived: ['total_missions', 'completed_missions'],
  }),
  sessions: entity(
    [
      'type',
      'title',
      'sprint_id',
      'started_at',
      'completed_at',
      'agent',
      'status',
      'summary',
      'captures',
      'next_steps',
      'metadata',
      'user_id',
    ],
    {
      // ADR §4: `implicit` and `owner_key` belong to the copy whose process owns the session.
      perCopyLocal: ['implicit', 'owner_key'],
      references: [{ column: 'sprint_id', table: 'sprints' }],
      arrayAppends: ['captures'],
    }
  ),
  next_steps: entity(
    [
      'content',
      'status',
      'session_id',
      'sprint_id',
      'mission_id',
      'created_at',
      'resolved_at',
      'carried_to_sprint',
    ],
    {
      perCopyDerived: ['content_hash'],
      references: [
        { column: 'session_id', table: 'sessions' },
        { column: 'sprint_id', table: 'sprints' },
        { column: 'mission_id', table: 'missions' },
        { column: 'carried_to_sprint', table: 'sprints' },
      ],
    }
  ),
  constraints: entity(
    [
      'content',
      'status',
      'session_id',
      'sprint_id',
      'created_at',
      'expires_at',
      'archived_at',
      'last_reviewed_at',
      'evergreen',
    ],
    {
      perCopyDerived: ['content_hash'],
      references: [
        { column: 'session_id', table: 'sessions' },
        { column: 'sprint_id', table: 'sprints' },
      ],
    }
  ),
  mission_dependencies: {
    key: ['from_id', 'to_id'],
    recorded: ['from_id', 'to_id', 'type'],
    perCopyLocal: [],
    perCopyDerived: [],
    references: [
      { column: 'from_id', table: 'missions' },
      { column: 'to_id', table: 'missions' },
    ],
    appends: [],
    arrayAppends: [],
    link: true,
  },
  session_missions: {
    key: ['session_id', 'mission_id'],
    recorded: ['session_id', 'mission_id', 'linked_at', 'source'],
    perCopyLocal: [],
    perCopyDerived: [],
    references: [
      { column: 'session_id', table: 'sessions' },
      { column: 'mission_id', table: 'missions' },
    ],
    appends: [],
    arrayAppends: [],
    link: true,
  },
};

export const RECORDED_TABLES = Object.keys(RECORD_COLUMNS) as SharedTable[];

/**
 * s96-m14 (ADR s96 §9): an import's set names IMPORT_BASE in its base, for the field's root it never
 * saw. While only such sets are live, the root stands as a head too, kept as ROOT_HEAD, and a later
 * write that saw it names that. Neither can be a change id: the merge reads past both, and nothing
 * waits for them.
 */
export const IMPORT_BASE = 'import';
export const ROOT_HEAD = 'root';

/** The project entity (ADR s96 §4): its identity document's keys and its metadata keys. */
export const IDENTITY_KEYS = {
  /** Recorded keys of `contexts.project_identity`; only the authority changes them. */
  document: [
    'project_name',
    'description',
    'status',
    'project_type',
    'tier',
    'domain',
    'platform',
    'objectives',
    'related_projects',
    'foundational_docs',
    'tracelab_refs',
    'type_fields',
  ],
  /** Per-copy keys of the document; they change freely. Any key not named here is per copy too. */
  documentPerCopy: ['rbook_address', 'cmos_address', 'identity_contract_version', 'updated_at'],
  /**
   * Recorded metadata keys. Every other metadata key is per copy. `project_domain` is stamped on
   * each recorded decision, so every copy holds the same one.
   */
  metadata: [
    'project_name',
    'project_description',
    'project_status',
    'project_type',
    'project_domain',
    'tracelab_project_id',
  ],
  /** Never changed on a shared store, even with the token: the log is routed by `project_id`. */
  immutable: ['project_id', 'created_at'],
} as const;

/** The project entity's name in a change, and its field for a document or a metadata key. */
export const PROJECT_ENTITY = 'project';
export function identityField(key: string): string {
  return `identity.${key}`;
}
export function metadataField(key: string): string {
  return `metadata.${key}`;
}
