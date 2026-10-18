# SQLite Schema Reference

**Database**: `rbook/db/rbook.sqlite`  
**Schema**: `rbook/db/schema.sql`

Quick reference for querying Reasonbook history using any SQLite client.

---

## Core Tables

| Table                  | Purpose                                   | Key Columns                                                  |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `metadata`             | Project identity and schema markers       | `key`, `value`                                               |
| `sprints`              | Sprint registry                           | `id`, `title`, `status`, `start_date`, `end_date`            |
| `missions`             | Mission backlog with status               | `id`, `sprint_id`, `name`, `status`, `completed_at`, `notes` |
| `mission_dependencies` | Edges between missions                    | `from_id`, `to_id`, `type`                                   |
| `contexts`             | JSON payloads for project/master context  | `id`, `content`, `updated_at`                                |
| `context_snapshots`    | Historical context versions               | `context_id`, `content`, `created_at`, `content_hash`        |
| `sessions`             | Universal session registry                | `id`, `type`, `sprint_id`, `started_at`, `status`            |
| `session_missions`     | Session-to-mission links                  | `session_id`, `mission_id`                                   |
| `session_events`       | Project activity/event log                | `ts`, `agent`, `mission`, `action`, `status`, `summary`      |
| `telemetry_events`     | Runtime metrics and health signals        | `mission`, `source_path`, `ts`, `payload`                    |
| `strategic_decisions`  | Durable decision records                  | `id`, `sprint_id`, `mission_id`, `decision_text`, `status`   |
| `learnings`            | Durable learning records                  | `id`, `sprint_id`, `mission_id`, `content`, `status`         |
| `record_links`         | Derived local decision/learning citations | `from_kind`, `from_id`, `to_kind`, `to_id`, `resolution`     |
| `next_steps`           | Action items from sessions and missions   | `id`, `sprint_id`, `mission_id`, `content`, `status`         |
| `constraints`          | Project constraints and review state      | `id`, `content`, `status`, `content_hash`                    |
| `sync_event_queue`     | Legacy unused queue (no active delivery)  | `id`, `event_type`, `envelope`, `status`                     |
| `prompt_mappings`      | Prompt → behavior mapping                 | `prompt`, `behavior`                                         |
| `proposals`            | Drafted records awaiting the operator     | `id`, `text`, `kind`, `outcome`, `created_at`, `record_id`   |

**Views**:

- `project_identity` - Stable project identity and schema markers
- `active_missions` - Convenience projection for current work
- `mission_details` - Missions joined to sprint titles and extended fields
- `sprint_summary` - Dynamically calculated mission and decision counts

`proposals` holds drafts (`Would record:` lines) until the operator answers them; it is outside
search and sync events. A decision recorded from a draft keeps how its approval was known in
`strategic_decisions.approval_mode`, `approval_draft` and `approval_words`.
The mode is `approved`, `agent-judged`, `agent-attested`, or a direct caller's declared
`autonomous`; NULL means the mode was not recorded. Draft proposals retain their existing
three approval modes.

Decision reasoning lives in nullable `context_text`, `alternatives` (JSON string array),
`consequences` and `deciders` (JSON string array). The decision FTS index covers the headline
and all four fields. A write-time migration upgrades the seven nullable shape/approval columns
and owned FTS objects atomically, then writes `metadata.decision_shape_columns=1`; reads do not
run that migration, and old records keep their original text with NULL new fields.

`record_links` stores unique directed textual citation endpoint pairs with `typed` or `bare`
resolution; typed evidence wins when both cite the same target. Canonical decision fields and
array items are parsed separately. Both endpoints must be local (or legacy NULL origin), with a
known target timestamp strictly earlier than its source. Bare numbers must be unambiguous across
decisions, learnings, constraints, next steps and feedback. Reads revalidate current origin, time
and collision eligibility; supersession follows `strategic_decisions.superseded_by` separately.
The owned write-time migration creates/backfills the table atomically and stamps
`metadata.record_links_schema=1` last. Required source rows and link repair share their writer's
transaction. Old stores read explicit typed references without writing a migration; query failures
produce named warnings. Derived links may be removed when endpoint eligibility changes.

Runtime migrations may add tables such as `agent_feedback` and optional search/vector structures.

### Shared Record Storage

Sharing adds a change log and write guards to a prepared store. An unshared store
does not need these objects. The schema file describes the base tables; runtime
preparation adds missing columns and unique indexes on `stable_event_id` across
the eight logged tables. Inspect the actual store with `PRAGMA table_info` and
`PRAGMA index_list`: `metadata.schema_version` is a high-water label, not proof
that a particular migration or sharing step ran.

The shared tables are `strategic_decisions`, `learnings`, `missions`, `sprints`,
`sessions`, `next_steps`, `constraints`, `mission_dependencies` and
`session_missions`. Selected project identity fields are also recorded. The first
seven tables use stable event IDs to identify rows across copies; the two link
tables use their endpoint pairs. New integer IDs for decisions, learnings, next
steps and constraints come from each copy's block of one million IDs. Display IDs
can change during conflict recovery; the stable ID preserves the row's identity.

The following runtime objects are added by sharing or by the first peer route;
they are absent from the shipped seed schema:

