// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What `reasonbook import` says of a copy's rows perhaps in the record already, or waiting on a change it has not
// ABOUTME: taken (ADR s96 §9): their lists, and the line that says to keep the copy while archiving it could lose them.

import { oneLine } from './core';
import type { ImportReport } from '../tools/rbook/record-import';

type TableReport = ImportReport['tables'][number];

/** An argument as a shell reads it back: quoted unless it is plainly safe. */
export const quoted = (arg: string): string =>
  /^[\w./:,=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

/** A row perhaps in the record that --include did not bring in. */
const leftOut = (table: TableReport, row: TableReport['perhapsIn'][number]) =>
  !table.own.some((own) => own.id === row.id);

/** The rows perhaps in the record already, and those waiting on a change it has not taken. */
export function waitingLines(all: readonly TableReport[]): string[] {
  const lines: string[] = [];
  const perhaps = all.flatMap((table) =>
    table.perhapsIn.map((row) => {
      const brought = table.own.find((own) => own.id === row.id);
      // Rows that may each be the same record rows: no more of them are in than there are of those.
      const rivals = table.perhapsIn.filter(
        (other) => other !== row && row.as.length > 0 && other.as.join() === row.as.join()
      );
      return `  ${quoted(oneLine(`${table.table}:${row.id}`))}, perhaps ${row.as.length ? `the record's ${row.as.map((id) => oneLine(id)).join(' or ')}` : 'a row a change the record has not taken yet holds'}${rivals.length ? `, as may ${rivals.map((other) => oneLine(`${table.table}:${other.id}`)).join(' or ')}` : ''}${brought ? `, brought in by --include${brought.to !== brought.id ? ` as ${oneLine(brought.to)}` : ''}` : ''}`;
    })
  );
  if (perhaps.length)
    lines.push(
      'Perhaps in the record already, alike but for their citation numbers and made in the same moment as a row of the record or a change it has not taken yet, as an import of another version of this copy would bring one in, so left out (bring one in with --include <table>:<id> if it is new):',
      ...perhaps
    );
  const waiting = all.flatMap((table) =>
    table.waiting.map((id) => `  ${oneLine(`${table.table}:${id}`)}`)
  );
  if (waiting.length)
    lines.push(
      'Brought in by an earlier import that is not live yet, as it waits for a verdict or a change it needs, so not brought in again:',
      ...waiting
    );
  const onCreate = all.flatMap((table) =>
    table.waitingOnCreate.map((id) => `  ${oneLine(`${table.table}:${id}`)}`)
  );
  if (onCreate.length)
    lines.push(
      "Matching a row a change the record has not taken yet holds, which may be this copy's row brought in by an import or another copy's own, so not brought in until that change is taken or refused:",
      ...onCreate
    );
  const heldBack = all.flatMap((table) =>
    table.heldBack.map(
      (row) => `  ${oneLine(`${table.table}:${row.id}`)} names ${oneLine(row.names)}`
    )
  );
  if (heldBack.length)
    lines.push(
      'Waiting with a row they name, which waits on a change the record has not taken, so left out until that change is taken or refused:',
      ...heldBack
    );
  return lines;
}

/** The rows perhaps in the record already that --include did not bring in. */
export const perhapsLeftOut = (table: TableReport): number =>
  table.perhapsIn.filter((row) => leftOut(table, row)).length;

/**
 * The line that says to keep the copy, or null: its rows that wait, and those perhaps a row only a
 * change the record has not taken yet holds, which only this copy holds should that change be refused.
 */
export function keepLine(all: readonly TableReport[]): string | null {
  const total = (count: (table: TableReport) => number) =>
    all.reduce((sum, table) => sum + count(table), 0);
  const imported = total((table) => table.waiting.length);
  const onCreate = total((table) => table.waitingOnCreate.length);
  const held = total((table) => table.heldBack.length);
  const unsure = total(
    (table) => table.perhapsIn.filter((row) => !row.as.length && leftOut(table, row)).length
  );
  const words = [
    imported ? `${imported} of its rows came in with an earlier import that is not live yet` : '',
    onCreate
      ? `${onCreate} ${onCreate === 1 ? 'matches' : 'match'} a change the record has not taken yet`
      : '',
    held ? `${held} more ${held === 1 ? 'waits' : 'wait'} with one of them` : '',
    unsure
      ? `${unsure} ${unsure === 1 ? 'is' : 'are'} perhaps a row a change the record has not taken yet holds`
      : '',
  ]
    .filter(Boolean)
    .join(', and ');
  return words
    ? `Keep this copy: ${words}; archiving it before what they wait on is taken or refused could lose them. Import it again once it is.`
    : null;
}
