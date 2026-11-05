// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Samples an operation's duration without retrying failed behavior or cleanup.
// ABOUTME: Callers own timing boundaries, assertions and resources for each sample.

export async function fastestOfFive(
  sample: () => number | Promise<number>,
  budgetMs: number
): Promise<number> {
  let fastest = Infinity;
  for (let attempt = 0; attempt < 5 && fastest >= budgetMs; attempt += 1) {
    fastest = Math.min(fastest, await sample());
  }
  return fastest;
}
