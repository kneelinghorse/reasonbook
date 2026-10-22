// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Actual MCP sharing and HTTP exchange carry the installed library's report to both stores.
// ABOUTME: Explicit transport options work without ambient shared-sync activation and leave exchange observations honest.
import { getServerVersion } from '../../src/server-version';
import { reportedCopy } from '../../src/tools/rbook/record-peer-report';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import {
  recoveryClients,
  RECOVERY_PROJECT,
  RECOVERY_TOKENS,
  required,
} from '../helpers/hosted-recovery-client';
import { request } from '../helpers/referee-http';
import { onCopy } from '../helpers/shared-copies';

it('MCP join and explicit sync report actual versions over the reference HTTP server', async () => {
  const clients = await recoveryClients();
  try {
    expect(process.env.RBOOK_SHARED_SYNC).toBeUndefined();
    const member = await clients.join('darryl');
    required(await clients.sync(member));
    await onCopy(clients.fixture.tmp, member, (client) => {
      expect(reportedCopy(client, mergeContext(client).authority)).toEqual({
        libraryVersion: getServerVersion(),
        reads: 2,
      });
    });
    const response = await request(clients.server, `/api/test/projects/${RECOVERY_PROJECT}/peers`, {
      token: RECOVERY_TOKENS.owner,
    });
    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    expect(text).toContain('libraryVersion');
    expect(text).toContain(getServerVersion());
    expect(text).toContain('"reads":2');
  } finally {
    await clients.dispose();
  }
});
