// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — the previous-address list a rename writes (m03) is validated on write: rbook:// addresses,
// ABOUTME: each in the dashboard's grammar, none twice, and never the store's current address.

import { describe, expect, it } from '@jest/globals';

import { checkPreviousAddresses } from '../../../src/tools/rbook/address-rule';

describe('the previous-address list a rename writes (m03 writes it; m01 validates it)', () => {
  it('takes rbook:// addresses that are not the current one', () => {
    expect(
      checkPreviousAddresses(['cmos://derek/cmos-mcp-pro'], 'rbook://derek/reasonbook-pro')
    ).toEqual({ addresses: ['rbook://derek/cmos-mcp-pro'] });
  });

  it.each([
    ['not a list', 'rbook://derek/old'],
    ['a malformed entry', ['rbook://derek/old.one']],
    ['the current address', ['cmos://derek/reasonbook-pro']],
    ['a duplicate', ['rbook://derek/old', 'cmos://derek/old']],
  ])('refuses %s', (_case, list) => {
    expect(checkPreviousAddresses(list, 'rbook://derek/reasonbook-pro')).toEqual({
      refused: expect.any(String),
    });
  });
});
