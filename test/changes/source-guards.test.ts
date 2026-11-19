import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';
import { readSource } from '../../src/assets/source.js';
import {
  WriteCoordinator,
  type CoordinatorOptions
} from '../../src/changes/coordinator.js';
import { ProjectLocks } from '../../src/changes/locks.js';
import { SessionManager } from '../../src/changes/sessions.js';
import type {
  Attestation,
  ChangeInput,
  SourceRevision,
  WritePlan
} from '../../src/changes/types.js';

const ownerId = 'owner';
const projectId = 'project';
const sourceId = 'source';
const sourcePath = 'asset.bin';
const targetPath = 'game/background/imported.bin';
const attestation: Attestation = {
  source: 'user-message',
  statement: 'I saved and closed all editor pages for this project.'
};

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let testBaseDirectory = '';

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
    expect(appError.message).not.toContain(testBaseDirectory);
    return appError;
  }
}

describe('coordinator source guards', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let sourceRoot: string;
  let alternateSourceRoot: string;
  let stateRoot: string;
  let lockRoot: string;
  let config: AppConfig;
  let sourceBytes: Buffer;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-source-guards-')));
    testBaseDirectory = baseDirectory;
    projectRoot = path.join(baseDirectory, '工程');
    sourceRoot = path.join(baseDirectory, '素材来源 A');
    alternateSourceRoot = path.join(baseDirectory, '素材来源 B');
    stateRoot = path.join(baseDirectory, 'state');
    lockRoot = path.join(baseDirectory, 'locks');
    await mkdir(path.join(projectRoot, 'game', 'background'), { recursive: true });
    await mkdir(sourceRoot);
    await mkdir(alternateSourceRoot);
    sourceBytes = Buffer.from([0, 1, 2, 255, 10]);
    await writeFile(path.join(sourceRoot, sourcePath), sourceBytes);
    await writeFile(path.join(alternateSourceRoot, sourcePath), sourceBytes);
    config = {
      version: 1,
      projects: [{ id: projectId, root: projectRoot }],
      sources: [{ id: sourceId, root: sourceRoot }]
    };
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createCoordinator(
    targetConfig: AppConfig = config,
    options: CoordinatorOptions = {}
  ): Promise<WriteCoordinator> {
    return WriteCoordinator.create(targetConfig, stateRoot, {
      locks: new ProjectLocks(lockRoot),
      capabilityCheck: async () => true,
      now: () => 1000,
      ...options
    });
  }

  function beginSession(coordinator: WriteCoordinator) {
    return coordinator.sessions.begin(
      ownerId,
      projectId,
      attestation,
      [targetPath]
    );
  }

  function change(bytes: Buffer = sourceBytes): ChangeInput {
    return { path: targetPath, expectedRevision: null, bytes };
  }

  async function sourceRevision(
    targetConfig: AppConfig = config
  ): Promise<SourceRevision> {
    const source = await readSource(targetConfig, sourceId, sourcePath);
    return {
      sourceId,
      path: sourcePath,
      revision: source.revision,
      rootKey: source.rootKey
    };
  }

  async function expectTargetMissing(): Promise<void> {
    await expect(stat(path.join(projectRoot, ...targetPath.split('/')))).rejects
      .toMatchObject({ code: 'ENOENT' });
  }

  it('persists the source descriptor in the plan on disk', async () => {
    const coordinator = await createCoordinator();
    const session = beginSession(coordinator);
    const descriptor = await sourceRevision();
    const plan = await coordinator.plan(
      ownerId,
      session.id,
      projectId,
      [change()],
      undefined,
      [descriptor]
    );

    expect(plan.sources).toEqual([descriptor]);
    expect(await coordinator.store.readJson(`plans/${plan.id}.json`)).toMatchObject({
      sources: [descriptor]
    });
  });

  it('rejects a source change between plan and apply with zero target writes', async () => {
    const coordinator = await createCoordinator();
    const session = beginSession(coordinator);
    const descriptor = await sourceRevision();
    const plan = await coordinator.plan(
      ownerId,
      session.id,
      projectId,
      [change()],
      undefined,
      [descriptor]
    );
    await writeFile(path.join(sourceRoot, sourcePath), Buffer.from('changed'));

    await expectAppError(
      coordinator.apply(ownerId, session.id, plan.id, 'source-changed'),
      'SOURCE_CHANGED'
    );
    await expectTargetMissing();
    expect(await coordinator.store.listBatchIds()).toEqual([]);
  });

  it('rejects a source change after backups with a failed journal and no target writes', async () => {
    const coordinator = await createCoordinator(undefined, {
      fault: async (point) => {
        if (point === 'after-backups') {
          await writeFile(path.join(sourceRoot, sourcePath), Buffer.from('late change'));
        }
      }
    });
    const session = beginSession(coordinator);
    const descriptor = await sourceRevision();
    const plan = await coordinator.plan(
      ownerId,
      session.id,
      projectId,
      [change()],
      undefined,
      [descriptor]
    );

    const result = await coordinator.apply(ownerId, session.id, plan.id, 'late-source-change');
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'SOURCE_CHANGED',
      replayed: false
    });
    await expectTargetMissing();

    const report = await coordinator.inspect(projectId, result.batchId);
    expect(report).toMatchObject({
      status: 'failed',
      errorCode: 'SOURCE_CHANGED'
    });
    expect(report.operations[0]).toMatchObject({
      phase: 'pending',
      diskState: 'missing',
      backupVerified: false,
      canRestore: false
    });
  });

  it('rejects a source root remap across coordinators sharing plan state', async () => {
    const first = await createCoordinator();
    const session = beginSession(first);
    const descriptor = await sourceRevision();
    const plan = await first.plan(
      ownerId,
      session.id,
      projectId,
      [change()],
      undefined,
      [descriptor]
    );

    const remappedConfig: AppConfig = {
      ...config,
      sources: [{ id: sourceId, root: alternateSourceRoot }]
    };
    const sharedSessions = first.sessions;
    const second = await createCoordinator(remappedConfig, { sessions: sharedSessions });
    await expectAppError(
      second.apply(ownerId, session.id, plan.id, 'root-remap'),
      'SOURCE_CHANGED'
    );
    await expectTargetMissing();
  });

  it('rejects a tampered plan source descriptor as corrupt state', async () => {
    const coordinator = await createCoordinator();
    const session = beginSession(coordinator);
    const descriptor = await sourceRevision();
    const plan = await coordinator.plan(
      ownerId,
      session.id,
      projectId,
      [change()],
      undefined,
      [descriptor]
    );
    const planPath = `plans/${plan.id}.json`;
    const stored = await coordinator.store.readJson(planPath) as WritePlan;
    stored.sources![0]!.revision = hash('tampered');
    await coordinator.store.replaceJson(planPath, stored);

    await expectAppError(
      coordinator.apply(ownerId, session.id, plan.id, 'tampered-plan'),
      'STATE_CORRUPT'
    );
    await expectTargetMissing();
  });

  it('replays a completed key after source removal without reading the source or rewriting', async () => {
    const first = await createCoordinator();
    const session = beginSession(first);
    const descriptor = await sourceRevision();
    const plan = await first.plan(
      ownerId,
      session.id,
      projectId,
      [change()],
      undefined,
      [descriptor]
    );
    const applied = await first.apply(ownerId, session.id, plan.id, 'completed-key');
    expect(applied.status).toBe('complete');
    const target = path.join(projectRoot, ...targetPath.split('/'));
    expect(await readFile(target)).toEqual(sourceBytes);

    await rm(path.join(sourceRoot, sourcePath));
    const reloaded = await createCoordinator(undefined, { sessions: new SessionManager(() => 1000) });
    const freshSession = beginSession(reloaded);
    const replayed = await reloaded.apply(
      ownerId,
      freshSession.id,
      plan.id,
      'completed-key'
    );
    expect(replayed).toMatchObject({
      batchId: applied.batchId,
      status: 'complete',
      replayed: true
    });
    expect(await readFile(target)).toEqual(sourceBytes);
  });
});
