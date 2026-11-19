import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';
import {
  WriteCoordinator,
  type CoordinatorOptions
} from '../../src/changes/coordinator.js';
import { ProjectLocks } from '../../src/changes/locks.js';
import type {
  Attestation,
  ChangeInput,
  FaultPoint
} from '../../src/changes/types.js';

const ownerId = 'owner';
const projectId = 'project';
const configPath = 'game/config.txt';
const scenePath = 'game/scene/start.txt';
const assetPath = 'game/background/new.png';
const attestation: Attestation = {
  source: 'user-message',
  statement: 'I saved and closed all editor pages for this project.'
};

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function expectAppError(
  operation: Promise<unknown>,
  code: string
): Promise<AppError> {
  try {
    await operation;
    throw new Error(`Expected AppError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    expect(appError.message).not.toContain('C:\\');
    return appError;
  }
}

describe('WriteCoordinator', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let sourceRoot: string;
  let stateRoot: string;
  let lockRoot: string;
  let config: AppConfig;
  let coordinator: WriteCoordinator;
  let originalConfig: Buffer;
  let originalScene: Buffer;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-coordinator-')));
    projectRoot = path.join(baseDirectory, '工程 A');
    sourceRoot = path.join(baseDirectory, '素材 来源');
    stateRoot = path.join(baseDirectory, 'mcp state');
    lockRoot = path.join(baseDirectory, 'locks');
    await mkdir(path.join(projectRoot, 'game', 'scene'), { recursive: true });
    await mkdir(path.join(projectRoot, 'game', 'background'), { recursive: true });
    await mkdir(sourceRoot);

    originalConfig = Buffer.from('title=Original\r\n', 'utf8');
    originalScene = Buffer.from('第一行\r\n第二行\r\n', 'utf8');
    await writeFile(path.join(projectRoot, configPath), originalConfig);
    await writeFile(path.join(projectRoot, scenePath), originalScene);

    config = {
      version: 1,
      projects: [{ id: projectId, root: projectRoot }],
      sources: [{ id: 'source', root: sourceRoot }]
    };
    coordinator = await createCoordinator();
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createCoordinator(
    options: CoordinatorOptions = {}
  ): Promise<WriteCoordinator> {
    return WriteCoordinator.create(config, stateRoot, {
      locks: new ProjectLocks(lockRoot),
      capabilityCheck: async () => true,
      now: () => 1000,
      ...options
    });
  }

  function beginSession(
    target: WriteCoordinator,
    paths: string[] = [configPath, scenePath, assetPath]
  ) {
    return target.sessions.begin(ownerId, projectId, attestation, paths);
  }

  function replaceChange(
    targetPath: string,
    expected: Buffer,
    next: Buffer
  ): ChangeInput {
    return {
      path: targetPath,
      expectedRevision: hash(expected),
      bytes: next
    };
  }

  function createChange(targetPath: string, bytes: Buffer): ChangeInput {
    return { path: targetPath, expectedRevision: null, bytes };
  }

  async function readProjectFile(relative: string): Promise<Buffer> {
    return readFile(path.join(projectRoot, ...relative.split('/')));
  }

  it('applies a mixed replace/create batch with exact bytes and backups', async () => {
    const nextConfig = Buffer.from('title=Updated\r\n', 'utf8');
    const nextScene = Buffer.from('新场景\r\n', 'utf8');
    const newAsset = Buffer.from([0, 1, 2, 255, 10]);
    const session = beginSession(coordinator);
    const plan = await coordinator.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig),
      replaceChange(scenePath, originalScene, nextScene),
      createChange(assetPath, newAsset)
    ]);

    const result = await coordinator.apply(ownerId, session.id, plan.id, 'mixed-1');
    expect(result).toMatchObject({
      status: 'complete',
      replayed: false
    });
    expect(result.operations.map((operation) => operation.phase)).toEqual([
      'applied',
      'applied',
      'applied'
    ]);
    expect(await readProjectFile(configPath)).toEqual(nextConfig);
    expect(await readProjectFile(scenePath)).toEqual(nextScene);
    expect(await readProjectFile(assetPath)).toEqual(newAsset);

    expect(result.operations[0]?.backup).toBeDefined();
    expect(result.operations[1]?.backup).toBeDefined();
    expect(result.operations[2]?.backup).toBeUndefined();
    expect(await coordinator.store.readBackup(result.operations[0]!.backup!))
      .toEqual(originalConfig);
    expect(await coordinator.store.readBackup(result.operations[1]!.backup!))
      .toEqual(originalScene);

    const report = await coordinator.inspect(projectId, result.batchId);
    expect(report).toMatchObject({
      batchId: result.batchId,
      status: 'complete',
      errorCode: null,
      snapshotOnly: true
    });
    expect(report.operations[0]).toMatchObject({
      path: configPath,
      phase: 'applied',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true,
      stagingPresent: false
    });
    expect(report.operations[1]).toMatchObject({
      path: scenePath,
      phase: 'applied',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true,
      stagingPresent: false
    });
    expect(report.operations[2]).toMatchObject({
      path: assetPath,
      phase: 'applied',
      diskState: 'planned',
      backupVerified: false,
      canRestore: false,
      stagingPresent: false,
      limitation: 'Created files are never automatically deleted.'
    });
  });

  it('requires a matching active session and rejects out-of-scope plans', async () => {
    const nextConfig = Buffer.from('title=Updated\r\n', 'utf8');
    await expectAppError(
      coordinator.plan(ownerId, randomUUID(), projectId, [
        replaceChange(configPath, originalConfig, nextConfig)
      ]),
      'HANDOFF_REQUIRED'
    );

    const scoped = beginSession(coordinator, [configPath]);
    await expectAppError(
      coordinator.plan(ownerId, scoped.id, projectId, [
        replaceChange(scenePath, originalScene, Buffer.from('outside scope', 'utf8'))
      ]),
      'SCOPE_MISMATCH'
    );

    const ended = beginSession(coordinator, [configPath]);
    const plan = await coordinator.plan(ownerId, ended.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig)
    ]);
    coordinator.sessions.end(ended.id, ownerId);
    await expectAppError(
      coordinator.apply(ownerId, ended.id, plan.id, 'ended-session'),
      'HANDOFF_REQUIRED'
    );
    expect(await readProjectFile(configPath)).toEqual(originalConfig);
  });

  it('rejects a stale revision before any target write', async () => {
    const planned = Buffer.from('title=Planned\r\n', 'utf8');
    const humanEdit = Buffer.from('title=Human edit\r\n', 'utf8');
    const session = beginSession(coordinator, [configPath]);
    const plan = await coordinator.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, planned)
    ]);

    await writeFile(path.join(projectRoot, configPath), humanEdit);
    await expectAppError(
      coordinator.apply(ownerId, session.id, plan.id, 'stale-revision'),
      'REVISION_CONFLICT'
    );
    expect(await readProjectFile(configPath)).toEqual(humanEdit);
    expect(await coordinator.store.listBatchIds()).toEqual([]);
  });

  it('reports backup failure and leaves the target untouched', async () => {
    const nextConfig = Buffer.from('title=Updated\r\n', 'utf8');
    const failing = await createCoordinator({
      fault: async (point: FaultPoint) => {
        if (point === 'before-backup') {
          throw new Error('injected backup failure');
        }
      }
    });
    const session = beginSession(failing, [configPath]);
    const plan = await failing.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig)
    ]);

    const result = await failing.apply(ownerId, session.id, plan.id, 'backup-failure');
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'BACKUP_FAILED',
      replayed: false
    });
    expect(await readProjectFile(configPath)).toEqual(originalConfig);

    const report = await failing.inspect(projectId, result.batchId);
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'BACKUP_FAILED'
    });
    expect(report.operations[0]).toMatchObject({
      phase: 'pending',
      diskState: 'original',
      backupVerified: false,
      canRestore: false
    });
    await expectAppError(
      failing.plan(ownerId, session.id, projectId, [
        replaceChange(configPath, originalConfig, nextConfig)
      ]),
      'HANDOFF_REQUIRED'
    );
  });

  it('records partial after a completed write and journal update', async () => {
    const nextConfig = Buffer.from('title=Partial\r\n', 'utf8');
    const nextScene = Buffer.from('partial scene', 'utf8');
    const failing = await createCoordinator({
      fault: async (point: FaultPoint, index?: number) => {
        if (point === 'after-record' && index === 0) {
          throw new Error('injected after-record failure');
        }
      }
    });
    const session = beginSession(failing, [configPath, scenePath]);
    const plan = await failing.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig),
      replaceChange(scenePath, originalScene, nextScene)
    ]);

    const result = await failing.apply(ownerId, session.id, plan.id, 'partial');
    expect(result).toMatchObject({
      status: 'partial',
      errorCode: 'WRITE_FAILED',
      replayed: false
    });
    expect(await readProjectFile(configPath)).toEqual(nextConfig);
    expect(await readProjectFile(scenePath)).toEqual(originalScene);

    const report = await failing.inspect(projectId, result.batchId);
    expect(report.status).toBe('partial');
    expect(report.operations[0]).toMatchObject({
      phase: 'applied',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true
    });
    expect(report.operations[1]).toMatchObject({
      phase: 'pending',
      diskState: 'original',
      backupVerified: true,
      canRestore: false
    });
  });

  it('records partial when disconnect closes the session before the next target', async () => {
    const nextConfig = Buffer.from('title=Disconnected\r\n', 'utf8');
    const nextScene = Buffer.from('disconnected scene', 'utf8');
    const failing = await createCoordinator({
      fault: async (point: FaultPoint, index?: number) => {
        if (point === 'after-record' && index === 0) {
          failing.sessions.disconnect(ownerId);
        }
      }
    });
    const session = beginSession(failing, [configPath, scenePath]);
    const plan = await failing.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig),
      replaceChange(scenePath, originalScene, nextScene)
    ]);

    const result = await failing.apply(ownerId, session.id, plan.id, 'disconnect-partial');
    expect(result).toMatchObject({
      status: 'partial',
      errorCode: 'HANDOFF_REQUIRED',
      replayed: false
    });
    expect(await readProjectFile(configPath)).toEqual(nextConfig);
    expect(await readProjectFile(scenePath)).toEqual(originalScene);

    const report = await failing.inspect(projectId, result.batchId);
    expect(report.status).toBe('partial');
    expect(report.operations[0]).toMatchObject({
      phase: 'applied',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true
    });
    expect(report.operations[1]).toMatchObject({
      phase: 'pending',
      diskState: 'original',
      backupVerified: true,
      canRestore: false
    });
    await expectAppError(
      failing.plan(ownerId, session.id, projectId, [
        replaceChange(configPath, nextConfig, Buffer.from('closed', 'utf8'))
      ]),
      'HANDOFF_REQUIRED'
    );
  });

  it('records uncertain when the write completed before the journal update', async () => {
    const nextConfig = Buffer.from('title=Uncertain\r\n', 'utf8');
    const nextScene = Buffer.from('uncertain scene', 'utf8');
    const failing = await createCoordinator({
      fault: async (point: FaultPoint, index?: number) => {
        if (point === 'after-write' && index === 0) {
          throw new Error('injected after-write failure');
        }
      }
    });
    const session = beginSession(failing, [configPath, scenePath]);
    const plan = await failing.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig),
      replaceChange(scenePath, originalScene, nextScene)
    ]);

    const result = await failing.apply(ownerId, session.id, plan.id, 'uncertain');
    expect(result).toMatchObject({
      status: 'uncertain',
      errorCode: 'WRITE_FAILED',
      replayed: false
    });
    expect(await readProjectFile(configPath)).toEqual(nextConfig);
    expect(await readProjectFile(scenePath)).toEqual(originalScene);

    const report = await failing.inspect(projectId, result.batchId);
    expect(report.status).toBe('uncertain');
    expect(report.operations[0]).toMatchObject({
      phase: 'intent',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true
    });
    expect(report.operations[1]).toMatchObject({
      phase: 'pending',
      diskState: 'original',
      backupVerified: true,
      canRestore: false
    });
  });

  it('records uncertain and keeps the target original when disconnect happens before write', async () => {
    const nextConfig = Buffer.from('title=Before write disconnect\r\n', 'utf8');
    const nextScene = Buffer.from('before write disconnected scene', 'utf8');
    const failing = await createCoordinator({
      fault: async (point: FaultPoint, index?: number) => {
        if (point === 'before-write' && index === 0) {
          failing.sessions.disconnect(ownerId);
        }
      }
    });
    const session = beginSession(failing, [configPath, scenePath]);
    const plan = await failing.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig),
      replaceChange(scenePath, originalScene, nextScene)
    ]);

    const result = await failing.apply(ownerId, session.id, plan.id, 'before-write-disconnect');
    expect(result).toMatchObject({
      status: 'uncertain',
      errorCode: 'HANDOFF_REQUIRED',
      replayed: false
    });
    expect(await readProjectFile(configPath)).toEqual(originalConfig);
    expect(await readProjectFile(scenePath)).toEqual(originalScene);

    const report = await failing.inspect(projectId, result.batchId);
    expect(report.status).toBe('uncertain');
    expect(report.operations[0]).toMatchObject({
      phase: 'intent',
      diskState: 'original',
      backupVerified: true,
      canRestore: false,
      stagingPresent: false
    });
    expect(report.operations[1]).toMatchObject({
      phase: 'pending',
      diskState: 'original',
      backupVerified: true,
      canRestore: false,
      stagingPresent: false
    });
    await expectAppError(
      failing.plan(ownerId, session.id, projectId, [
        replaceChange(configPath, originalConfig, nextConfig)
      ]),
      'HANDOFF_REQUIRED'
    );
  });

  it('restores only selected files, replays restore idempotency, and refuses later edits', async () => {
    const nextConfig = Buffer.from('title=Restore me\r\n', 'utf8');
    const nextScene = Buffer.from('scene after batch', 'utf8');
    const session = beginSession(coordinator, [configPath, scenePath]);
    const plan = await coordinator.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig),
      replaceChange(scenePath, originalScene, nextScene)
    ]);
    const applied = await coordinator.apply(ownerId, session.id, plan.id, 'restore-source');
    expect(applied.status).toBe('complete');

    const currentConfig = await readProjectFile(configPath);
    const restored = await coordinator.restore(
      ownerId,
      session.id,
      projectId,
      applied.batchId,
      [{ path: configPath, expectedRevision: hash(currentConfig) }],
      'restore-selected'
    );
    expect(restored).toMatchObject({
      status: 'complete',
      replayed: false
    });
    expect(await readProjectFile(configPath)).toEqual(originalConfig);
    expect(await readProjectFile(scenePath)).toEqual(nextScene);

    const replayed = await coordinator.restore(
      ownerId,
      session.id,
      projectId,
      applied.batchId,
      [{ path: configPath, expectedRevision: hash(currentConfig) }],
      'restore-selected'
    );
    expect(replayed).toMatchObject({
      batchId: restored.batchId,
      status: 'complete',
      replayed: true
    });
    expect(await readProjectFile(configPath)).toEqual(originalConfig);

    const humanEdit = Buffer.from('scene edited by human', 'utf8');
    await writeFile(path.join(projectRoot, scenePath), humanEdit);
    await expectAppError(
      coordinator.restore(
        ownerId,
        session.id,
        projectId,
        applied.batchId,
        [{ path: scenePath, expectedRevision: hash(humanEdit) }],
        'restore-after-human-edit'
      ),
      'RECOVERY_CONFLICT'
    );
    expect(await readProjectFile(scenePath)).toEqual(humanEdit);
  });

  it('replays idempotency after restart with a new session and rejects a different plan', async () => {
    const nextConfig = Buffer.from('title=First\r\n', 'utf8');
    const session = beginSession(coordinator, [configPath]);
    const plan = await coordinator.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig)
    ]);
    const first = await coordinator.apply(ownerId, session.id, plan.id, 'restart-key');
    expect(first.status).toBe('complete');

    const restarted = await createCoordinator();
    const newSession = beginSession(restarted, [configPath]);
    const replayed = await restarted.apply(
      ownerId,
      newSession.id,
      plan.id,
      'restart-key'
    );
    expect(replayed).toMatchObject({
      batchId: first.batchId,
      status: 'complete',
      replayed: true
    });
    expect(await readProjectFile(configPath)).toEqual(nextConfig);

    const newerConfig = Buffer.from('title=Second\r\n', 'utf8');
    const secondPlan = await restarted.plan(ownerId, newSession.id, projectId, [
      replaceChange(configPath, nextConfig, newerConfig)
    ]);
    await expectAppError(
      restarted.apply(ownerId, newSession.id, secondPlan.id, 'restart-key'),
      'IDEMPOTENCY_CONFLICT'
    );
    expect(await readProjectFile(configPath)).toEqual(nextConfig);
  });

  it('rejects apply when the injected capability check is false', async () => {
    const nextConfig = Buffer.from('title=Unsupported\r\n', 'utf8');
    const unsupported = await createCoordinator({
      capabilityCheck: async () => false
    });
    const session = beginSession(unsupported, [configPath]);
    const plan = await unsupported.plan(ownerId, session.id, projectId, [
      replaceChange(configPath, originalConfig, nextConfig)
    ]);

    await expectAppError(
      unsupported.apply(ownerId, session.id, plan.id, 'unsupported'),
      'UNSUPPORTED_CAPABILITY'
    );
    expect(await readProjectFile(configPath)).toEqual(originalConfig);
    expect(await unsupported.store.listBatchIds()).toEqual([]);
  });
});
