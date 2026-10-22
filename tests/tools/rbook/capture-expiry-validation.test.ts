// SPDX-License-Identifier: Apache-2.0
// ABOUTME: An invalid expiry is refused before capture opens an implicit session or writes any record.
// ABOUTME: Handler and MCP dispatch fixtures also prove valid expiries and omitted/null compatibility.

import { afterEach, beforeEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookSessionCapture } from '../../../src/tools/rbook/rbook-session-capture';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let root: string;
let file: string;
const year = new Date().getUTCFullYear();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-capture-expiry-'));
  file = seedRbookDb(root, { projectId: 'capture-expiry' });
  RbookDetector.resetInstance();
});
afterEach(() => {
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

function state(): string {
  const db = new Database(file, { readonly: true });
  try {
    return JSON.stringify(
      ['sessions', 'constraints', 'session_events', 'context_snapshots'].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all()
      )
    );
  } finally {
    db.close();
  }
}

it.each([
  '',
  `${year}/02/28 12:00:00`,
  `${year}-01-01t00:00:00`,
  `${year}-01-32`,
  `${year}-01-01T12:00:00+15:00`,
  null,
])(
  'direct capture refuses %j before opening a session or writing capture data',
  async (expiresAt) => {
    const before = state();
    const bytes = fs.readFileSync(file);
    const result = await rbookSessionCapture({
      category: 'constraint',
      content: 'Do not store invalid expiry',
      expiresAt: expiresAt as string,
      projectRoot: root,
    });
    expect(result.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'expiresAt',
      suggestion: expect.any(String),
    });
    expect(state()).toBe(before);
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
);

it('MCP dispatch refuses a locale expiry before any session/capture/constraint/snapshot change', async () => {
  const before = state();
  const context = await buildMissionProtocolContext();
  const result = await executeMissionProtocolTool(
    'rbook_session',
    {
      action: 'capture',
      category: 'constraint',
      content: 'Not stored',
      expiresAt: `${year}/02/28 12:00:00`,
      projectRoot: root,
    },
    context
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    success: false,
    error: { code: 'INVALID_PARAMETER', field: 'expiresAt' },
  });
  expect(state()).toBe(before);
});

it.each(['valid', 'omitted', 'null'] as const)(
  'dispatch preserves %s expiry behavior',
  async (kind) => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const context = await buildMissionProtocolContext();
    const result = await executeMissionProtocolTool(
      'rbook_session',
      {
        action: 'capture',
        category: 'constraint',
        content: `expiry ${kind}`,
        projectRoot: root,
        ...(kind === 'omitted' ? {} : { expiresAt: kind === 'null' ? null : expiresAt }),
      },
      context
    );
    expect(result.isError).not.toBe(true);
    const db = new Database(file, { readonly: true });
    try {
      expect(
        db.prepare('SELECT expires_at FROM constraints WHERE content = ?').get(`expiry ${kind}`)
      ).toEqual({ expires_at: kind === 'valid' ? expiresAt : null });
      const { captures } = db.prepare('SELECT captures FROM sessions').get() as {
        captures: string;
      };
      expect(JSON.parse(captures)[0].expiresAt).toBe(kind === 'valid' ? expiresAt : undefined);
    } finally {
      db.close();
    }
  }
);
