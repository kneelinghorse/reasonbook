// SPDX-License-Identifier: Apache-2.0
// ABOUTME: An entity's state from its live changes (ADR s96 §5): per field the heads, read through what is not live, then
// ABOUTME: one value or a conflict with a provisional value; appends in order, add-wins flags, the later review, links.

import type { RbookDatabaseClient } from './client';
import { canonicalJson } from './record-capture';
import {
  IMPORT_BASE,
  PROJECT_ENTITY,
  RECORD_COLUMNS,
  ROOT_HEAD,
  type SharedTable,
} from './record-columns';
import { txnStanding, type LoggedChange, type MergeContext } from './record-standing';

/** Flags merge by what each change saw; between concurrent changes, add wins (ADR §5). */
const FLAG_FIELDS: ReadonlySet<string> = new Set(['evergreen']);
/** A review takes the later value (ADR §5). */
const LATER_FIELDS: ReadonlySet<string> = new Set(['last_reviewed_at']);
const WRITES: ReadonlySet<string> = new Set(['set', 'settle']);

/** A field's value, before references are turned back into this copy's ids. */
export type FieldValue = { readonly json: unknown } | { readonly unchanged: true };

export interface Candidate {
  readonly changeId: string;
  readonly value: unknown;
  readonly author: string | null;
  readonly hlc: string;
}

export interface FieldState {
  readonly field: string;
  readonly heads: readonly string[];
  readonly value: FieldValue;
  readonly conflict: boolean;
  /** Every head with its value, when the field is in conflict. */
  readonly candidates: readonly Candidate[];
}

export interface EntityState {
  readonly entity: string;
  readonly entityId: string;
  /** A baseline row exists while this copy holds it; a created row, while its create is live. */
  readonly exists: boolean;
  readonly create: LoggedChange | null;
  readonly fields: readonly FieldState[];
}

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));
const order = (a: LoggedChange, b: LoggedChange): number =>
  a.hlc === b.hlc ? (a.change_id < b.change_id ? -1 : 1) : a.hlc < b.hlc ? -1 : 1;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/** A change's base, with every entry that is not live read through to its own base (ADR §5). */
function effectiveBase(
  change: LoggedChange,
  byId: ReadonlyMap<string, LoggedChange>,
  live: ReadonlySet<string>,
  seen: Set<string> = new Set()
): Set<string> {
  const result = new Set<string>();
  for (const entry of (parse(change.base) as string[] | null) ?? []) {
    if (live.has(entry)) result.add(entry);
    else {
      const through = byId.get(entry);
      if (!through || seen.has(entry)) continue;
      seen.add(entry);
      for (const inner of effectiveBase(through, byId, live, seen)) result.add(inner);
    }
  }
  return result;
}

/**
 * s96-m14: the live additions to an appended field that these heads had applied, so a settle that
 * keeps their value covers those and no others. The root, beside an import's sets, had applied none.
 */
export function appendsCoveredBy(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  entity: string,
  entityId: string,
  headIds: readonly string[]
): string[] {
  const changes = rows<LoggedChange>(
    client,
    'SELECT * FROM record_changes WHERE entity = ? AND entity_id = ?',
    [entity, entityId]
  );
  const byId = new Map(changes.map((change) => [change.change_id, change]));
  const live = new Set(
    changes
      .filter((change) => txnStanding(client, ctx, change.txn_id).state === 'live')
      .map((change) => change.change_id)
  );
  const covered = new Set<string>();
  for (const headId of headIds) {
    const head = byId.get(headId);
    if (head)
      for (const entry of effectiveBase(head, byId, live))
        if (byId.get(entry)?.kind === 'append') covered.add(entry);
  }
  return [...covered].sort();
}

