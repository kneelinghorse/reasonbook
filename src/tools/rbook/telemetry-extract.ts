// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Extracts typed record IDs from known Reasonbook response shapes and explicit citations/actions.
// ABOUTME: Never treats mission/feedback IDs or unsuccessful requested writes as use of a record.

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const unique = (ids: string[]): string[] => [...new Set(ids)].slice(0, 100);

function typed(prefix: string, value: unknown): string[] {
  const id = typeof value === 'number' ? value : NaN;
  return Number.isSafeInteger(id) && id > 0 ? [`${prefix}:${id}`] : [];
}

const foreign = (row: ObjectValue, local: unknown): boolean =>
  row.projectId != null && row.projectId !== local;

/** Only known record arrays; a generic recursive `id` walk would label unrelated rows. */
export function returnedIds(tool: string, args: unknown, value: unknown): string[] {
  const data = object(value);
  const action = object(args).action;
  const ids: string[] = [];
  const add = (prefix: string, rows: unknown): void => {
    for (const value of list(rows)) {
      const row = object(value);
      // Pulled foreign records keep their own namespace; local typed IDs cannot identify them.
      if (foreign(row, data.localProjectId)) continue;
      ids.push(...typed(prefix, row.id));
    }
  };
  if (tool === 'rbook_decisions' || tool === 'rbook_learnings') {
    const prefix = tool === 'rbook_decisions' ? 'd' : 'l';
    if (action === 'show' && !foreign(data, data.localProjectId))
      ids.push(...typed(prefix, data.id));
    add('d', data.decisions);
    add('l', data.learnings);
    add(prefix, data.results ?? data.items);
  }
  if (tool === 'rbook_review' || tool === 'rbook_agent_onboard') {
    add('d', data.recentDecisions);
    add('l', data.recentLearnings);
  }
  if (tool === 'rbook_mission_transition') add('d', data.relevantDecisions);
  if (tool === 'rbook_context') {
    if (action === 'next_steps') add('n', data.items);
    if (action === 'constraints') add('c', data.items ?? data.constraints ?? data.reviewItems);
    if (action === 'search') {
      for (const value of list(data.results)) {
        const hit = object(value);
        const prefix = hit.type === 'decision' ? 'd' : hit.type === 'learning' ? 'l' : null;
        if (prefix && !foreign(hit, data.localProjectId)) ids.push(...typed(prefix, hit.id));
      }
    }
  }
  if (tool === 'rbook_decisions' || tool === 'rbook_session' || tool === 'rbook_learnings') {
    ids.push(...typed('d', data.decisionId), ...typed('l', data.learningId));
  }
  // s100-m03: a next-step capture returns its row's id.
  if (tool === 'rbook_session') ids.push(...typed('n', data.nextStepId));
  return unique(ids);
}

/** Explicit relation fields and record-bearing prose only; queries and paths are never citations. */
export function citedIds(args: unknown): string[] {
  const params = object(args);
  const ids = [
    ...list(params.supersedes).flatMap((id) => typed('d', id)),
    ...list(params.citesLearningIds).flatMap((id) => typed('l', id)),
  ];
  const text = [
    params.content,
    params.notes,
    params.summary,
    params.reason,
    params.resolution,
    ...list(params.decisions),
  ]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  // One pass preserves prose order. Bare #N always means a decision, never both namespaces.
  const pattern =
    /\b([dlcn]):([1-9]\d*)\b|(?:(learning|constraint|next[ -]step|decision)s?\s*)?#([1-9]\d*)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const label = match[3]?.toLowerCase();
    const prefix =
      match[1]?.toLowerCase() ??
      (label === 'learning'
        ? 'l'
        : label === 'constraint'
          ? 'c'
          : label?.startsWith('next')
            ? 'n'
            : 'd');
    ids.push(...typed(prefix, Number(match[2] ?? match[4])));
  }
  return unique(ids);
}

/** G1 uses: successful citations in writes, or successful explicit actions on typed IDs. */
export function usedIds(
  tool: string,
  args: unknown,
  mode: string | null,
  result: unknown
): string[] {
  const envelope = object(result);
  const data = object(envelope.data);
  if (envelope.success !== true || list(data.writeFailures).length > 0) return [];
  const params = object(args);
  const action = params.action;
  // The security taxonomy deliberately calls some reviews writes; that classification is not
  // evidence that a row changed. Count record-bearing actions and receipt-confirmed IDs only.
  const proseWrite =
    mode === 'write' &&
    ((tool === 'rbook_decisions' && action === 'record') ||
      (tool === 'rbook_session' && ['capture', 'complete'].includes(String(action))) ||
      (tool === 'rbook_mission_transition' &&
        ['start', 'complete', 'block', 'unblock', 'drop', 'defer'].includes(String(action))) ||
      (tool === 'rbook_mission' && ['add', 'update'].includes(String(action))));
  const ids = proseWrite ? citedIds(params) : [];
  if (action === 'show' && !foreign(data, data.localProjectId)) {
    if (tool === 'rbook_decisions') ids.push(...typed('d', data.id));
    if (tool === 'rbook_learnings') ids.push(...typed('l', data.id));
  }
  if (tool === 'rbook_decisions' && action === 'update') ids.push(...typed('d', data.decisionId));
  if (tool === 'rbook_learnings' && ['update', 'reaffirm'].includes(String(action))) {
    ids.push(...typed('l', data.learningId));
  }
  const changed = (
    prefix: string,
    requested: unknown,
    excluded: unknown[],
    affected: unknown
  ): void => {
    const candidates = [...new Set(list(requested))].filter((id) => !excluded.includes(id));
    // Some legacy receipts give only a count. Do not invent which IDs changed on a partial match.
    if (affected === candidates.length) ids.push(...candidates.flatMap((id) => typed(prefix, id)));
  };
  if (tool === 'rbook_decisions' && action === 'batch_update') {
    changed(
      'd',
      params.decisionIds,
      [
        ...list(data.notFound),
        ...list(data.alreadyInStatus),
        ...list(data.failed),
        ...list(data.lookupFailed),
      ],
      data.updated
    );
  }
  if (
    tool === 'rbook_context' &&
    action === 'next_steps' &&
    ['complete', 'carry', 'drop', 'reopen'].includes(String(params.nextStepAction))
  ) {
    changed('n', params.nextStepIds, list(data.unmatchedIds), data.affected);
  }
  if (tool === 'rbook_context' && action === 'constraints') {
    if (params.constraintAction === 'reaffirm' && data.affected === 1)
      ids.push(...typed('c', data.constraintId));
    if (params.constraintAction === 'archive')
      changed('c', params.constraintIds, [], data.affected);
  }
  return unique(ids);
}
