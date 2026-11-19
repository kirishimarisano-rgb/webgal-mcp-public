import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WriteCoordinator } from '../../src/changes/coordinator.js';
import { ProjectLocks } from '../../src/changes/locks.js';
import { snapshotTarget } from '../../src/changes/targets.js';
import type { BatchRecord, WriteSession } from '../../src/changes/types.js';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';

const fixturePath = path.join(
  process.cwd(),
  'test',
  'changes',
  'fixtures',
  'coordinator-child.mjs'
);

const attestation = {
  source: 'user-message' as const,
  statement: 'I saved and closed all editor pages for this project.'
};

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(inputPath: string, timeoutMs = 10000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, inputPath], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Coordinator child timed out: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function expectAppError(operation: () => Promise<unknown>, code: string): Promise<void> {
  return operation().then(
    () => {
      throw new Error(`Expected AppError ${code}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
    }
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition.');
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function treeDigest(root: string): Promise<string> {
  const records: string[] = [];

  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelative = relative === ''
        ? entry.name
        : `${relative}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, entryRelative);
      } else if (entry.isFile()) {
        records.push(`${entryRelative}:${sha256(await readFile(absolute))}`);
      }
    }
  };

  await walk(root, '');
  return sha256(records.join('\n'));
}

describe('coordinator crash recovery', () => {
  let baseDirectory: string;
  let root: string;
  let sceneDirectory: string;
  let stateRoot: string;
  let lockRoot: string;
  let config: AppConfig;
  let coordinator: WriteCoordinator;

  beforeEach(async () => {
    baseDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), 'webgal-mcp-crash-'))
    );
    root = path.join(baseDirectory, 'Project');
    sceneDirectory = path.join(root, 'game', 'scene');
    stateRoot = path.join(baseDirectory, 'state');
    lockRoot = path.join(baseDirectory, 'locks');
    await mkdir(sceneDirectory, { recursive: true });
    await mkdir(lockRoot);
    await writeFile(path.join(root, 'game', 'config.txt'), 'title=crash-test\r\n', 'utf8');
    config = {
      version: 1,
      projects: [{
        id: 'project',
        name: 'Crash Test',
        root,
        terreUrl: 'http://127.0.0.1:1',
        terreGameDir: 'game'
      }],
      sources: []
    };
    coordinator = await WriteCoordinator.create(config, stateRoot, {
      locks: new ProjectLocks(lockRoot),
      capabilityCheck: async () => true
    });
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  it('recovers a crashed publish without deleting creates or writing during inspect', async () => {
    const sceneA = 'game/scene/a.txt';
    const sceneB = 'game/scene/b.txt';
    const created = 'game/scene/created.txt';
    const sceneAPath = path.join(root, ...sceneA.split('/'));
    const sceneBPath = path.join(root, ...sceneB.split('/'));
    const createdPath = path.join(root, ...created.split('/'));
    const originalA = Buffer.from('alpha-original\r\n', 'utf8');
    const originalB = Buffer.from('beta-original\r\n', 'utf8');
    const crashedA = Buffer.from('alpha-crashed\r\n', 'utf8');
    const plannedCreate = Buffer.from('created-by-recovery\r\n', 'utf8');
    const plannedB = Buffer.from('beta-not-published\r\n', 'utf8');
    const crashOwner = 'crash-owner';
    const crashKey = 'crash-first-publish';

    await writeFile(sceneAPath, originalA);
    await writeFile(sceneBPath, originalB);
    const revisionA = (await snapshotTarget(root, sceneA)).revision;
    const revisionB = (await snapshotTarget(root, sceneB)).revision;
    expect(revisionA).toMatch(/^[0-9a-f]{64}$/);
    expect(revisionB).toMatch(/^[0-9a-f]{64}$/);

    const inputPath = path.join(baseDirectory, 'coordinator-input.json');
    await writeFile(inputPath, JSON.stringify({
      project: config.projects[0],
      stateRoot,
      lockRoot,
      ownerId: crashOwner,
      attestation,
      idempotencyKey: crashKey,
      changes: [
        {
          path: sceneA,
          expectedRevision: revisionA,
          bytesBase64: crashedA.toString('base64')
        },
        {
          path: created,
          expectedRevision: null,
          bytesBase64: plannedCreate.toString('base64')
        },
        {
          path: sceneB,
          expectedRevision: revisionB,
          bytesBase64: plannedB.toString('base64')
        }
      ]
    }), 'utf8');

    const child = await runChild(inputPath);
    expect(child.code).toBe(77);
    expect(child.signal).toBeNull();

    const batchIds = await coordinator.store.listBatchIds();
    expect(batchIds).toHaveLength(1);
    const batchId = batchIds[0] as string;
    const journal = await coordinator.store.readJson<BatchRecord>(
      `batches/${batchId}/journal.json`
    );
    expect(journal).toMatchObject({
      id: batchId,
      projectId: 'project',
      status: 'applying',
      operations: [
        { path: sceneA, phase: 'intent' },
        { path: created, phase: 'pending' },
        { path: sceneB, phase: 'pending' }
      ]
    });

    await waitFor(async () => {
      const inspectedLock = await coordinator.locks.inspect(root);
      return inspectedLock.ownerAlive === false;
    });
    const staleLock = await coordinator.locks.inspect(root);
    expect(staleLock).toMatchObject({
      locked: true,
      ownerAlive: false,
      token: expect.any(String)
    });
    const lockFiles = await readdir(lockRoot);
    expect(lockFiles).toHaveLength(1);
    const lockBytesBefore = await readFile(path.join(lockRoot, lockFiles[0] as string));
    const stateBeforeInspect = await treeDigest(stateRoot);
    const targetsBeforeInspect = {
      a: await readFile(sceneAPath),
      b: await readFile(sceneBPath),
      createdExists: await readFile(createdPath).then(() => true, () => false)
    };

    const pending = await coordinator.pending('project');
    const inspected = await coordinator.inspect('project', batchId);

    expect(await treeDigest(stateRoot)).toBe(stateBeforeInspect);
    expect(await readFile(path.join(lockRoot, lockFiles[0] as string)))
      .toEqual(lockBytesBefore);
    expect(await readFile(sceneAPath)).toEqual(targetsBeforeInspect.a);
    expect(await readFile(sceneBPath)).toEqual(targetsBeforeInspect.b);
    expect(await readFile(createdPath).then(() => true, () => false))
      .toBe(targetsBeforeInspect.createdExists);
    expect(pending.unreadableRecords).toBe(0);
    expect(pending.batches).toHaveLength(1);
    expect(pending.batches[0]).toMatchObject({
      batchId,
      status: 'applying',
      snapshotOnly: true
    });
    expect(pending.batches[0]?.operations[0]).toMatchObject({
      path: sceneA,
      phase: 'intent',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true
    });
    expect(pending.batches[0]?.operations[1]).toMatchObject({
      path: created,
      phase: 'pending',
      diskState: 'missing',
      canRestore: false,
      limitation: 'Created files are never automatically deleted.'
    });
    expect(pending.batches[0]?.operations[2]).toMatchObject({
      path: sceneB,
      phase: 'pending',
      diskState: 'original',
      canRestore: false
    });
    expect(inspected).toEqual(pending.batches[0]);

    await expectAppError(
      () => coordinator.locks.reclaim(root, randomUUID()),
      'LOCK_NOT_RECLAIMABLE'
    );
    expect(await coordinator.locks.inspect(root)).toMatchObject({
      locked: true,
      token: staleLock.token,
      ownerAlive: false
    });
    await coordinator.locks.reclaim(root, staleLock.token as string);
    expect(await coordinator.locks.inspect(root)).toEqual({ locked: false });

    const replaySession: WriteSession = coordinator.sessions.begin(
      crashOwner,
      'project',
      attestation,
      [sceneA, created, sceneB]
    );
    expect(replaySession).toMatchObject({
      userAttested: true,
      automaticDirtyCheck: false
    });
    const stateBeforeReplay = await treeDigest(stateRoot);
    const targetsBeforeReplay = {
      a: await readFile(sceneAPath),
      b: await readFile(sceneBPath),
      createdExists: await readFile(createdPath).then(() => true, () => false)
    };
    const replayed = await coordinator.apply(
      crashOwner,
      replaySession.id,
      journal.planId,
      crashKey
    );
    expect(replayed).toMatchObject({
      batchId,
      status: 'uncertain',
      errorCode: 'RECOVERY_REQUIRED',
      replayed: true
    });
    expect(replayed.operations).toEqual(journal.operations);
    expect(await treeDigest(stateRoot)).toBe(stateBeforeReplay);
    expect(await readFile(sceneAPath)).toEqual(targetsBeforeReplay.a);
    expect(await readFile(sceneBPath)).toEqual(targetsBeforeReplay.b);
    expect(await readFile(createdPath).then(() => true, () => false))
      .toBe(targetsBeforeReplay.createdExists);
    expect(await coordinator.locks.inspect(root)).toEqual({ locked: false });

    const creator: WriteSession = coordinator.sessions.begin(
      'creator-owner',
      'project',
      attestation,
      [created]
    );
    expect(creator).toMatchObject({
      userAttested: true,
      automaticDirtyCheck: false
    });
    const createPlan = await coordinator.plan(
      'creator-owner',
      creator.id,
      'project',
      [{ path: created, expectedRevision: null, bytes: plannedCreate }]
    );
    const createResult = await coordinator.apply(
      'creator-owner',
      creator.id,
      createPlan.id,
      'create-never-deleted'
    );
    expect(createResult.status).toBe('complete');
    expect(await readFile(createdPath)).toEqual(plannedCreate);
    const afterCreateInspect = await coordinator.inspect('project', batchId);
    expect(afterCreateInspect.operations[1]).toMatchObject({
      path: created,
      diskState: 'planned',
      canRestore: false,
      limitation: 'Created files are never automatically deleted.'
    });

    const recoverySession: WriteSession = coordinator.sessions.begin(
      'recovery-owner',
      'project',
      attestation,
      [sceneA]
    );
    expect(recoverySession).toMatchObject({
      userAttested: true,
      automaticDirtyCheck: false
    });
    const currentRevision = (await snapshotTarget(root, sceneA)).revision;
    expect(currentRevision).toBe(sha256(crashedA));
    const restoreResult = await coordinator.restore(
      'recovery-owner',
      recoverySession.id,
      'project',
      batchId,
      [{ path: sceneA, expectedRevision: currentRevision as string }],
      'restore-first-published-target'
    );

    expect(restoreResult.status).toBe('complete');
    expect(restoreResult.operations[0]).toMatchObject({
      path: sceneA,
      phase: 'applied',
      backup: `batches/${restoreResult.batchId}/backups/0.bin`
    });
    expect(await coordinator.store.readBackup(
      restoreResult.operations[0]?.backup as string
    )).toEqual(crashedA);
    expect(await readFile(sceneAPath)).toEqual(originalA);
    expect(await readFile(sceneBPath)).toEqual(originalB);
    expect(await readFile(createdPath)).toEqual(plannedCreate);
  });
});
