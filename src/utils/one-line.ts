// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Bounds one displayed value and removes terminal controls without changing stored data.
// ABOUTME: Pure text only, shared by the CLI and the independently packaged signals renderer.

/** One bounded line: fold whitespace, then strip remaining C0/C1 controls, including DEL. */
export function oneLine(text: string, max = 300): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
