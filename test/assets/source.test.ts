import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { canonicalProjectKey } from '../../src/changes/locks.js';
import { inspectSource, readSource } from '../../src/assets/source.js';
import type { AppConfig } from '../../src/types.js';
import { LIMITS } from '../../src/types.js';

let testBaseDirectory = '';

function digest(bytes: Uint8Array): string {
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
    expect(appError.message).not.toContain(testBaseDirectory);
    return appError;
  }
}

describe('source reads', () => {
  let baseDirectory: string;
  let sourceRoot: string;
  let outsideRoot: string;
  let config: AppConfig;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-source-')));
    testBaseDirectory = baseDirectory;
    sourceRoot = path.join(baseDirectory, '素材 来源');
    outsideRoot = path.join(baseDirectory, 'outside');
    await mkdir(path.join(sourceRoot, 'images', '子目录'), { recursive: true });
    await mkdir(outsideRoot);
    config = {
      version: 1,
      projects: [],
      sources: [{ id: 'source', root: sourceRoot }]
    };
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  function sourcePath(relative: string): string {
    return path.join(sourceRoot, ...relative.split('/'));
  }

  it('returns raw binary bytes, revision, and the canonical source root key', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const relative = 'images/子目录/素材.bin';
    await writeFile(sourcePath(relative), bytes);

    const result = await readSource(config, 'source', relative);
    expect(result.bytes).toEqual(bytes);
    expect(result.revision).toBe(digest(bytes));
    expect(result.rootKey).toBe(await canonicalProjectKey(sourceRoot));

    const inspected = await inspectSource(config, 'source', relative);
    expect(inspected).toEqual({
      sourceId: 'source',
      path: relative,
      revision: digest(bytes),
      bytes: bytes.byteLength
    });
    expect(Buffer.isBuffer(inspected.bytes)).toBe(false);
    expect(inspected).not.toHaveProperty('rootKey');
    expect(JSON.stringify(inspected)).not.toContain(baseDirectory);
  });

  it('distinguishes an empty file from a missing file', async () => {
    await writeFile(sourcePath('empty.bin'), Buffer.alloc(0));
    const empty = await readSource(config, 'source', 'empty.bin');
    expect(empty.bytes).toEqual(Buffer.alloc(0));
    expect(empty.revision).toBe(digest(Buffer.alloc(0)));
    expect((await inspectSource(config, 'source', 'empty.bin')).bytes).toBe(0);

    await expectAppError(readSource(config, 'source', 'missing.bin'), 'FILE_NOT_FOUND');
  });

  it('only accepts registered source ids', async () => {
    const projectOnly: AppConfig = {
      version: 1,
      projects: [{ id: 'project', root: sourceRoot }],
      sources: []
    };
    await expectAppError(readSource(projectOnly, 'project', 'file.bin'), 'SOURCE_NOT_AUTHORIZED');
    await expectAppError(readSource(config, 'missing', 'file.bin'), 'SOURCE_NOT_AUTHORIZED');
    await expectAppError(readSource(config, '', 'file.bin'), 'SOURCE_NOT_AUTHORIZED');
    await expectAppError(
      readSource(config, 42 as unknown as string, 'file.bin'),
      'SOURCE_NOT_AUTHORIZED'
    );
  });

  it.each([
    '',
    '../outside.bin',
    '..\\outside.bin',
    '/absolute.bin',
    'C:\\absolute.bin',
    'C:relative.bin',
    '\\\\server\\share\\file.bin',
    'folder\\file.bin',
    '%2e%2e/outside.bin',
    'CON',
    'trailing.',
    'folder//file.bin'
  ])('rejects unsafe relative path %s', async (relative) => {
    await expectAppError(readSource(config, 'source', relative), 'PATH_INVALID');
  });

  it('rejects non-regular targets and non-directory path components', async () => {
    await mkdir(sourcePath('directory'));
    await expectAppError(readSource(config, 'source', 'directory'), 'FILE_NOT_REGULAR');

    await writeFile(sourcePath('not-a-directory'), 'file', 'utf8');
    await expectAppError(
      readSource(config, 'source', 'not-a-directory/file.bin'),
      'FILE_NOT_DIRECTORY'
    );
  });

  it('rejects symlinks and junctions both outside and inside the source root', async () => {
    await writeFile(path.join(outsideRoot, 'secret.bin'), Buffer.from([1, 2, 3]));
    await writeFile(sourcePath('images/inside.bin'), Buffer.from([4, 5, 6]));
    await symlink(outsideRoot, sourcePath('escape'), 'junction');
    await symlink(path.join(sourceRoot, 'images'), sourcePath('alias'), 'junction');

    await expectAppError(
      readSource(config, 'source', 'escape/secret.bin'),
      'PATH_INVALID'
    );
    await expectAppError(
      readSource(config, 'source', 'alias/inside.bin'),
      'PATH_INVALID'
    );
  });

  it('rejects non-canonical roots and detects root replacement through rootKey', async () => {
    const linkedRoot = path.join(baseDirectory, 'linked-source');
    await symlink(sourceRoot, linkedRoot, 'junction');
    const linkedConfig: AppConfig = {
      version: 1,
      projects: [],
      sources: [{ id: 'source', root: linkedRoot }]
    };
    await expectAppError(
      readSource(linkedConfig, 'source', 'images/inside.bin'),
      'SOURCE_NOT_AUTHORIZED'
    );

    const fileRoot = path.join(baseDirectory, 'source-file');
    await writeFile(fileRoot, 'not a directory', 'utf8');
    const fileConfig: AppConfig = {
      version: 1,
      projects: [],
      sources: [{ id: 'source', root: fileRoot }]
    };
    await expectAppError(
      readSource(fileConfig, 'source', 'file.bin'),
      'SOURCE_NOT_AUTHORIZED'
    );

    const relative = 'images/inside.bin';
    await writeFile(sourcePath(relative), Buffer.from('old'));
    const first = await readSource(config, 'source', relative);
    const movedRoot = path.join(baseDirectory, 'source-moved');
    await rename(sourceRoot, movedRoot);
    await mkdir(path.join(sourceRoot, 'images'), { recursive: true });
    await writeFile(sourcePath(relative), Buffer.from('new'));
    const second = await readSource(config, 'source', relative);
    expect(second.rootKey).toBe(first.rootKey);
    expect(second.bytes).toEqual(Buffer.from('new'));

    const replacedRoot = path.join(baseDirectory, 'source-replaced');
    await rename(sourceRoot, replacedRoot);
    await symlink(outsideRoot, sourceRoot, 'junction');
    await expectAppError(
      readSource(config, 'source', relative),
      'SOURCE_NOT_AUTHORIZED'
    );
  });

  it('enforces the 1 MiB binary read limit', async () => {
    await writeFile(sourcePath('at-limit.bin'), Buffer.alloc(LIMITS.textBytes, 0xab));
    const result = await readSource(config, 'source', 'at-limit.bin');
    expect(result.bytes.byteLength).toBe(LIMITS.textBytes);
    expect((await inspectSource(config, 'source', 'at-limit.bin')).bytes)
      .toBe(LIMITS.textBytes);

    await writeFile(
      sourcePath('over-limit.bin'),
      Buffer.alloc(LIMITS.textBytes + 1, 0xcd)
    );
    await expectAppError(
      readSource(config, 'source', 'over-limit.bin'),
      'FILE_TOO_LARGE'
    );
  });
});
