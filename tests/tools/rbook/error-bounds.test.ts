// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Refusal budgets apply to serialized fields, including escaped strings and non-string values.
// ABOUTME: Small diagnostics retain their types and success answers never enter the refusal bound.

import { boundErrorFields, boundErrorValue } from '../../../src/tools/rbook/error-bounds';
import type { RbookToolError } from '../../../src/tools/rbook/types';

const fields = [
  'message',
  'suggestion',
  'field',
  'providedValue',
  'currentState',
  'validValues',
] as const;

describe('caller-input refusal bounds', () => {
  test.each([511, 512, 513])(
    'preserves ordinary diagnostics through the %i-character JSON boundary',
    (size) => {
      const values = [
        'x'.repeat(size - 2),
        '\u0000'.repeat(60) + 'x'.repeat(size - 362),
        { value: 'x'.repeat(size - JSON.stringify({ value: '' }).length) },
        ['x'.repeat(size - JSON.stringify(['']).length)],
      ];
      for (const field of fields) {
        for (const value of values) {
          expect(JSON.stringify(value)).toHaveLength(size);
          const original = {
            success: false,
            error: {
              code: 'INVALID_PARAMETER',
              message: 'Bad value',
              [field]: value,
            } as RbookToolError,
          };
          const result = boundErrorFields(original);
          if (size <= 512) expect(result.error![field]).toBe(value);
          else {
            expect(JSON.stringify(result.error![field]).length).toBeLessThanOrEqual(160);
            expect(JSON.stringify(result.error![field])).toContain(`original JSON length=${size}`);
          }
          expect(original.error[field]).toBe(value);
        }
      }
    }
  );

  it('keeps a complete ordinary remedy beside an oversized supplied value', () => {
    const suggestion =
      'An explicit session close uploads it there: rbook_session(action="start", type="custom", ' +
      'title="Share through the dashboard"). Once that session is complete, close it to upload ' +
      'the project, then retry sharing.';
    expect(JSON.stringify(suggestion).length).toBeGreaterThan(160);
    const result = boundErrorFields({
      success: false,
      error: {
        code: 'INVALID_PARAMETER',
        message: 'Bad value',
        suggestion,
        providedValue: 'x'.repeat(100000),
      },
    });
    expect(result.error.suggestion).toBe(suggestion);
    expect(JSON.stringify(result.error.providedValue).length).toBeLessThanOrEqual(160);
  });

  test.each(fields)('%s cannot expand a refusal through strings, arrays or objects', (field) => {
    for (const value of [
      'x'.repeat(100000),
      '\u0000'.repeat(100000),
      Array(20000).fill('value'),
      { nested: 'x'.repeat(100000) },
    ]) {
      const original = {
        success: false,
        error: {
          code: 'INVALID_PARAMETER',
          message: 'Bad value',
          [field]: value,
        } as RbookToolError,
      };
      const result = boundErrorFields(original);
      expect(JSON.stringify(result.error![field]).length).toBeLessThanOrEqual(160);
      expect(JSON.stringify(result.error![field])).toContain('original JSON length=');
      expect(original.error[field]).toBe(value);
      if (field === 'validValues') expect(Array.isArray(result.error!.validValues)).toBe(true);
    }
  });

  it('preserves small error values and successful answer identity', () => {
    const small = {
      success: false,
      error: {
        code: 'INVALID_PARAMETER',
        message: 'Bad value',
        providedValue: 0,
        currentState: { id: 42 },
        validValues: ['open', 'closed'],
      },
    };
    expect(boundErrorFields(small)).toEqual(small);
    const success = { success: true, data: { text: 'x'.repeat(100000) } };
    expect(boundErrorFields(success)).toBe(success);
  });

  it('bounds all six serialized fields together without mutating the caller', () => {
    const error = Object.fromEntries(
      fields.map((field) => [field, 'x'.repeat(100000)])
    ) as unknown as RbookToolError;
    error.code = 'INVALID_PARAMETER';
    const result = boundErrorFields({ success: false, error });
    expect(JSON.stringify(result).length).toBeLessThan(1200);
    expect(error.message).toHaveLength(100000);
  });

  it('reports exact original JSON length and accounts for escaped control characters', () => {
    const value = '\u0000'.repeat(100000);
    const bounded = boundErrorValue(value);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(160);
    expect(bounded).toContain(`original JSON length=${JSON.stringify(value).length}`);
  });
});
