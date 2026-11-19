import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WriteCoordinator } from '../../src/changes/coordinator.js';
import { ProjectLocks } from '../../src/changes/locks.js';
import { publishTarget, stagingRelative } from '../../src/changes/targets.js';
import { AppError } from '../../src/errors.js';
import { WRITE_LIMITS, type BatchRecord } from '../../src/changes/types.js';
import type { AppConfig } from '../../src/types.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const target = 'game/scene/a.txt';
const attestation = { source: 'user-message' as const, statement: 'Saved and left this temporary test project.' };

describe('coordinator state integrity', () => {
  let base: string;
  let root: string;
  let coordinator: WriteCoordinator;
  let sessionId: string;
  let config: AppConfig;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'wgmcp-safety-')));
    root = path.join(base, 'project');
    await mkdir(path.join(root, 'game', 'scene'), { recursive: true });
    await writeFile(path.join(root, target), 'original');
    config = { version: 1, projects: [{ id: 'test', root }], sources: [] };
    coordinator = await WriteCoordinator.create(config, path.join(base, 'state'), {
      locks: new ProjectLocks(path.join(base, 'locks')), capabilityCheck: async () => true
    });
    sessionId = coordinator.sessions.begin('owner', 'test', attestation, [target]).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  async function completed() {
    const plan = await coordinator.plan('owner', sessionId, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('updated') }]);
    const result = await coordinator.apply('owner', sessionId, plan.id, 'test-key');
    expect(result.status).toBe('complete');
    return { plan, result };
  }

  it('rejects changed plan payload without modifying any target', async () => {
    const plan = await coordinator.plan('owner', sessionId, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('updated') }]);
    plan.operations[0].data = Buffer.from('altered').toString('base64');
    await coordinator.store.replaceJson(`plans/${plan.id}.json`, plan);
    await expect(coordinator.apply('owner', sessionId, plan.id, 'key')).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('original');
  });

  it('does not report an inconsistent complete journal as a completed replay', async () => {
    const { result, plan } = await completed();
    const journal = `batches/${result.batchId}/journal.json`;
    const record = await coordinator.store.readJson<BatchRecord>(journal);
    record.operations[0].phase = 'pending';
    await coordinator.store.replaceJson(journal, record);
    await expect(coordinator.apply('owner', sessionId, plan.id, 'test-key')).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('updated');
  });

  it('detects backup corruption and refuses restoring it', async () => {
    const { result } = await completed();
    await writeFile(path.join(coordinator.store.root, result.operations[0].backup!), 'corrupt');
    expect((await coordinator.inspect('test', result.batchId)).operations[0]).toMatchObject({ backupVerified: false, canRestore: false });
    await expect(coordinator.restore('owner', sessionId, 'test', result.batchId, [{ path: target, expectedRevision: hash('updated') }], 'restore')).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('updated');
  });

  it('rechecks backup bytes after inspection before constructing a restore plan', async () => {
    const { result } = await completed();
    const originalRead = coordinator.store.readBackup.bind(coordinator.store);
    let reads = 0;
    vi.spyOn(coordinator.store, 'readBackup').mockImplementation(async relative => {
      reads++;
      return reads === 1 ? originalRead(relative) : Buffer.from('changed after inspection');
    });
    await expect(coordinator.restore('owner', sessionId, 'test', result.batchId, [{ path: target, expectedRevision: hash('updated') }], 'restore')).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('updated');
  });

  it('reports leftover staging without reading it or deleting it', async () => {
    const { result } = await completed();
    const staging = path.join(root, stagingRelative(target, result.batchId, 0));
    await writeFile(staging, 'retained crash evidence');
    expect((await coordinator.inspect('test', result.batchId)).operations[0].stagingPresent).toBe(true);
    expect(await readFile(staging, 'utf8')).toBe('retained crash evidence');
    expect(await readFile(path.join(root, target), 'utf8')).toBe('updated');
  });

  it('rejects total payload limits before storing a plan or writing any target', async () => {
    const changes = Array.from({ length: 5 }, (_, index) => ({ path: `game/scene/${index}.txt`, expectedRevision: null, bytes: Buffer.alloc(WRITE_LIMITS.maxFileBytes) }));
    await expect(coordinator.plan('owner', sessionId, 'test', changes)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await coordinator.pending('test')).batches).toEqual([]);
    expect(await readFile(path.join(root, target), 'utf8')).toBe('original');
  });

  it('never enables offline writes through its default capability gate', async () => {
    const guarded = await WriteCoordinator.create(config, path.join(base, 'guarded-state'), { locks: coordinator.locks });
    const session = guarded.sessions.begin('owner', 'test', attestation, [target]);
    const plan = await guarded.plan('owner', session.id, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('updated') }]);
    await expect(guarded.apply('owner', session.id, plan.id, 'key')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('original');
  });

  it('rechecks authorization after staging and cleans only its own temporary file', async () => {
    const authorize = vi.fn(() => { throw new AppError('SESSION_EXPIRED', 'Expired during staging.'); });
    await expect(publishTarget(root, target, hash('original'), Buffer.from('updated'), '11111111-1111-4111-8111-111111111111', 0, authorize)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(await readFile(path.join(root, target), 'utf8')).toBe('original');
    expect(await readdir(path.join(root, 'game', 'scene'))).toEqual(['a.txt']);
  });

  it('rechecks all targets after backups before changing any target', async () => {
    await writeFile(path.join(root, 'game/config.txt'), 'old config');
    const guarded = await WriteCoordinator.create(config, path.join(base, 'guarded-state'), {
      locks: coordinator.locks, capabilityCheck: async () => true,
      fault: async point => { if (point === 'after-backups') await writeFile(path.join(root, target), 'human edit'); }
    });
    const session = guarded.sessions.begin('owner', 'test', attestation, ['game/config.txt', target]);
    const plan = await guarded.plan('owner', session.id, 'test', [
      { path: 'game/config.txt', expectedRevision: hash('old config'), bytes: Buffer.from('new config') },
      { path: target, expectedRevision: hash('original'), bytes: Buffer.from('updated') }
    ]);
    expect(await guarded.apply('owner', session.id, plan.id, 'key')).toMatchObject({ status: 'failed', errorCode: 'REVISION_CONFLICT' });
    expect(await readFile(path.join(root, 'game/config.txt'), 'utf8')).toBe('old config');
    expect(await readFile(path.join(root, target), 'utf8')).toBe('human edit');
  });

  it('keeps independent project locks and handoffs separate while one batch is busy', async () => {
    const otherRoot = path.join(base, 'other-project');
    await mkdir(path.join(otherRoot, 'game/scene'), { recursive: true });
    await writeFile(path.join(otherRoot, target), 'other original');
    const multiple: AppConfig = { ...config, projects: [...config.projects, { id: 'other', root: otherRoot }] };
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const busy = await WriteCoordinator.create(multiple, path.join(base, 'busy-state'), {
      locks: coordinator.locks, capabilityCheck: async () => true,
      fault: async point => { if (point === 'after-lock') { entered(); await held; } }
    });
    const independent = await WriteCoordinator.create(multiple, path.join(base, 'independent-state'), { locks: new ProjectLocks(path.join(base, 'locks')), capabilityCheck: async () => true });
    const firstSession = busy.sessions.begin('owner', 'test', attestation, [target]);
    const sameSession = independent.sessions.begin('owner', 'test', attestation, [target]);
    const otherSession = independent.sessions.begin('owner', 'other', attestation, [target]);
    const firstPlan = await busy.plan('owner', firstSession.id, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('first') }]);
    const contender = await independent.plan('owner', sameSession.id, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('second') }]);
    await expect(independent.plan('owner', sameSession.id, 'other', [{ path: target, expectedRevision: hash('other original'), bytes: Buffer.from('invalid') }])).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    const otherPlan = await independent.plan('owner', otherSession.id, 'other', [{ path: target, expectedRevision: hash('other original'), bytes: Buffer.from('other updated') }]);
    const applying = busy.apply('owner', firstSession.id, firstPlan.id, 'first');
    try {
      await ready;
      await expect(independent.apply('owner', sameSession.id, contender.id, 'second')).rejects.toMatchObject({ code: 'LOCKED' });
      expect(await independent.apply('owner', otherSession.id, otherPlan.id, 'other')).toMatchObject({ status: 'complete' });
      expect(await readFile(path.join(root, target), 'utf8')).toBe('original');
    } finally { release(); }
    expect(await applying).toMatchObject({ status: 'complete' });
    await expect(independent.apply('owner', sameSession.id, contender.id, 'second')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('first');
    expect(await readFile(path.join(otherRoot, target), 'utf8')).toBe('other updated');
  });

  it('reports completed writes with a warning when its lock cannot be released', async () => {
    const guarded = await WriteCoordinator.create(config, path.join(base, 'guarded-state'), {
      locks: coordinator.locks, capabilityCheck: async () => true,
      fault: async point => {
        if (point === 'before-complete') {
          const [name] = await readdir(path.join(base, 'locks'));
          await writeFile(path.join(base, 'locks', name), JSON.stringify({ token: 'externally-replaced', pid: process.pid, instanceId: 'other-instance' }));
        }
      }
    });
    const session = guarded.sessions.begin('owner', 'test', attestation, [target]);
    const plan = await guarded.plan('owner', session.id, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('updated') }]);
    const result = await guarded.apply('owner', session.id, plan.id, 'key');
    expect(result).toMatchObject({ status: 'complete', warnings: ['LOCK_RELEASE_FAILED'] });
    expect((await guarded.inspect('test', result.batchId)).status).toBe('complete');
    expect(await readFile(path.join(root, target), 'utf8')).toBe('updated');
    expect(await guarded.locks.inspect(root)).toMatchObject({ locked: true, token: 'externally-replaced' });
    expect(() => guarded.sessions.require(session.id, 'owner', 'test', [target])).toThrow();
  });

  it('records key reservation failure before backups or target writes', async () => {
    const create = coordinator.store.createJson.bind(coordinator.store);
    vi.spyOn(coordinator.store, 'createJson').mockImplementation(async (relative, value) => {
      if (relative.startsWith('keys/')) throw new AppError('STATE_WRITE_FAILED', 'Injected key reservation failure.');
      await create(relative, value);
    });
    const plan = await coordinator.plan('owner', sessionId, 'test', [{ path: target, expectedRevision: hash('original'), bytes: Buffer.from('updated') }]);
    const result = await coordinator.apply('owner', sessionId, plan.id, 'key');
    expect(result).toMatchObject({ status: 'failed', errorCode: 'STATE_WRITE_FAILED' });
    expect((await coordinator.pending('test')).batches[0]).toMatchObject({ batchId: result.batchId, status: 'failed' });
    expect(await readFile(path.join(root, target), 'utf8')).toBe('original');
  });
});
