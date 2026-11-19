import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BusinessWriteService,
  type BusinessOperation
} from '../../src/changes/business.js';
import {
  WriteCoordinator
} from '../../src/changes/coordinator.js';
import {
  canonicalProjectKey,
  ProjectLocks
} from '../../src/changes/locks.js';
import {
  assertReferenceableTarget
} from '../../src/changes/targets.js';
import type {
  Attestation,
  BatchRecord,
  WritePlan
} from '../../src/changes/types.js';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';

const ownerId = 'owner';
const projectId = 'project';
const configPath = 'game/config.txt';
const attestation: Attestation = {
  source: 'user-message',
  statement: 'I saved and closed all editor pages for this project.'
};
const legacyTargetCases = [
  ['leaf #', 'nested/legacy#.txt'],
  ['leaf &', 'nested/legacy&.txt'],
  ['leaf @', 'nested/legacy@.txt'],
  ['leaf space-hyphen', 'nested/legacy -legacy.txt'],
  ['unsafe existing parent', 'nested/bad@parent/legacy.txt']
] as const;

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function planDigest(plan: Omit<WritePlan, 'digest'>): string {
  const payload: unknown[] = [
    plan.version,
    plan.id,
    plan.projectId,
    plan.projectKey,
    plan.ownerId,
    plan.sessionId,
    plan.createdAt,
    plan.expiresAt,
    plan.operations.map((operation) => [
      operation.path,
      operation.expectedRevision,
      operation.newRevision,
      operation.data
    ]),
    plan.restoresBatchId ?? null
  ];
  if (plan.sources) {
    payload.push(plan.sources.map((source) => [
      source.sourceId,
      source.path,
      source.revision,
      source.rootKey
    ]));
  }
  return hash(JSON.stringify(payload));
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

function expectSyncAppError(
  operation: () => unknown,
  code: string
): AppError {
  try {
    operation();
    throw new Error(`Expected AppError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
}

describe('Terre target naming policy', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let sourceRoot: string;
  let stateRoot: string;
  let lockRoot: string;
  let config: AppConfig;
  let coordinator: WriteCoordinator;
  let service: BusinessWriteService;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-naming-')));
    projectRoot = path.join(baseDirectory, '工程 A');
    sourceRoot = path.join(baseDirectory, '素材 来源');
    stateRoot = path.join(baseDirectory, 'state');
    lockRoot = path.join(baseDirectory, 'locks');

    await mkdir(path.join(projectRoot, 'game', 'scene', 'nested'), { recursive: true });
    await mkdir(path.join(projectRoot, 'game', 'background', 'nested'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'assets'), { recursive: true });
    await writeFile(path.join(projectRoot, configPath), 'Game_name:Safe;\r\n', 'utf8');

    config = {
      version: 1,
      projects: [{ id: projectId, root: projectRoot }],
      sources: [{ id: 'source', root: sourceRoot }]
    };
    coordinator = await createCoordinator();
    service = new BusinessWriteService(config, coordinator, ownerId);
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createCoordinator(): Promise<WriteCoordinator> {
    return WriteCoordinator.create(config, stateRoot, {
      locks: new ProjectLocks(lockRoot),
      capabilityCheck: async () => true,
      now: () => 1000
    });
  }

  function beginSession(target: WriteCoordinator, paths: string[]) {
    return target.sessions.begin(ownerId, projectId, attestation, paths);
  }

  async function expectMissing(relative: string): Promise<void> {
    await expect(stat(path.join(projectRoot, ...relative.split('/'))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }

  async function rewritePlanPath(
    target: WriteCoordinator,
    plan: WritePlan,
    nextPath: string
  ): Promise<WritePlan> {
    const { digest: _oldDigest, ...rest } = plan;
    const unsigned: Omit<WritePlan, 'digest'> = structuredClone(rest);
    unsigned.operations[0]!.path = nextPath;
    const nextPlan: WritePlan = {
      ...unsigned,
      digest: planDigest(unsigned)
    };
    await target.store.replaceJson(`plans/${plan.id}.json`, nextPlan);
    return nextPlan;
  }

  async function rewriteCompletedLegacyBatch(
    target: WriteCoordinator,
    plan: WritePlan,
    batchId: string,
    nextPath: string,
    idempotencyKey: string,
    originalPath: string
  ): Promise<WritePlan> {
    const nextPlan = await rewritePlanPath(target, plan, nextPath);
    const journalPath = `batches/${batchId}/journal.json`;
    const journal = await target.store.readJson<BatchRecord>(journalPath);
    journal.planDigest = nextPlan.digest;
    journal.operations[0]!.path = nextPath;
    await target.store.replaceJson(journalPath, journal);

    const projectKey = await canonicalProjectKey(projectRoot);
    const keyPath = `keys/${projectKey}/${hash(idempotencyKey)}.json`;
    const key = await target.store.readJson<{
      version: 1;
      projectKey: string;
      planId: string;
      digest: string;
      batchId: string;
    }>(keyPath);
    key.digest = nextPlan.digest;
    await target.store.replaceJson(keyPath, key);

    await rename(
      path.join(projectRoot, ...originalPath.split('/')),
      path.join(projectRoot, ...nextPath.split('/'))
    );
    return nextPlan;
  }

  it('accepts Chinese and spaces, rejects Terre chooser-only names, and keeps bare hyphens valid', () => {
    expect(assertReferenceableTarget('game/scene/第一章 开始.txt'))
      .toBe('game/scene/第一章 开始.txt');
    expect(assertReferenceableTarget('game/background/背景 图.png'))
      .toBe('game/background/背景 图.png');
    expect(assertReferenceableTarget('game/scene/bad-name.txt'))
      .toBe('game/scene/bad-name.txt');

    for (const invalid of [
      'game/scene/nested/#scene.txt',
      'game/scene/nested/&scene.txt',
      'game/scene/nested/@scene.txt',
      'game/scene/nested/bad -scene.txt',
      'game/scene/nested/bad#parent/legacy.txt',
      'game/scene/nested/bad&parent/legacy.txt',
      'game/scene/nested/bad@parent/legacy.txt',
      'game/scene/nested/bad -parent/legacy.txt',
      'game/background/nested/#asset.png',
      'game/background/nested/&asset.png',
      'game/background/nested/@asset.png',
      'game/background/nested/bad -asset.png',
      'game/background/nested/bad#parent/asset.png',
      'game/background/nested/bad&parent/asset.png',
      'game/background/nested/bad@parent/asset.png',
      'game/background/nested/bad -parent/asset.png'
    ]) {
      expectSyncAppError(
        () => assertReferenceableTarget(invalid),
        'TARGET_NAME_UNSUPPORTED'
      );
    }

    // `%` remains a filesystem-level path restriction, not a Terre chooser rule.
    expectSyncAppError(
      () => assertReferenceableTarget('game/scene/nested/bad%parent/legacy.txt'),
      'PATH_INVALID'
    );
  });

  it('rejects fresh scene and asset drafts/plans before any target or batch write', async () => {
    const sourceBytes = Buffer.from('source bytes', 'utf8');
    await writeFile(path.join(sourceRoot, 'assets', 'safe.png'), sourceBytes);
    const badSceneNames = [
      'nested/#scene.txt',
      'nested/&scene.txt',
      'nested/@scene.txt',
      'nested/bad -scene.txt'
    ];
    const badAssetNames = [
      'nested/#asset.png',
      'nested/&asset.png',
      'nested/@asset.png',
      'nested/bad -asset.png'
    ];
    const badTargets = [
      ...badSceneNames.map((name) => 'game/scene/' + name),
      ...badAssetNames.map((name) => 'game/background/' + name)
    ];
    const session = beginSession(coordinator, badTargets);

    for (const name of badSceneNames) {
      const operation: BusinessOperation = {
        type: 'create_scene',
        path: name,
        text: 'safe scene'
      };
      await expectAppError(
        service.plan(projectId, undefined, [operation]),
        'TARGET_NAME_UNSUPPORTED'
      );
      await expectAppError(
        service.plan(projectId, session.id, [operation]),
        'TARGET_NAME_UNSUPPORTED'
      );
    }

    for (const name of badAssetNames) {
      const operation: BusinessOperation = {
        type: 'import_asset',
        kind: 'background',
        path: name,
        sourceId: 'source',
        sourcePath: 'assets/safe.png',
        expectedSourceRevision: hash(sourceBytes)
      };
      await expectAppError(
        service.plan(projectId, undefined, [operation]),
        'TARGET_NAME_UNSUPPORTED'
      );
      await expectAppError(
        service.plan(projectId, session.id, [operation]),
        'TARGET_NAME_UNSUPPORTED'
      );
    }

    for (const target of badTargets) {
      await expectMissing(target);
    }
    await expect(stat(path.join(stateRoot, 'plans')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await coordinator.store.listBatchIds()).toEqual([]);
  });

  it('reads and imports a source filename containing chooser characters without changing its bytes', async () => {
    const sourceRelative = 'assets/#@ & 原图.png';
    const targetRelative = 'game/background/nested/safe source.png';
    const sourceBytes = Buffer.from([0, 1, 2, 255, 35, 64, 38]);
    await writeFile(
      path.join(sourceRoot, ...sourceRelative.split('/')),
      sourceBytes
    );
    const session = beginSession(coordinator, [targetRelative]);
    const review = await service.plan(projectId, session.id, [{
      type: 'import_asset',
      kind: 'background',
      path: 'nested/safe source.png',
      sourceId: 'source',
      sourcePath: sourceRelative,
      expectedSourceRevision: hash(sourceBytes)
    }]);

    expect(review.planId).toEqual(expect.any(String));
    const applied = await service.apply(
      session.id,
      review.planId as string,
      'source-name-import'
    );
    expect(applied.status).toBe('complete');
    expect(await readFile(path.join(projectRoot, ...targetRelative.split('/'))))
      .toEqual(sourceBytes);
    expect(await readFile(path.join(sourceRoot, ...sourceRelative.split('/'))))
      .toEqual(sourceBytes);
  });

  it('rejects a stale pending plan whose metadata now names an unsupported target', async () => {
    const allowedPath = 'game/scene/stale.txt';
    const badPath = 'game/scene/nested/stale#.txt';
    const session = beginSession(coordinator, [allowedPath, badPath]);
    const plan = await coordinator.plan(ownerId, session.id, projectId, [{
      path: allowedPath,
      expectedRevision: null,
      bytes: Buffer.from('pending scene', 'utf8')
    }]);
    await rewritePlanPath(coordinator, plan, badPath);

    await expectAppError(
      coordinator.apply(ownerId, session.id, plan.id, 'stale-naming'),
      'TARGET_NAME_UNSUPPORTED'
    );
    await expectMissing(allowedPath);
    await expectMissing(badPath);
    expect(await coordinator.store.listBatchIds()).toEqual([]);
  });

  it.each(legacyTargetCases)(
    'inspects, replays, and restores a completed legacy batch with %s',
    async (_label, relativeBadPath) => {
    const allowedPath = 'game/scene/legacy.txt';
    const badPath = 'game/scene/' + relativeBadPath;
    const original = Buffer.from('legacy original\r\n', 'utf8');
    const updated = Buffer.from('legacy updated\r\n', 'utf8');
    await mkdir(
      path.dirname(path.join(projectRoot, ...badPath.split('/'))),
      { recursive: true }
    );
    await writeFile(path.join(projectRoot, ...allowedPath.split('/')), original);

    const session = beginSession(coordinator, [allowedPath, badPath]);
    const plan = await coordinator.plan(ownerId, session.id, projectId, [{
      path: allowedPath,
      expectedRevision: hash(original),
      bytes: updated
    }]);
    const applied = await coordinator.apply(
      ownerId,
      session.id,
      plan.id,
      'legacy-key'
    );
    expect(applied.status).toBe('complete');

    const legacyPlan = await rewriteCompletedLegacyBatch(
      coordinator,
      plan,
      applied.batchId,
      badPath,
      'legacy-key',
      allowedPath
    );
    const inspected = await coordinator.inspect(projectId, applied.batchId);
    expect(inspected).toMatchObject({
      batchId: applied.batchId,
      status: 'complete'
    });
    expect(inspected.operations[0]).toMatchObject({
      path: badPath,
      phase: 'applied',
      diskState: 'planned',
      backupVerified: true,
      canRestore: true
    });

    const restarted = await createCoordinator();
    const newSession = beginSession(restarted, [badPath]);
    const replayed = await restarted.apply(
      ownerId,
      newSession.id,
      legacyPlan.id,
      'legacy-key'
    );
    expect(replayed).toMatchObject({
      batchId: applied.batchId,
      status: 'complete',
      replayed: true
    });
    expect(await readFile(path.join(projectRoot, ...badPath.split('/'))))
      .toEqual(updated);
    await expectMissing(allowedPath);

    const restored = await restarted.restore(
      ownerId,
      newSession.id,
      projectId,
      applied.batchId,
      [{ path: badPath, expectedRevision: hash(updated) }],
      'legacy-restore'
    );
    expect(restored.status).toBe('complete');
    expect(await readFile(path.join(projectRoot, ...badPath.split('/'))))
      .toEqual(original);
    await expectMissing(allowedPath);
    }
  );
});