/** The live changes no other live change of the field names as seen: the field's heads. */
function headsOf(
  writes: readonly LoggedChange[],
  byId: ReadonlyMap<string, LoggedChange>,
  live: ReadonlySet<string>
): LoggedChange[] {
  const named = new Set<string>();
  for (const write of writes)
    for (const entry of effectiveBase(write, byId, live)) named.add(entry);
  return writes.filter((write) => !named.has(write.change_id)).sort(order);
}

/** The value a field has with no live write: the create's, or the one this copy kept from the baseline. */
function rootOf(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string,
  create: LoggedChange | null
): FieldValue {
  if (create) {
    const values = parse(create.value) as Record<string, unknown>;
    return { json: field in values ? values[field] : null };
  }
  const [root] = rows<{ value: string | null }>(
    client,
    'SELECT value FROM record_roots WHERE entity = ? AND entity_id = ? AND field = ?',
    [entity, entityId, field]
  );
  return root ? { json: parse(root.value) } : { unchanged: true };
}

function joinAppends(
  root: FieldValue,
  appends: readonly LoggedChange[],
  array: boolean
): FieldValue {
  if (!appends.length) return root;
  const start = 'json' in root ? root.json : null;
  if (array) {
    const items: unknown[] = typeof start === 'string' && start ? JSON.parse(start) : [];
    return { json: JSON.stringify([...items, ...appends.map((append) => parse(append.value))]) };
  }
  return {
    json: String(start ?? '') + appends.map((append) => String(parse(append.value))).join(''),
  };
}

function plainField(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string,
  changes: readonly LoggedChange[],
  byId: ReadonlyMap<string, LoggedChange>,
  live: ReadonlySet<string>,
  create: LoggedChange | null
): FieldState {
  const writes = changes.filter(
    (change) => change.field === field && WRITES.has(change.kind) && live.has(change.change_id)
  );
  const heads = headsOf(writes, byId, live);
  const imported = (write: LoggedChange) =>
    ((parse(write.base) as string[] | null) ?? []).includes(IMPORT_BASE);
  // s96-m14 (ADR s96 §9): an import's set never saw the field's root, so while every live write of
  // the field is one, the root stands as a head beside them: the shared record's value and the copy's.
  const unseen =
    writes.length > 0 && writes.every(imported)
      ? rootOf(client, entity, entityId, field, create)
      : null;
  const root = unseen && 'json' in unseen ? { value: unseen.json } : null;
  const table = RECORD_COLUMNS[entity as SharedTable];
  const appendKind = table?.appends.includes(field)
    ? 'text'
    : table?.arrayAppends.includes(field)
      ? 'array'
      : null;
  const values = [...(root ? [root.value] : []), ...heads.map((head) => parse(head.value))];
  const distinct = new Set(values.map((value) => canonicalJson(value)));
  let value: FieldValue;
  let conflict = false;
  if (!heads.length) value = rootOf(client, entity, entityId, field, create);
  else if (distinct.size === 1) value = { json: values[0] };
  else if (FLAG_FIELDS.has(field))
    value = { json: values.find((item) => Boolean(item)) ?? values[0] };
  else if (LATER_FIELDS.has(field))
    value = {
      json:
        values
          .map((item) => String(item ?? ''))
          .sort()
          .slice(-1)[0] || null,
    };
  else {
    conflict = true;
    value = { json: values[values.length - 1] };
  }
  // s96-m14: reads keep the shared record's value in a conflict an import raised, until it is
  // settled: the root while only imports stand beside it, else the record's own newest head.
  const own = heads.filter((head) => !imported(head));
  const provisional = root ? null : (own[own.length - 1] ?? heads[heads.length - 1] ?? null);
  if (conflict) value = { json: root ? root.value : parse(provisional!.value) };
  if (appendKind) {
    // The provisional head covers the appends its writer had applied; the rest follow in order.
    const covered = provisional ? effectiveBase(provisional, byId, live) : new Set<string>();
    const appends = changes
      .filter(
        (change) =>
          change.field === field &&
          change.kind === 'append' &&
          live.has(change.change_id) &&
          !covered.has(change.change_id)
      )
      .sort(order);
    if (appends.length && 'unchanged' in value)
      value = rootOf(client, entity, entityId, field, create);
    value = joinAppends(value, appends, appendKind === 'array');
  }
  return {
    field,
    heads: [...(root ? [ROOT_HEAD] : []), ...heads.map((head) => head.change_id)],
    value,
    conflict,
    candidates: conflict
      ? [
          ...(root ? [{ changeId: ROOT_HEAD, value: root.value, author: null, hlc: '' }] : []),
          ...heads.map((head) => ({
            changeId: head.change_id,
            value: parse(head.value),
            author: head.author_name,
            hlc: head.hlc,
          })),
        ]
      : [],
  };
}

