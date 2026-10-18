// SPDX-License-Identifier: Apache-2.0
// ABOUTME: `reasonbook import` (ADR s96 §9): bring a copy made before sharing into this copy of the shared record, a dry run
// ABOUTME: first that classifies every row, and with --apply this copy's own writes; the copy's folder is only read.

import * as path from 'path';
import { parseArgs, resolveCliProject, type CliIo } from './core';
import { canonicalJson } from '../tools/rbook/record-capture';
import { importCopy, type ImportReport } from '../tools/rbook/record-import';
import type { FieldChange } from '../tools/rbook/record-import-plan';
import { answered, storeOpener } from '../tools/rbook/record-sync';
import { keepLine, perhapsLeftOut, quoted, waitingLines } from './import-waits';

const USAGE =
  'reasonbook import --from <folder> [--apply] [--include <table>:<id>,...] [--project-root <root>]: bring in a copy made before sharing, a dry run unless --apply.';

const shown = (value: unknown): string => {
  const text = JSON.stringify(value ?? null);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** A list of fields; `writes` for the lists applying writes, which say what it writes when that is not the copy's. */
function fieldLines(heading: string, fields: readonly FieldChange[], writes = false): string[] {
  if (!fields.length) return [];
  return [
    heading,
    ...fields.map(
      (field) =>
        `  ${field.table} ${field.id} ${field.field}: the copy holds ${shown(field.copy)}, the record ${shown(field.owner)}${!writes || canonicalJson(field.write ?? null) === canonicalJson(field.copy ?? null) ? '' : `; applying writes ${shown(field.write)}`}${field.afterMarker ? "; the copy's row carries a time after the marker, so this may be its own change" : ''}`
    ),
  ];
}

/** A link's row, named by its pair. */
const RECORD_LINK = /^(mission_dependencies|session_missions):/;

/** The links a table leaves out, each once though both its ends name a row left out. */
const linksLeftOut = (table: ImportReport['tables'][number]): number =>
  new Set(
    table.leftOut
      .filter((entry) => entry.brought && RECORD_LINK.test(entry.row))
      .map((entry) => entry.row)
  ).size;

/** A matched row's fields naming a row left out: the record keeps its own value there. */
const keptForReference = (table: ImportReport['tables'][number]): number =>
  table.leftOut.filter((entry) => !entry.brought && !entry.waits && !entry.cites).length;

/** The rules a field's kind decides by: with a base, a flag follows it where it tells. */
const KINDS =
  "the field's kind decides: appended text keeps what each side added, the later review time and an added flag win, and an author the copy never recorded is no other author";
const KINDS_BASED =
  "the field's kind decides: appended text keeps what each side added, the later review time wins, an added flag wins where the base cannot tell, and an author the copy never recorded is no other author";

/** What the base, or its absence, decided, and the fields the record's own log decided. */
function baseLines(report: ImportReport): string[] {
  const held = report.tables.reduce((sum, table) => sum + table.heldBefore, 0);
  const unbased = report.tables
    .flatMap((table) => table.conflicts)
    .filter((field) => !field.based).length;
  return [
    report.base
      ? `Base: ${path.basename(report.base)}, which both folders hold: a field only one side changed since takes that side's value and one both changed is raised, unless the record's own history shows it changed the field after holding the copy's value, or ${KINDS_BASED}.${unbased ? ` ${unbased} raised field(s) are on rows or columns the base does not hold, so they are raised as with no base.` : ''}`
      : `Base: none that both folders hold, so a field the two hold differently is raised, unless the record's own history shows it changed the field after holding the copy's value, or ${KINDS}.`,
    ...(held
      ? [
          `${held} field(s) the record has held as the copy holds them since sharing, and changed since, keep the record's value.`,
        ]
      : []),
  ];
}

/**
 * What the dry run found, and what was written when it was applied. `again` is the command that
 * applies it, as the person ran the dry run.
 */
export function importText(report: ImportReport, again?: string): string {
  const lines = [
    `${report.applied ? 'Imported' : 'Dry run of the import of'} ${report.from} (its store ${path.relative(report.from, report.store) || path.basename(report.store)}).`,
    ...baseLines(report),
    report.marker
      ? `Marker: context snapshot ${report.marker.id} (${report.marker.createdAt}); a row only the copy holds, dated at or before it, was deleted on the owner, as was one the record's log shows it removed.`
      : "Marker: none, so a row only the copy holds reads as its own, unless the record's log shows it removed it.",
  ];
  for (const table of report.tables) {
    const count = (n: number, words: string) => (n ? `${n} ${words}` : '');
    const parts = [
      `${table.identical} as the record holds`,
      count(table.copyChanged.length, 'field(s) applying sets with no conflict'),
      count(table.conflicts.length, 'field(s) raised'),
      count(table.ownerChanged, "field(s) where the record's value stands"),
      count(table.heldBefore, "field(s) the record changed after holding the copy's value"),
      count(table.alreadyRaised.length, 'field(s) an earlier import raised, still in conflict'),
      count(table.inConflict.length, 'field(s) already in conflict in the record'),
      count(
        table.flagKept.length,
        'flag(s) set in the record and clear in the copy, kept as the record holds them'
      ),
      count(table.linkDiffers.length, 'field(s) of matched links held differently'),
      count(
        table.leftOut.filter((entry) => !entry.brought && !entry.cites).length,
        'field(s) naming a row left out or waiting, kept as the record holds them'
      ),
      count(table.own.length, 'of its own'),
      count(
        table.deletedOnOwner.filter((row) => !table.heldBack.some((held) => held.id === row.id))
          .length,
        'deleted on the owner'
      ),
      count(table.waiting.length, 'waiting on an earlier import'),
      count(table.waitingOnCreate.length, 'waiting on a change the record has not taken'),
      count(table.heldBack.length, 'waiting with a row they name'),
      count(table.perhapsIn.length, 'perhaps in the record already'),
      count(linksLeftOut(table), 'left out, naming a row the record will not hold'),
      count(table.ownerOnly, 'only in the record, kept'),
    ].filter(Boolean);
    lines.push(
      table.absent
        ? `${table.table}: the copy has no such table; the record's ${table.targetRows} stay as they are.`
        : `${table.table}: ${table.copyRows} in the copy: ${parts.join('; ')}.${table.lacked.length ? ` Taken from the record, which the copy never had: ${table.lacked.join(', ')}.` : ''}`
    );
  }
  const all = report.tables;
  lines.push(
    ...fieldLines(
      "Applying raises these as conflicts; reads keep the record's value until each is settled:",
      all.flatMap((table) => table.conflicts),
      true
    )
  );
  lines.push(
    ...fieldLines(
      'Applying sets these, with no conflict:',
      all.flatMap((table) => table.copyChanged),
      true
    )
  );
  lines.push(
    ...fieldLines(
      'An earlier import raised these, still in conflict: settle each with rbook_db(action="settle"):',
      all.flatMap((table) => table.alreadyRaised)
    )
  );
  lines.push(
    ...fieldLines(
      'Already in conflict in the record, so left alone: settle each, then import again:',
      all.flatMap((table) => table.inConflict)
    )
  );
  lines.push(
    ...fieldLines(
      'Flags set in the record and clear in the copy; nothing shows which side changed them, and an added flag wins, so the record keeps its own:',
      all.flatMap((table) => table.flagKept)
    )
  );
  lines.push(
    ...fieldLines(
      'Matched links held differently; a link merges whole, so the record keeps its own:',
      all.flatMap((table) => table.linkDiffers)
    )
  );
  const leftOut = all.flatMap((table) =>
    table.leftOut
      .filter((entry) => !entry.waits)
      .map((entry) =>
        entry.cites
          ? `  ${entry.row} ${entry.column} cites ${entry.names}, which the import leaves out: the citation keeps the number the copy wrote, which in the record names another row or none`
          : `  ${entry.row} ${entry.column} names ${entry.names}: ${entry.brought ? (RECORD_LINK.test(entry.row) ? 'the link is left out' : 'brought in without it') : 'the record keeps its own value'}${entry.afterMarker ? "; the copy's row carries a time after the marker, so this may be its own change" : ''}`
      )
  );
  if (leftOut.length)
    lines.push(
      'Naming a row the record will not hold (bring one deleted on the owner or perhaps in the record already in with --include):',
      ...leftOut
    );
  const waitingRefs = all.flatMap((table) =>
    table.leftOut
      .filter((entry) => entry.waits)
      .map((entry) => `  ${entry.row} ${entry.column} names ${entry.names}`)
  );
  if (waitingRefs.length)
    lines.push(
      'Naming a row that waits on a change the record has not taken, so the record keeps its own value until that change is taken or refused:',
      ...waitingRefs
    );
  const deleted = all.flatMap((table) =>
    table.deletedOnOwner.map(
      (row) =>
        `  ${quoted(`${table.table}:${row.id}`)}${row.at ? ` (${row.at})` : ''}${row.to ? `, brought in by --include${row.to !== row.id ? ` as ${row.to}` : ''}` : table.heldBack.some((held) => held.id === row.id) ? ', named by --include, and waiting with a row it names (below)' : ''}`
    )
  );
  if (deleted.length)
    lines.push(
      'Deleted on the owner, so left out (bring one in with --include <table>:<id>):',
      ...deleted
    );
  const own = all.flatMap((table) =>
    table.own.map(
      (row) =>
        `  ${table.table}:${row.id}${row.to !== row.id ? ` as ${row.to}` : ''}${row.at ? '' : '; undated, so it may be a row the owner deleted'}`
    )
  );
  if (own.length) lines.push('Its own rows:', ...own);
  lines.push(...waitingLines(all));
  if (report.alreadyIn.length)
    lines.push(
      `--include names ${report.alreadyIn.join(', ')}, which the record already holds, so it brings in nothing for them.`
    );
  const twice = all.flatMap((table) =>
    table.broughtTwice.map((entry) => `  ${table.table} ${entry}`)
  );
  if (twice.length)
    lines.push(
      'Brought in twice, by two copies before they synced; a shared record keeps every row, so give one of each a closed status if it should not be read:',
      ...twice
    );
  const keep = keepLine(all);
  if (report.applied) {
    const renamed = Object.entries(report.applied.renamed).map(([from, to]) => `${from} as ${to}`);
    lines.push(
      `Applied: ${report.applied.created} row(s) created, ${report.applied.set} field(s) set, and ${report.applied.conflicts} raised as conflicts.${report.applied.conflicts ? ' Reads keep the record\'s value until each is settled with rbook_db(action="settle").' : ''}`,
      ...(renamed.length ? [`Renumbered: ${renamed.join(', ')}.`] : []),
      ...(keep ? [keep] : [])
    );
    return lines.join('\n');
  }
  const command = again ?? `reasonbook import --from ${quoted(report.store)} --apply`;
  const total = (fields: (table: (typeof all)[number]) => number) =>
    all.reduce((sum, table) => sum + fields(table), 0);
  const sets = total((table) => table.copyChanged.length);
  const raises = total((table) => table.conflicts.length);
  const kept = total(
    (table) =>
      table.inConflict.length +
      table.flagKept.length +
      table.linkDiffers.length +
      keptForReference(table)
  );
  const raisedBefore = total((table) => table.alreadyRaised.length);
  const recordStands = total((table) => table.ownerChanged + table.heldBefore);
  // Rows the copy holds that the record will not: deleted on the owner, perhaps in it, or links naming one.
  const leftBehind = total(
    (table) =>
      table.deletedOnOwner.filter((row) => !row.to).length +
      perhapsLeftOut(table) +
      linksLeftOut(table)
  );
  const fresh =
    "archive it and join a fresh copy (reasonbook copy on the owner's machine, then reasonbook join)";
  const stayOut = leftBehind
    ? `the ${leftBehind} row(s) left out above stay out, but for any --include brings in`
    : '';
  if (report.ownRows || report.includedRows)
    lines.push(
      `This copy holds ${report.ownRows} row(s) of its own${report.includedRows ? `, and --include brings in ${report.includedRows} deleted on the owner` : ''}: bring them in with ${command}.${keep ? ` ${keep}` : ''}`
    );
  else if (keep) lines.push(keep);
  else if (report.differing)
    lines.push(
      `This copy holds no row of its own: ${fresh}. Archiving drops the ${report.differing} field(s) listed above${report.flagged ? `; ${report.flagged} are on rows carrying a time after the marker, so they may be the copy's own changes` : ''}${leftBehind ? `, and ${stayOut}` : ''}.${
        sets + raises
          ? ` Applying instead (${command}) sets ${sets} and raises ${raises} for you to settle${kept ? `, and leaves ${kept} as the record holds them` : ''}.`
          : ` Applying would leave all ${kept} as the record holds them.`
      }${raisedBefore ? ` The ${raisedBefore} field(s) an earlier import raised are still in conflict: settle each with rbook_db(action="settle") first.` : ''}`
    );
  else if (raisedBefore)
    lines.push(
      `This copy holds no row of its own, and an earlier import raised every field it holds differently that the record has not changed since${leftBehind ? `; ${stayOut}` : ''}: ${fresh}, once the ${raisedBefore} field(s) still in conflict are settled with rbook_db(action="settle").`
    );
  else if (recordStands)
    lines.push(
      `This copy holds no row of its own, and the record's value stands for every field the two hold differently${leftBehind ? `; ${stayOut}` : ', so nothing needs bringing in'}: ${fresh}.`
    );
  else if (leftBehind)
    lines.push(
      `This copy holds no row of its own and nothing the record holds differently; ${stayOut}: ${fresh}.`
    );
  else
    lines.push(
      `This copy holds nothing the record does not hold, so nothing needs bringing in: ${fresh}.`
    );
  return lines.join('\n');
}

