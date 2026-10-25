// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Aggregate local event counts, typed same-session uses, and emitted injection costs for stats.
// ABOUTME: Preserve missing denominators and report observational evidence without claiming hook coverage.

import { toolNameSuffix } from '../../intelligence/legacy-compat';
import type { TelemetryRecord } from './local-telemetry';
import { isCeremonyCommand } from './prompt-patterns';
import { storedTimeMs } from './stored-time';

export interface ProjectEvents {
  readonly target: string;
  readonly records: readonly TelemetryRecord[];
}

export const EVENT_COUNTING_RULES = {
  prompting:
    'Each hook prompt counts once; procedure pattern matches exclude current and former plugin commands. Zero observed matches does not prove complete hook coverage.',
  citeThrough:
    "Distinct (store, harness session, typed id) per successful hook injection surface; a strictly later successful write citation or explicit action in that same store/session counts once. G1 uses prompt injections only, with a provisional 10% floor; a missing denominator is unavailable. Behavioral use without a citation or explicit id action is unmeasured. A bare #N counts as a local decision even when it names another project's row; this inflates the count.",
  unjoinableUses:
    'Successful use records lacking a harness session, split into pid-keyed and other unkeyed records. Each record counts once; each distinct typed id within it counts once in the local item detail. These uses never enter cite-through, even when the item was injected. Export includes only record and distinct (store, typed id) item counts.',
  crossSessionReferences:
    'Successful keyed use records with an id previously injected in the same store only in another harness session. A prior same-session exposure on any surface excludes that id; earlier or simultaneous uses and other stores do not qualify. Each qualifying record and each distinct id within it count once; export retains only record and distinct (store, typed id) item counts. No cite-through credit.',
  repeated:
    'An item injected in at least 2 distinct harness sessions with no later successful use in any of its observed injection sessions.',
  restatement:
    'Prompts with at least one restated rule id per 100 prompts carrying the restatement instrument; failed or absent measurements are excluded and counted separately.',
  cache:
    'Consecutive successful emitted digest injections in each store, ordered by timestamp then file order, can span sessions and UTC days. A pair is comparable only when both hashes exist and no successful mode=write record intervenes; stable means identical hashes. Write-separated and missing-hash pairs are excluded and counted separately. Successful means ok with no refusal or fail-open. This is observed-write stability, not proof of an unchanged store: unobserved writes, draft expiry and time text can change a digest with no observed write.',
  injection:
    'Actual emitted post-cap characters; each record with positive charsInjected is one injection. Per-injection mean is characters / injections. All-session mean sums keyed characters / distinct (store, harness session); pid or missing keys contribute unkeyedCharacters. Digest costs additionally separate compact, startup/resume/clear, and unknown legacy source. Non-compact-session mean sums only startup/resume/clear digest characters with a harness key / distinct (store, harness session) receiving those injections; repeated resume/clear injections accumulate. Compact, unknown-source and prompt costs are excluded from that numerator and denominator. Unkeyed non-compact characters are reported separately. A zero denominator is unavailable.',
  safety:
    'One record per invocation; failOpens count non-null causes, deadlineMisses are their deadline subset, refusals count non-null refusal codes.',
  comparison:
    'On versus digest-off groups are observational; the scheduled comparison waits until after the G1 read.',
} as const;

type Surface = 'digest' | 'prompt' | 'other';
const surfaceOf = (r: TelemetryRecord): Surface =>
  r.tool === 'hook session-start' ? 'digest' : r.tool === 'hook prompt' ? 'prompt' : 'other';
const sessionOf = (r: TelemetryRecord): string | null => {
  const session = r.session?.replace(/^ext:/, '');
  return session && /^[a-f0-9]{16}$/.test(session) ? session : null;
};
const ids = (values: readonly string[] | undefined): string[] =>
  (values ?? []).filter((id) => /^[dlcn]:[1-9]\d*$/.test(id));
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

interface Exposure {
  target: string;
  session: string;
  id: string;
  time: number;
  surface: Surface;
}

interface Use {
  target: string;
  session: string | null;
  pidKeyed: boolean;
  ids: string[];
  time: number;
}

function useSummary(uses: readonly Use[]) {
  const items = new Map<string, { target: string; id: string; records: number }>();
  for (const use of uses)
    for (const id of use.ids) {
      const key = `${use.target}\0${id}`;
      const item = items.get(key) ?? { target: use.target, id, records: 0 };
      item.records++;
      items.set(key, item);
    }
  return { records: uses.length, items: [...items.values()] };
}

