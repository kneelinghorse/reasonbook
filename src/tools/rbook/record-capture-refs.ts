// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A session capture names its mission and sprint by local id; the log keeps them as stable ids (s96-m12), so a
// ABOUTME: renamed mission or a peer's id never changes what a capture names. Pure: callers pass the id lookups.

/** The keys of a capture element that name a row, and the table each names. */
export const CAPTURE_REFERENCES: Readonly<Record<string, 'missions' | 'sprints'>> = {
  missionId: 'missions',
  sprintId: 'sprints',
};

export type StableOf = (table: 'missions' | 'sprints', id: string) => string | null;
export type IdOf = (table: 'missions' | 'sprints', stable: string) => string | null;

/** A row a capture names that this copy has not written yet. */
export class CaptureRowMissing extends Error {}

/** One capture element with each row it names as `{ref}`, or `{unresolved}` when no row has that id. */
export function encodeCaptureElement(item: unknown, stableOf: StableOf): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const encoded: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const [key, table] of Object.entries(CAPTURE_REFERENCES))
    if (typeof encoded[key] === 'string') {
      const stable = stableOf(table, encoded[key] as string);
      encoded[key] = stable ? { ref: stable } : { unresolved: encoded[key] };
    }
  return encoded;
}

/** One logged capture element with each `{ref}` back as this copy's id. */
export function decodeCaptureElement(item: unknown, idOf: IdOf): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const decoded: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const [key, table] of Object.entries(CAPTURE_REFERENCES)) {
    const value = decoded[key];
    if (!value || typeof value !== 'object') continue;
    if ('unresolved' in value) decoded[key] = (value as { unresolved: unknown }).unresolved;
    else if ('ref' in value) {
      const id = idOf(table, (value as { ref: string }).ref);
      if (id === null)
        throw new CaptureRowMissing(
          `a capture names ${(value as { ref: string }).ref}, not here yet`
        );
      decoded[key] = id;
    }
  }
  return decoded;
}

const parseArray = (text: unknown): unknown[] | null => {
  if (typeof text !== 'string' || !text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** A whole captures column, its elements encoded; text that is not an array is kept as it is. */
export function encodeCaptures(text: unknown, stableOf: StableOf): unknown {
  const items = parseArray(text);
  return items ? JSON.stringify(items.map((item) => encodeCaptureElement(item, stableOf))) : text;
}

/** A whole logged captures column, its elements decoded. */
export function decodeCaptures(text: unknown, idOf: IdOf): unknown {
  const items = parseArray(text);
  return items ? JSON.stringify(items.map((item) => decodeCaptureElement(item, idOf))) : text;
}