- `record_changes` keeps persistent changes, membership, authority moves and
  verdicts. Each change names its transaction, project, replica, sequence, clock,
  kind, entity, field, value and base.
- `record_heads` keeps competing changes for each field; `record_conflicts` marks
  fields requiring a choice, and `record_roots` keeps values before later changes.
- `record_txn_state` and `record_aliases` hold derived transaction state and names
  assigned when text IDs collide.
- `record_peers` holds this copy's routes and exchange health. It is created only
  when needed.
- `record_write_token`, `record_apply_token` and `record_staged` coordinate
  transactions and stage changes. They are empty when the store is at rest.

`record_changes` is unique on `(project_id, replica_id, replica_seq)` as well as
its `change_id`. The owner's copy decides accepted transactions. Only the owner
settles project-identity and decision-lineage conflicts; admitted editors can
settle ordinary fields. Concurrent alternatives remain visible until settled; SQL consumers
should not treat the displayed value as proof that a field has no conflict.

Per-copy state includes metadata such as `replica_id`, `replica_block`,
`replica_seq`, `replica_author`, confirmed owner moves and the last identity-change
notice. The local registry also binds the copy to its path, device, inode and
highest written sequence. Credentials, routes and this registry are not change-log
records. Context snapshots, feedback, search indexes, embeddings, session ownership
and derived citations are also outside the ongoing shared change log. A full
database copy can still contain historical local material; these exclusions do not
make copying the database a selective export.

Use Reasonbook tools and commands to change recorded data. Guard triggers reject
direct SQL changes outside the recording transaction, including writes by older
servers. Do not manufacture tokens or remove the guards. A restored copy may need
to sync and take a new identity before it can write again.

---

## Useful Queries

### Mission Counts by Sprint

```sql
SELECT sprint_id, status, COUNT(*) as count
FROM missions
GROUP BY sprint_id, status
ORDER BY sprint_id IS NULL,
         CASE
           WHEN sprint_id GLOB 'sprint-[0-9]*'
            AND substr(sprint_id, 8) NOT GLOB '*[^0-9]*'
           THEN CAST(substr(sprint_id, 8) AS INTEGER)
         END DESC,
         sprint_id COLLATE BINARY DESC,
         status;
```

### Find Open Missions

```sql
SELECT id, name, status, completed_at
FROM missions
WHERE status IN ('Current', 'In Progress', 'Queued')
ORDER BY CASE status
           WHEN 'In Progress' THEN 1
           WHEN 'Current' THEN 2
           WHEN 'Queued' THEN 3
           ELSE 4
         END,
         id;
```

### View Sprint Progress

```sql
SELECT sprint_id AS id, title,
       completed_missions || '/' || total_missions as progress,
       status, blocked_missions, active_missions
FROM sprint_summary
ORDER BY start_date DESC, sprint_id COLLATE BINARY DESC;
```

### Get Recent Activity Events

```sql
SELECT ts, mission, action, status, summary
FROM session_events
ORDER BY ts DESC
LIMIT 10;
```

### Review Planning/Onboarding Sessions

```sql
SELECT id, type, title, started_at, completed_at, status
FROM sessions
WHERE type IN ('planning', 'onboarding')
ORDER BY started_at DESC
LIMIT 10;
```

### List Mission Rows for a Sprint

```sql
SELECT id, name, status, completed_at, notes
FROM missions
WHERE sprint_id = 'sprint-05'
ORDER BY id;
```

### Check Context Updates

```sql
SELECT id, updated_at,
       LENGTH(content) as size_bytes
FROM contexts
ORDER BY updated_at DESC;
```

### View Context History

```sql
SELECT created_at, session_id, source,
       LENGTH(content) as size_bytes
FROM context_snapshots
WHERE context_id = 'master_context'
ORDER BY created_at DESC
LIMIT 5;
```

---

## Accessing the Database

Use any SQLite client:

**Command line**:

```bash
sqlite3 -readonly rbook/db/rbook.sqlite

# Run query
sqlite3 -readonly rbook/db/rbook.sqlite "SELECT * FROM sprints;"

# Interactive mode
sqlite3 -readonly rbook/db/rbook.sqlite
> .tables
> .schema missions
> SELECT * FROM missions LIMIT 5;
```

**GUI tools** (any will work):

- DB Browser for SQLite
- DBeaver
- TablePlus
- DataGrip
- VS Code SQLite extension
- etc.

All standard SQLite tools work for reads without special configuration.

---

## Schema Details

See `rbook/db/schema.sql` for the shipped base schema including:

- Table definitions with foreign keys
- Indexes for query performance
- Views for common queries
- Constraints and defaults

---

## Maintenance Queries

### Compact Database

Back up the database and stop the MCP server (or otherwise ensure there are no active writers)
before running `VACUUM`.

```sql
VACUUM;
```

### Check Database Size

```sql
SELECT page_count * page_size as size_bytes
FROM pragma_page_count(), pragma_page_size();
```

### Verify Foreign Keys

```sql
PRAGMA foreign_key_check;
```

### List All Tables

```sql
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name NOT LIKE 'sqlite_%'
ORDER BY name;
```

---

**Last Updated**: 2026-10-18
**Replaces**: `sqlite-db-browser-guide.md` (tool-agnostic version)
