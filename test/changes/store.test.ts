import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';
import { StateStore } from '../../src/changes/store.js';
import { WRITE_LIMITS } from '../../src/changes/types.js';

const fsFaults = vi.hoisted(() => ({
  syncError: null as Error | null
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle: Awaited<ReturnType<typeof actual.open>> =
        await Reflect.apply(actual.open, actual, args);
      if (fsFaults.syncError) {
        const originalSync = handle.sync.bind(handle);
        Object.defineProperty(handle, 'sync', {
          configurable: true,
          value: async () => {
            const error = fsFaults.syncError;
            fsFaults.syncError = null;
            if (error) {
              throw error;
            }
            await originalSync();
          }
        });
      }
      return handle;
    }
  };
});

function keyRelative(
  namespace = 'a'.repeat(64),
  digest = 'b'.repeat(64)
): string {
  return `keys/${namespace}/${digest}.json`;
}

function planRelative(batchId = randomUUID()): string {
  return `plans/${batchId}.json`;
}

function journalRelative(batchId = randomUUID()): string {
  return `batches/${batchId}/journal.json`;
}

describe('StateStore', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let sourceRoot: string;
  let stateRoot: string;
  let config: AppConfig;
  let store: StateStore;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-store-')));
    projectRoot = path.join(baseDirectory, '工程 A');
    sourceRoot = path.join(baseDirectory, '素材 来源');
    stateRoot = path.join(baseDirectory, 'mcp state');
    await mkdir(projectRoot);
    await mkdir(sourceRoot);
    config = {
      version: 1,
      projects: [{ id: 'project', root: projectRoot }],
      sources: [{ id: 'source', root: sourceRoot }]
    };
    store = await StateStore.create(stateRoot, config);
  });

  afterEach(async () => {
    fsFaults.syncError = null;
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

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
      expect(appError.message).not.toContain(baseDirectory);
      return appError;
    }
  }

  function absolute(relative: string): string {
    return path.join(store.root, ...relative.split('/'));
  }

  it('creates a canonical private root and nested metadata directories', async () => {
    expect(store.root).toBe(await realpath(stateRoot));
    const keyDirectory = `keys/${'a'.repeat(64)}`;
    await store.ensureDirectory(keyDirectory);
    expect((await stat(absolute(keyDirectory))).isDirectory()).toBe(true);

    if (process.platform !== 'win32') {
      expect((await stat(store.root)).mode & 0o777).toBe(0o700);
      expect((await stat(absolute('keys'))).mode & 0o777).toBe(0o700);
    }
  });

  it('creates JSON without overwriting and replaces only existing metadata', async () => {
    const plan = planRelative();
    await store.createJson(plan, {
      title: '第一章',
      nested: { enabled: true }
    });
    expect(await store.readJson(plan)).toEqual({
      title: '第一章',
      nested: { enabled: true }
    });

    await expectAppError(
      store.createJson(plan, { title: 'replacement' }),
      'TARGET_EXISTS'
    );
    expect(await store.readJson(plan)).toMatchObject({ title: '第一章' });

    await store.replaceJson(plan, { title: '第二章', count: 2 });
    expect(await store.readJson(plan)).toEqual({ title: '第二章', count: 2 });
    await expectAppError(store.replaceJson(planRelative(), {}), 'FILE_NOT_FOUND');
    await expectAppError(store.readJson(planRelative()), 'STATE_NOT_FOUND');

    if (process.platform !== 'win32') {
      expect((await stat(absolute(plan))).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts only key, plan, and journal metadata paths', async () => {
    const key = keyRelative();
    const plan = planRelative();
    const journal = journalRelative();
    await store.createJson(key, { key: true });
    await store.createJson(plan, { plan: true });
    await store.createJson(journal, { journal: true });
    expect(await store.readJson(key)).toEqual({ key: true });
    expect(await store.readJson(plan)).toEqual({ plan: true });
    expect(await store.readJson(journal)).toEqual({ journal: true });

    await expectAppError(store.createJson('records/one.txt', {}), 'INVALID_ARGUMENT');
    await expectAppError(store.replaceJson('records/one.txt', {}), 'INVALID_ARGUMENT');
    await expectAppError(store.createJson('keys/not-a-hash/not-a-hash.json', {}), 'INVALID_ARGUMENT');
  });

  it.each([
    '../escape.json',
    '..\\escape.json',
    'C:escape.json',
    '\\\\server\\share\\escape.json',
    'records/escape.json:stream',
    'records/%2e%2e/escape.json',
    'CON.json'
  ])('rejects unsafe state path %s', async (unsafePath) => {
    await expectAppError(store.createJson(unsafePath, {}), 'PATH_INVALID');
  });

  it('rejects symlinked path components and symlinked metadata targets', async () => {
    const outside = path.join(baseDirectory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'target.json'), '{"outside":true}', 'utf8');
    await symlink(outside, path.join(store.root, 'keys'), 'junction');

    await expectAppError(store.createJson(keyRelative(), {}), 'PATH_INVALID');

    await store.ensureDirectory('plans');
    const linkedPlan = planRelative();
    await symlink(outside, absolute(linkedPlan), 'junction');
    await expectAppError(store.readJson(linkedPlan), 'PATH_INVALID');
    await expectAppError(store.replaceJson(linkedPlan, {}), 'PATH_INVALID');
  });

  it('enforces the metadata size limit before writing and while reading', async () => {
    const oversizedValue = 'a'.repeat(WRITE_LIMITS.maxRecordBytes);
    const oversizedPlan = planRelative();
    await expectAppError(
      store.createJson(oversizedPlan, oversizedValue),
      'FILE_TOO_LARGE'
    );
    await expect(stat(absolute(oversizedPlan))).rejects.toMatchObject({
      code: 'ENOENT'
    });

    const oversizedRead = planRelative();
    await store.ensureDirectory('plans');
    await writeFile(
      absolute(oversizedRead),
      Buffer.alloc(WRITE_LIMITS.maxRecordBytes + 1, 0x20)
    );
    await expectAppError(store.readJson(oversizedRead), 'FILE_TOO_LARGE');
  });

  it('rejects invalid UTF-8 and malformed JSON with stable format errors', async () => {
    await store.ensureDirectory('plans');
    const invalidUtf8 = planRelative();
    await writeFile(
      absolute(invalidUtf8),
      Buffer.from([0x7b, 0xff, 0x7d])
    );
    await expectAppError(store.readJson(invalidUtf8), 'UNSUPPORTED_FORMAT');

    const malformed = planRelative();
    await writeFile(absolute(malformed), '{', 'utf8');
    await expectAppError(store.readJson(malformed), 'UNSUPPORTED_FORMAT');
  });

  it('writes backups create-only and reads them within the binary limit', async () => {
    const batchId = randomUUID();
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    const relative = await store.writeBackup(batchId, 0, bytes);
    expect(relative).toBe(`batches/${batchId}/backups/0.bin`);
    expect(await store.readBackup(relative)).toEqual(bytes);

    await expectAppError(
      store.writeBackup(batchId, 0, Buffer.from([9])),
      'TARGET_EXISTS'
    );
    expect(await store.readBackup(relative)).toEqual(bytes);
    await expectAppError(store.replaceJson(relative, {}), 'INVALID_ARGUMENT');
    await expectAppError(store.readBackup('batches/not-a-uuid/backups/0.bin'), 'INVALID_ARGUMENT');
    await expectAppError(store.readBackup(planRelative()), 'INVALID_ARGUMENT');
  });

  it('enforces backup bounds and regular-file reads', async () => {
    const batchId = randomUUID();
    await expectAppError(
      store.writeBackup(batchId, 0, Buffer.alloc(WRITE_LIMITS.maxFileBytes + 1)),
      'FILE_TOO_LARGE'
    );

    const relative = `batches/${batchId}/backups/0.bin`;
    const target = path.join(store.root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(WRITE_LIMITS.maxFileBytes + 1));
    await expectAppError(store.readBackup(relative), 'FILE_TOO_LARGE');

    await rm(target);
    await mkdir(target);
    await expectAppError(store.readBackup(relative), 'FILE_NOT_REGULAR');
  });

  it('rejects a state root inside a configured project root', async () => {
    const nestedStateRoot = path.join(projectRoot, 'state');
    await expectAppError(StateStore.create(nestedStateRoot, config), 'STATE_ROOT_OVERLAP');
    await expect(stat(nestedStateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a state root that contains a configured project or source root', async () => {
    const container = path.join(baseDirectory, 'container');
    const nestedProject = path.join(container, 'project');
    const nestedSource = path.join(container, 'source');
    await mkdir(nestedProject, { recursive: true });
    await mkdir(nestedSource, { recursive: true });
    const nestedConfig: AppConfig = {
      version: 1,
      projects: [{ id: 'project', root: nestedProject }],
      sources: [{ id: 'source', root: nestedSource }]
    };

    await expectAppError(StateStore.create(container, nestedConfig), 'STATE_ROOT_OVERLAP');
  });

  it('resolves a missing root through its nearest real parent before overlap checks', async () => {
    const projectLink = path.join(baseDirectory, 'project-link');
    await symlink(projectRoot, projectLink, 'junction');
    const linkedStateRoot = path.join(projectLink, 'state');

    await expectAppError(StateStore.create(linkedStateRoot, config), 'STATE_ROOT_OVERLAP');
    await expect(stat(path.join(projectRoot, 'state'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a lexical state path inside a project even when a junction resolves elsewhere', async () => {
    const outside = path.join(baseDirectory, 'outside-state');
    const projectEscape = path.join(projectRoot, 'escape');
    await mkdir(outside);
    await symlink(outside, projectEscape, 'junction');

    await expectAppError(
      StateStore.create(path.join(projectEscape, 'state'), config),
      'STATE_ROOT_OVERLAP'
    );
  });

  it('rejects a canonical root replaced by a junction after authorization', async () => {
    const rootCheck = planRelative();
    await store.createJson(rootCheck, { valid: true });
    const original = `${store.root}-original`;
    const outside = path.join(baseDirectory, 'replacement');
    await mkdir(outside);
    await rename(store.root, original);
    await symlink(outside, store.root, 'junction');

    await expectAppError(store.readJson(rootCheck), 'STATE_ROOT_CHANGED');
    await expectAppError(store.createJson(planRelative(), {}), 'STATE_ROOT_CHANGED');
  });

  it('lists only UUID batch directories in deterministic order', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    await store.createJson(journalRelative(second), { status: 'applying' });
    await store.writeBackup(first, 0, Buffer.from('backup'));
    await store.ensureDirectory('batches/not-a-uuid');
    await store.createJson(planRelative(), { plan: true });

    expect(await store.listBatchIds()).toEqual([first, second]);
  });

  it('rejects symlinked UUID batch directories while listing', async () => {
    const batchId = randomUUID();
    const outside = path.join(baseDirectory, 'outside-batch');
    await mkdir(outside);
    await store.ensureDirectory('batches');
    await symlink(outside, absolute(`batches/${batchId}`), 'junction');

    await expectAppError(store.listBatchIds(), 'PATH_INVALID');
  });

  it('rejects more than 1024 batch directory entries', async () => {
    const batches = absolute('batches');
    await mkdir(batches);
    await Promise.all(
      Array.from({ length: 1025 }, () => mkdir(path.join(batches, randomUUID())))
    );

    await expectAppError(store.listBatchIds(), 'LIMIT_EXCEEDED');
  });

  it('maps an injected sync failure to BACKUP_FAILED and removes only the new backup', async () => {
    const batchId = randomUUID();
    fsFaults.syncError = new Error('injected sync failure');

    await expectAppError(store.writeBackup(batchId, 0, Buffer.from('backup')), 'BACKUP_FAILED');
    await expect(
      stat(path.join(store.root, 'batches', batchId, 'backups', '0.bin'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