/** No text parsing here: the writers have already supplied typed ids and instrument results. */
export function eventStatistics(projects: readonly ProjectEvents[]) {
  const all = projects
    .flatMap(({ target, records }) => records.map((record) => ({ target, record })))
    .sort((a, b) => storedTimeMs(a.record.ts) - storedTimeMs(b.record.ts));
  const prompts = all.filter(
    ({ record }) => record.surface === 'hook' && record.tool === 'hook prompt'
  );
  const measuredPrompts = prompts.filter(({ record }) => Array.isArray(record.procedurePatternIds));
  const restatementPrompts = prompts.filter(
    ({ record }) => Array.isArray(record.restatedRuleIds) && !record.ruleReadFailed
  );
  const restatedPrompts = restatementPrompts.filter(
    ({ record }) => record.restatedRuleIds!.length > 0
  ).length;
  const exposures = new Map<string, Exposure>();
  const uses = new Map<string, number[]>();
  const useRecords: Use[] = [];
  const itemSessions = new Map<
    string,
    { target: string; id: string; sessions: Set<string>; used: boolean }
  >();
  const previousDigests = new Map<string, { hash?: string; written: boolean }>();
  let stableDigestPairs = 0;
  let comparableDigestPairs = 0;
  let writeSeparatedDigestPairs = 0;
  let missingHashDigestPairs = 0;
  const characterSessions = new Map<string, number>();
  const nonCompactSessions = new Set<string>();
  const digestCosts = {
    characters: 0,
    injections: 0,
    nonCompactCharacters: 0,
    nonCompactInjections: 0,
    unkeyedNonCompactCharacters: 0,
    compactCharacters: 0,
    compactInjections: 0,
    unknownSourceCharacters: 0,
    unknownSourceInjections: 0,
  };
  const charactersBySurface = { digest: 0, prompt: 0, other: 0 };
  let characters = 0;
  let injections = 0;
  let unkeyedCharacters = 0;
  let unkeyedInjectedItems = 0;
  for (const { target, record: r } of all) {
    const time = storedTimeMs(r.ts);
    const session = sessionOf(r);
    const surface = surfaceOf(r);
    const successful = r.ok && !r.refused && !r.failOpen;
    const cost = Math.max(0, r.charsInjected ?? 0);
    characters += cost;
    charactersBySurface[surface] += cost;
    if (cost > 0) injections++;
    if (cost > 0 && session) {
      const key = `${target}\0${session}`;
      characterSessions.set(key, (characterSessions.get(key) ?? 0) + cost);
    } else if (cost > 0) unkeyedCharacters += cost;
    if (cost > 0 && surface === 'digest') {
      digestCosts.characters += cost;
      digestCosts.injections++;
      if (r.source === 'compact') {
        digestCosts.compactInjections++;
        digestCosts.compactCharacters += cost;
      } else if (r.source && ['startup', 'resume', 'clear'].includes(r.source)) {
        digestCosts.nonCompactInjections++;
        if (session) {
          digestCosts.nonCompactCharacters += cost;
          nonCompactSessions.add(`${target}\0${session}`);
        } else digestCosts.unkeyedNonCompactCharacters += cost;
      } else {
        digestCosts.unknownSourceInjections++;
        digestCosts.unknownSourceCharacters += cost;
      }
    }
    const previous = previousDigests.get(target);
    if (successful && r.mode === 'write' && previous) previous.written = true;
    if (successful && surface === 'digest' && cost > 0) {
      if (previous) {
        if (previous.written) writeSeparatedDigestPairs++;
        else if (!previous.hash || !r.digestHash) missingHashDigestPairs++;
        else {
          comparableDigestPairs++;
          if (previous.hash === r.digestHash) stableDigestPairs++;
        }
      }
      previousDigests.set(target, { hash: r.digestHash, written: false });
    }
    if (successful) {
      const shown =
        r.action === 'show' && ['decisions', 'learnings'].includes(toolNameSuffix(r.tool) ?? '')
          ? ids(r.idsReturned)
          : [];
      const cited = r.mode === 'write' ? ids(r.idsCited) : [];
      const used = [...new Set([...shown, ...cited])];
      if (used.length)
        useRecords.push({
          target,
          session,
          pidKeyed: Boolean(r.session?.startsWith('pid:')),
          ids: used,
          time,
        });
      if (session)
        for (const id of used) {
          const key = `${target}\0${session}\0${id}`;
          const times = uses.get(key) ?? [];
          times.push(time);
          uses.set(key, times);
        }
    }
    if (!session) {
      unkeyedInjectedItems += ids(r.idsInjected).length;
      continue;
    }
    if (successful && r.surface === 'hook') {
      for (const id of ids(r.idsInjected)) {
        const key = `${target}\0${session}\0${id}\0${surface}`;
        const before = exposures.get(key);
        if (!before || time < before.time)
          exposures.set(key, { target, session, id, time, surface });
        const itemKey = `${target}\0${id}`;
        const item = itemSessions.get(itemKey) ?? {
          target,
          id,
          sessions: new Set<string>(),
          used: false,
        };
        item.sessions.add(session);
        itemSessions.set(itemKey, item);
      }
    }
  }
  const totals = {
    digest: { injected: 0, used: 0 },
    prompt: { injected: 0, used: 0 },
    other: { injected: 0, used: 0 },
  };
  for (const e of exposures.values()) {
    totals[e.surface].injected++;
    if ((uses.get(`${e.target}\0${e.session}\0${e.id}`) ?? []).some((time) => time > e.time)) {
      totals[e.surface].used++;
      itemSessions.get(`${e.target}\0${e.id}`)!.used = true;
    }
  }
  const rate = (surface: Surface) => ({
    ...totals[surface],
    ratio: ratio(totals[surface].used, totals[surface].injected),
  });
  const unjoinable = useRecords.filter((use) => !use.session);
  const crossSession = useRecords
    .filter((use) => use.session)
    .map((use) => ({
      ...use,
      ids: use.ids.filter((id) => {
        const prior = [...exposures.values()].filter(
          (e) => e.target === use.target && e.id === id && e.time < use.time
        );
        return (
          prior.some((e) => e.session !== use.session) &&
          !prior.some((e) => e.session === use.session)
        );
      }),
    }))
    .filter((use) => use.ids.length > 0);
  const comparison = (ambient: 'on' | 'digest-off') => {
    const records = prompts.filter(({ record }) => record.ambient === ambient);
    const measured = records.filter(
      ({ record }) => Array.isArray(record.restatedRuleIds) && !record.ruleReadFailed
    );
    const restated = measured.filter(({ record }) => record.restatedRuleIds!.length > 0).length;
    return {
      prompts: records.length,
      measuredPrompts: measured.length,
      restatedPrompts: restated,
      restatementRatio: ratio(restated, measured.length),
    };
  };
  return {
    records: all.length,
    prompting: {
      status: measuredPrompts.length > 0 ? ('observed' as const) : ('unavailable' as const),
      prompts: prompts.length,
      measuredPrompts: measuredPrompts.length,
      unmeasuredPrompts: prompts.length - measuredPrompts.length,
      prompted: measuredPrompts.filter(
        ({ record }) =>
          record.procedurePatternIds!.length > 0 && !isCeremonyCommand(record.ceremony ?? null)
      ).length,
      pluginCeremonies: prompts.filter(({ record }) => isCeremonyCommand(record.ceremony ?? null))
        .length,
      sentenceCeremonies: prompts.filter(({ record }) => /^C\d+$/.test(record.ceremony ?? ''))
        .length,
    },
    citeThrough: {
      digest: rate('digest'),
      prompt: rate('prompt'),
      other: rate('other'),
      unkeyedInjectedItems,
    },
    unjoinableUses: {
      ...useSummary(unjoinable),
      pidKeyedRecords: unjoinable.filter((use) => use.pidKeyed).length,
      otherUnkeyedRecords: unjoinable.filter((use) => !use.pidKeyed).length,
    },
    crossSessionReferences: useSummary(crossSession),
    repeatedNeverCited: {
      minimumSessions: 2,
      items: [...itemSessions.values()]
        .filter((item) => item.sessions.size >= 2 && !item.used)
        .map((item) => ({ target: item.target, id: item.id, sessions: item.sessions.size })),
    },
    restatement: {
      measuredPrompts: restatementPrompts.length,
      restatedPrompts,
      unmeasuredPrompts: prompts.length - restatementPrompts.length,
      per100: restatementPrompts.length
        ? (100 * restatedPrompts) / restatementPrompts.length
        : null,
    },
    injection: {
      characters,
      injections,
      meanCharactersPerInjection: ratio(characters, injections),
      sessions: characterSessions.size,
      meanCharactersPerSession: ratio(characters - unkeyedCharacters, characterSessions.size),
      unkeyedCharacters,
      charactersBySurface,
      digest: {
        ...digestCosts,
        meanCharactersPerInjection: ratio(digestCosts.characters, digestCosts.injections),
        nonCompactSessions: nonCompactSessions.size,
        meanCharactersPerNonCompactSession: ratio(
          digestCosts.nonCompactCharacters,
          nonCompactSessions.size
        ),
      },
      stableDigestPairs,
      comparableDigestPairs,
      writeSeparatedDigestPairs,
      missingHashDigestPairs,
      stableDigestRatio: ratio(stableDigestPairs, comparableDigestPairs),
    },
    injectionSessions: [...characterSessions].map(([key, chars]) => {
      const [target, session] = key.split('\0');
      return { target, session, characters: chars };
    }),
    digestOff: {
      status: 'deferred-observational' as const,
      on: comparison('on'),
      off: comparison('digest-off'),
    },
    safety: {
      deadlineMisses: all.filter(({ record }) => record.failOpen === 'deadline').length,
      failOpens: all.filter(({ record }) => Boolean(record.failOpen)).length,
      refusals: all.filter(({ record }) => Boolean(record.refused)).length,
      failedCalls: all.filter(({ record }) => !record.ok).length,
    },
  };
}