export async function runImport(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  // A flag given no value reads as "true", which is no folder.
  if (!flags['from'] || flags['from'] === 'true') {
    io.stderr(USAGE);
    return 1;
  }
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (resolution.kind !== 'store') {
    io.stderr('reasonbook import: no Reasonbook store found here; pass --project-root <root>.');
    return 1;
  }
  // Every --include, each a list: a repeated flag adds to the rows named, never replaces them.
  const include = argv
    .flatMap((arg, index) =>
      arg === '--include'
        ? [argv[index + 1] ?? '']
        : arg.startsWith('--include=')
          ? [arg.slice('--include='.length)]
          : []
    )
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const from = path.resolve(io.cwd, flags['from']);
  const result = await answered(
    storeOpener(resolution.dbPath)((client) =>
      importCopy(client, from, {
        apply: flags['apply'] === 'true',
        include,
      })
    )
  );
  if (result.success && result.data) {
    const again = [
      'reasonbook import --from',
      quoted(from),
      ...(include.length ? ['--include', quoted(include.join(','))] : []),
      ...(flags['project-root']
        ? ['--project-root', quoted(path.resolve(io.cwd, flags['project-root']))]
        : []),
      '--apply',
    ].join(' ');
    io.stdout(`${importText(result.data, again)}\n`);
    for (const warning of result.warnings ?? []) io.stderr(`Note: ${warning}`);
    return 0;
  }
  const message = result.error?.message ?? 'The import failed.';
  io.stderr(
    `${message}${/[.!?]$/.test(message) ? '' : '.'}${result.error?.suggestion ? ` ${result.error.suggestion}` : ''}`
  );
  return 1;
}
