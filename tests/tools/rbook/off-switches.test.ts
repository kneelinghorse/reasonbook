// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m02 — the upload and shared-sync off switches read off, false, 0 and no, in any case, as off, as the
// ABOUTME: sharing switch does; one of them left on by `false` kept uploading the whole store after a person said no.

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  RBOOK_CHECKPOINT_SYNC_ENV,
  whyCloseUploadsNothing,
} from '../../../src/tools/rbook/checkpoint-backfill';
import { SHARED_SYNC_ENV, sharedSyncEnabled } from '../../../src/tools/rbook/record-sync-trigger';

const saved = {
  [RBOOK_CHECKPOINT_SYNC_ENV]: process.env[RBOOK_CHECKPOINT_SYNC_ENV],
  [SHARED_SYNC_ENV]: process.env[SHARED_SYNC_ENV],
  RBOOK_DASHBOARD_API_KEY: process.env.RBOOK_DASHBOARD_API_KEY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const OFF = ['off', 'OFF', 'Off', 'false', 'False', '0', 'no', 'NO', ' off '];
const ON = ['on', 'ON', '1', 'true', 'yes'];

describe('the off switches (s100-m02)', () => {
  it.each(OFF)('RBOOK_CHECKPOINT_SYNC=%p stops a close uploading', async (value) => {
    // A credential, so only the switch can be what stops the upload.
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_fixture';
    process.env[RBOOK_CHECKPOINT_SYNC_ENV] = value;
    expect(await whyCloseUploadsNothing()).toBe('off');
  });

  it.each(ON)('RBOOK_CHECKPOINT_SYNC=%p leaves uploads on', async (value) => {
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_fixture';
    process.env[RBOOK_CHECKPOINT_SYNC_ENV] = value;
    expect(await whyCloseUploadsNothing()).toBeNull();
  });

  it.each(OFF)('RBOOK_SHARED_SYNC=%p stops the automatic syncs', (value) => {
    process.env[SHARED_SYNC_ENV] = value;
    expect(sharedSyncEnabled()).toBe(false);
  });

  it.each(ON)('RBOOK_SHARED_SYNC=%p leaves them on', (value) => {
    process.env[SHARED_SYNC_ENV] = value;
    expect(sharedSyncEnabled()).toBe(true);
  });
});
