// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m02 — the dashboard-sharing switch reads off, false, 0 and no, in any case, as off (the s97 review's
// ABOUTME: finding 16), and its refusal says what the switch leaves running without promising every copy a move back.

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  DASHBOARD_SHARING_ENV,
  dashboardSharingOff,
} from '../../../src/tools/rbook/record-dashboard-share';

const saved = process.env[DASHBOARD_SHARING_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[DASHBOARD_SHARING_ENV];
  else process.env[DASHBOARD_SHARING_ENV] = saved;
});

describe('the dashboard-sharing switch (s100-m02)', () => {
  // A person who turns sharing off and finds it still on has had a project sent where they said not
  // to: OFF and false used to leave it on.
  it.each(['off', 'OFF', 'Off', 'false', 'False', '0', 'no', 'NO', ' off '])(
    'reads %p as off, and names the value it read',
    (value) => {
      process.env[DASHBOARD_SHARING_ENV] = value;
      const refused = dashboardSharingOff();
      expect(refused?.message).toBe(
        `Sharing through the dashboard is off on this machine (${DASHBOARD_SHARING_ENV}=${value}).`
      );
    }
  );

  it.each([undefined, 'on', 'ON', '1', 'true'])('leaves sharing on for %p', (value) => {
    if (value === undefined) delete process.env[DASHBOARD_SHARING_ENV];
    else process.env[DASHBOARD_SHARING_ENV] = value;
    expect(dashboardSharingOff()).toBeNull();
  });

  it('says the switch stops no sync and no move back, without promising one to every copy', () => {
    process.env[DASHBOARD_SHARING_ENV] = 'off';
    const suggestion = dashboardSharingOff()?.suggestion ?? '';
    // A member's copy never moves a project back: only the owner's copy does.
    expect(suggestion).not.toMatch(/moves back either way/);
    expect(suggestion).toMatch(/keeps syncing/);
    expect(suggestion).toMatch(/owner's copy can still move it back/);
  });
});
