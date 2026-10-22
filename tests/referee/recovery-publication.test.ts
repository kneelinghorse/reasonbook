// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Two independent host workers racing one confirmed recovery can publish only one complete referee file.
// ABOUTME: The winner remains callable under its own registry; the losing worker cleans only its own staging state.
import { expect, it } from '@jest/globals';
import { spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { peer, recoveryPlan, type RefereeOutcome } from '../../src/referee';
import { replicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture } from '../helpers/recovery-fixture';

it('publishes one winner without overwriting or orphaning either worker registry when finalizers race', async () => {
  const fixture = replicaFixture('rbook-recovery-publication-');
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const { input, location } = await recoveryFixture(fixture.tmp);
    const registryRoot = path.join(location.configDir, 'referees');
    const existingRegistries = fs.readdirSync(registryRoot);
    const plan = (await recoveryPlan(location, input)).result.data!;
    const args = path.join(fixture.tmp, 'confirmed.json');
    fs.writeFileSync(
      args,
      JSON.stringify({
        location,
        input: { ...input, confirmedPlanHash: plan.planHash, confirmedTailMembershipIds: [] },
      })
    );
    const script = `const fs=require('fs');const {finalizeRecovery}=require(process.argv[1]);const {location,input}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write('ready\\n');process.stdin.once('data',async()=>{try{const result=await finalizeRecovery(location,input);process.stdout.write(JSON.stringify(result)+'\\n');process.exit(0)}catch(e){process.stderr.write(String(e));process.exit(1)}});`;
    const workers = [0, 1].map(() => {
      const child = spawn(
        process.execPath,
        [
          '--require',
          path.resolve('tests/helpers/ts-register.js'),
          '-e',
          script,
          path.resolve('src/referee/recovery.ts'),
          args,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      children.push(child);
      let output = '';
      let errors = '';
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('ready')) resolve();
        });
        child.stderr.on('data', (chunk) => {
          errors += String(chunk);
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (!output.includes('ready')) reject(new Error(`worker exited ${code}: ${errors}`));
        });
      });
      const exited = once(child, 'exit');
      return { child, ready, exited, output: () => output, errors: () => errors };
    });
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.stdin.write('go');
    const outcomes: RefereeOutcome<unknown>[] = [];
    for (const worker of workers) {
      const [code] = await worker.exited;
      expect({ code, errors: worker.errors() }).toEqual({ code: 0, errors: '' });
      const resultText = worker.output().slice(worker.output().indexOf('{'));
      outcomes.push(JSON.parse(resultText));
    }
    expect(outcomes.filter((outcome) => outcome.result.success)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.result.success)).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.result.success)!;
    const db = new Database(location.storePath, { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
      const key = (
        db.prepare("SELECT value FROM referee_state WHERE key = 'registry_key'").get() as {
          value: string;
        }
      ).value;
      expect(existingRegistries).not.toContain(key);
      expect(fs.readdirSync(registryRoot).sort()).toEqual([...existingRegistries, key].sort());
    } finally {
      db.close();
    }
    const called = await peer(
      { ...location, expectedHead: winner.head },
      'hello',
      {},
      input.uploads[0].caller
    );
    expect(called.result.error).toBeUndefined();
    expect(
      fs
        .readdirSync(path.dirname(location.storePath))
        .filter((name) => name.startsWith('.recovery-'))
    ).toEqual([]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    fixture.restore();
  }
});
