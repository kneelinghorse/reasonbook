// SPDX-License-Identifier: Apache-2.0
// ABOUTME: CLI feedback and argument refusals must not echo unbounded user input.
// ABOUTME: The JSON and text paths preserve actionable small failures without opening a project store.

import { runCli } from '../../src/cli';

const huge = 'x'.repeat(100_000);
async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    env: {},
    cwd: '/tmp',
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

it.each(['json', 'text'])(
  'feedback %s refuses oversized content without repeating it',
  async (format) => {
    const result = await run(['feedback', '--content', huge, '--format', format]);
    expect(result.code).toBe(1);
    expect(result.stdout.length + result.stderr.length).toBeLessThan(2000);
    if (format === 'json') {
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        error: { code: 'INVALID_PARAMETER', suggestion: expect.stringContaining('2000') },
      });
    } else {
      expect(result.stderr).toContain('2000');
    }
  }
);

it('unexpected positional arguments preserve the flag remedy without repeating the argument', async () => {
  const result = await run(['init', huge]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('unexpected argument');
  expect(result.stderr).toContain('--');
  expect(result.stdout.length + result.stderr.length).toBeLessThan(2000);
});

it('small feedback validation remains actionable and structurally unchanged', async () => {
  const result = await run(['feedback', '--format', 'json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    success: false,
    error: {
      code: 'INVALID_PARAMETER',
      message: 'Feedback needs content.',
      suggestion: 'Pass --content <text> describing the friction.',
    },
  });
});