/** A link exists while one of its heads is a link: a removal takes only the links it saw. */
function linkState(
  entity: string,
  entityId: string,
  changes: readonly LoggedChange[],
  byId: ReadonlyMap<string, LoggedChange>,
  live: ReadonlySet<string>
): EntityState {
  const writes = changes.filter(
    (change) => (change.kind === 'link' || change.kind === 'unlink') && live.has(change.change_id)
  );
  const heads = headsOf(writes, byId, live);
  const links = heads.filter((head) => head.kind === 'link');
  // A link the baseline holds has no link change: with none of its changes live, an unlink that
  // saw no link shows it existed, and carries its values.
  const baseline = heads.length
    ? null
    : (changes.find(
        (change) =>
          change.kind === 'unlink' && !((parse(change.base) as string[] | null) ?? []).length
      ) ?? null);
  const winner = links.length ? links[links.length - 1] : baseline;
  return {
    entity,
    entityId,
    exists: winner !== null,
    create: winner,
    fields: [
      {
        field: '',
        heads: heads.map((head) => head.change_id),
        value: winner ? { json: parse(winner.value) } : { unchanged: true },
        conflict: false,
        candidates: [],
      },
    ],
  };
}

/** The fields a change log may hold for an entity. */
function fieldsOf(entity: string, changes: readonly LoggedChange[]): string[] {
  if (entity === PROJECT_ENTITY)
    return [
      ...new Set(changes.map((change) => change.field).filter((field): field is string => !!field)),
    ];
  return RECORD_COLUMNS[entity as SharedTable].recorded.filter(
    (field) => field !== 'stable_event_id'
  );
}

/** An entity's state from every change the log holds for it, the live ones deciding. */
export function entityState(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  entity: string,
  entityId: string
): EntityState {
  const changes = rows<LoggedChange>(
    client,
    'SELECT * FROM record_changes WHERE entity = ? AND entity_id = ?',
    [entity, entityId]
  );
  const byId = new Map(changes.map((change) => [change.change_id, change]));
  const live = new Set(
    changes
      .filter((change) => txnStanding(client, ctx, change.txn_id).state === 'live')
      .map((change) => change.change_id)
  );
  if (entity !== PROJECT_ENTITY && RECORD_COLUMNS[entity as SharedTable].link)
    return linkState(entity, entityId, changes, byId, live);
  const create = changes.find((change) => change.kind === 'create') ?? null;
  const liveCreate = create && live.has(create.change_id) ? create : null;
  // A row with no create in the log is a baseline row, which every copy holds from its start; one
  // this copy does not hold is not here yet, and a change to it waits rather than makes it. The
  // project identity is always here.
  const baseline = (): boolean =>
    entity === PROJECT_ENTITY ||
    rows(client, `SELECT 1 FROM ${entity} WHERE stable_event_id = ? LIMIT 1`, [entityId]).length >
      0;
  return {
    entity,
    entityId,
    exists: create ? liveCreate !== null : baseline(),
    create: liveCreate,
    fields: fieldsOf(entity, changes).map((field) =>
      plainField(client, entity, entityId, field, changes, byId, live, liveCreate)
    ),
  };
}
