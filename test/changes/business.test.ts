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
import { BusinessWriteService, type BusinessOperation } from '../../src/changes/business.js';
import { WriteCoordinator } from '../../src/changes/coordinator.js';
import { ProjectLocks } from '../../src/changes/locks.js';
import type { Attestation } from '../../src/changes/types.js';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';

const ownerId = 'owner';
const projectId = 'project';
const configPath = 'game/config.txt';
const startPath = 'game/scene/start.txt';
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
    throw new Error('Expected AppError ' + code);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    expect(appError.message).not.toContain('C:\\');
    return appError;
  }
}

describe('BusinessWriteService', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let sourceRoot: string;
  let stateRoot: string;
  let lockRoot: string;
  let config: AppConfig;
  let coordinator: WriteCoordinator;
  let service: BusinessWriteService;
  let originalConfig: Buffer;
  let originalScene: Buffer;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-business-')));
    projectRoot = path.join(baseDirectory, '工程 A');
    sourceRoot = path.join(baseDirectory, '素材 来源');
    stateRoot = path.join(baseDirectory, 'state');
    lockRoot = path.join(baseDirectory, 'locks');
    await mkdir(path.join(projectRoot, 'game', 'scene'), { recursive: true });
    await mkdir(path.join(projectRoot, 'game', 'background'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'assets'), { recursive: true });

    originalConfig = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Game_name:Old;\r\nUnknown_Key: keep;\r\nGame_key:abc;\r\n', 'utf8')
    ]);
    originalScene = Buffer.from('角色:你好;\r\n第二行\r\n', 'utf8');
    await writeFile(path.join(projectRoot, configPath), originalConfig);
    await writeFile(path.join(projectRoot, startPath), originalScene);

    config = {
      version: 1,
      projects: [{ id: projectId, root: projectRoot }],
      sources: [{ id: 'source', root: sourceRoot }]
    };
    coordinator = await WriteCoordinator.create(config, stateRoot, {
      locks: new ProjectLocks(lockRoot),
      capabilityCheck: async () => true,
      now: () => 1000
    });
    service = new BusinessWriteService(config, coordinator, ownerId);
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  function beginSession(paths: string[]) {
    return coordinator.sessions.begin(ownerId, projectId, attestation, paths);
  }

  async function readProjectFile(relative: string): Promise<Buffer> {
    return readFile(path.join(projectRoot, ...relative.split('/')));
  }

  it('returns a non-persisted draft without a handoff session', async () => {
    const review = await service.plan(projectId, undefined, [
      { type: 'create_scene', path: 'new.txt', text: '新场景\r\n' }
    ]);

    expect(review).toMatchObject({
      committable: false,
      planId: null,
      projectId,
      sessionId: null
    });
    expect(review.operations).toHaveLength(1);
    expect(review.operations[0]).toMatchObject({
      type: 'create_scene',
      path: 'game/scene/new.txt',
      beforeRevision: null
    });
    await expect(stat(path.join(projectRoot, 'game', 'scene', 'new.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(stateRoot, 'plans')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots the config at construction', async () => {
    config.projects[0]!.root = path.join(baseDirectory, 'missing-project');
    const review = await service.plan(projectId, undefined, [
      { type: 'create_scene', path: 'snapshot.txt', text: 'snapshot\r\n' }
    ]);

    expect(review.committable).toBe(false);
    expect(review.operations[0]?.path).toBe('game/scene/snapshot.txt');
  });

  it('preserves BOM and CRLF while editing only the config value span', async () => {
    const session = beginSession([configPath]);
    const review = await service.plan(projectId, session.id, [
      {
        type: 'edit_config',
        expectedRevision: hash(originalConfig),
        updates: [{ key: 'Game_name', value: 'New: Name' }]
      }
    ]);
    expect(review).toMatchObject({
      committable: true,
      projectId,
      sessionId: session.id
    });
    expect(review.planId).toEqual(expect.any(String));
    expect(review.operations[0]).toMatchObject({
      type: 'edit_config',
      path: configPath,
      beforeRevision: hash(originalConfig)
    });

    const expected = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Game_name:New: Name;\r\nUnknown_Key: keep;\r\nGame_key:abc;\r\n', 'utf8')
    ]);
    const applied = await service.apply(session.id, review.planId as string, 'config-1');
    expect(applied).toMatchObject({
      status: 'complete',
      replayed: false
    });
    expect(applied.operations[0]).toMatchObject({
      path: configPath,
      phase: 'applied',
      beforeRevision: hash(originalConfig),
      afterRevision: hash(expected),
      backupId: expect.any(String)
    });
    expect(applied.operations[0]).not.toHaveProperty('backup');
    expect(applied.operations[0]).not.toHaveProperty('expectedRevision');
    expect(applied.operations[0]).not.toHaveProperty('newRevision');

    expect(await readProjectFile(configPath)).toEqual(expected);
  });

  it('orders imports before scene creation and copies source bytes exactly', async () => {
    const sourceBytes = Buffer.from([0, 1, 2, 255, 10]);
    await writeFile(path.join(sourceRoot, 'assets', 'new.png'), sourceBytes);
    const session = beginSession(['game/background/new.png', 'game/scene/start2.txt']);
    const operations: BusinessOperation[] = [
      {
        type: 'create_scene',
        path: 'start2.txt',
        text: 'changeBg:new.png;\r\n'
      },
      {
        type: 'import_asset',
        kind: 'background',
        path: 'new.png',
        sourceId: 'source',
        sourcePath: 'assets/new.png',
        expectedSourceRevision: hash(sourceBytes)
      }
    ];

    const review = await service.plan(projectId, session.id, operations);
    expect(review.operations.map((operation) => operation.type)).toEqual([
      'import_asset',
      'create_scene'
    ]);
    expect(review.operations[0]).toMatchObject({
      path: 'game/background/new.png',
      sourceId: 'source',
      sourcePath: 'assets/new.png',
      sourceRevision: hash(sourceBytes)
    });
    expect(review.diagnostics).toEqual([]);

    const applied = await service.apply(session.id, review.planId as string, 'import-1');
    expect(applied.status).toBe('complete');
    expect(await readProjectFile('game/background/new.png')).toEqual(sourceBytes);
    expect(await readProjectFile('game/scene/start2.txt')).toEqual(
      Buffer.from('changeBg:new.png;\r\n', 'utf8')
    );
  });

  it('rejects a stale source before any target write', async () => {
    const sourceBytes = Buffer.from('original', 'utf8');
    const sourcePath = path.join(sourceRoot, 'assets', 'stale.png');
    await writeFile(sourcePath, sourceBytes);
    const session = beginSession(['game/background/stale.png']);
    const review = await service.plan(projectId, session.id, [{
      type: 'import_asset',
      kind: 'background',
      path: 'stale.png',
      sourceId: 'source',
      sourcePath: 'assets/stale.png',
      expectedSourceRevision: hash(sourceBytes)
    }]);

    await writeFile(sourcePath, Buffer.from('changed', 'utf8'));
    await expectAppError(
      service.apply(session.id, review.planId as string, 'stale-1'),
      'SOURCE_CHANGED'
    );
    await expect(stat(path.join(projectRoot, 'game', 'background', 'stale.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replays the same idempotency key without writing twice', async () => {
    const session = beginSession(['game/scene/replay.txt']);
    const review = await service.plan(projectId, session.id, [{
      type: 'create_scene',
      path: 'replay.txt',
      text: 'replay\r\n'
    }]);

    const first = await service.apply(session.id, review.planId as string, 'replay-key');
    const second = await service.apply(session.id, review.planId as string, 'replay-key');
    expect(first).toMatchObject({ status: 'complete', replayed: false });
    expect(second).toMatchObject({ status: 'complete', replayed: true });
    expect(await readProjectFile('game/scene/replay.txt'))
      .toEqual(Buffer.from('replay\r\n', 'utf8'));
  });

  it('rejects a target revision conflict with zero target writes', async () => {
    const session = beginSession([startPath]);
    const review = await service.plan(projectId, session.id, [{
      type: 'edit_scene',
      path: 'start.txt',
      expectedRevision: hash(originalScene),
      edits: [{ start: 3, end: 5, text: '您好' }]
    }]);

    const changed = Buffer.from('角色:后来;\r\n第二行\r\n', 'utf8');
    await writeFile(path.join(projectRoot, startPath), changed);
    await expectAppError(
      service.apply(session.id, review.planId as string, 'conflict-1'),
      'REVISION_CONFLICT'
    );
    expect(await readProjectFile(startPath)).toEqual(changed);
  });

  it('rejects duplicate target paths and bounds review text explicitly', async () => {
    await expectAppError(
      service.plan(projectId, undefined, [
        { type: 'create_scene', path: 'same.txt', text: 'a' },
        { type: 'create_scene', path: 'same.txt', text: 'b' }
      ]),
      'TARGET_COLLISION'
    );
    if (process.platform === 'win32') {
      await expectAppError(
        service.plan(projectId, undefined, [
          { type: 'create_scene', path: 'Case.txt', text: 'a' },
          { type: 'create_scene', path: 'case.txt', text: 'b' }
        ]),
        'TARGET_COLLISION'
      );
    }

    const review = await service.plan(projectId, undefined, [{
      type: 'create_scene',
      path: 'long.txt',
      text: 'a'.repeat(5000)
    }]);
    expect(review.operations[0]?.afterText).toHaveLength(1024);
    expect(review.operations[0]?.textTruncated).toBe(true);
  });

  it('reports a bounded diff around a change after the text preview window', async () => {
    const lateText = 'a'.repeat(5000) + 'OLD' + 'b'.repeat(100);
    const latePath = 'game/scene/late.txt';
    await writeFile(path.join(projectRoot, 'game', 'scene', 'late.txt'), lateText, 'utf8');

    const review = await service.plan(projectId, undefined, [{
      type: 'edit_scene',
      path: 'late.txt',
      expectedRevision: hash(Buffer.from(lateText, 'utf8')),
      edits: [{ start: 5000, end: 5003, text: 'NEW' }]
    }]);

    expect(review.operations[0]).toMatchObject({
      beforeText: 'a'.repeat(1024),
      afterText: 'a'.repeat(1024),
      textTruncated: true,
      diff: {
        start: 5000,
        before: 'OLD',
        after: 'NEW',
        truncated: false
      }
    });
    expect(await readProjectFile(latePath)).toEqual(Buffer.from(lateText, 'utf8'));
  });

  it('keeps emoji replacement diffs on whole Unicode surrogate pairs', async () => {
    const emojiPath = 'game/scene/emoji.txt';
    await writeFile(path.join(projectRoot, 'game', 'scene', 'emoji.txt'), '😀', 'utf8');
    const review = await service.plan(projectId, undefined, [{
      type: 'edit_scene',
      path: 'emoji.txt',
      expectedRevision: hash(Buffer.from('😀', 'utf8')),
      edits: [{ start: 0, end: 2, text: '😁' }]
    }]);

    expect(review.operations[0]?.diff).toMatchObject({
      start: 0,
      before: '😀',
      after: '😁',
      truncated: false
    });
    expect(review.operations[0]?.diff?.before.isWellFormed()).toBe(true);
    expect(review.operations[0]?.diff?.after.isWellFormed()).toBe(true);
    expect(await readProjectFile(emojiPath)).toEqual(Buffer.from('😀', 'utf8'));
  });
});
