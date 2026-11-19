import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  listFiles,
  readText,
  resolveSafe,
  validateRelativePath
} from '../src/filesystem.js';
import { LIMITS } from '../src/types.js';

describe('filesystem', () => {
  let baseDirectory: string;
  let root: string;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-fs-')));
    root = path.join(baseDirectory, '授权 工程');
    await mkdir(root);
  });

  afterEach(async () => {
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

  it.each([
    '../secret.txt',
    '..\\secret.txt',
    '/absolute.txt',
    'C:\\absolute.txt',
    'C:relative.txt',
    '\\\\server\\share\\file.txt',
    'dir/file.txt:stream',
    'CON',
    'nul.txt',
    'folder/LPT1.log',
    'trailing.',
    'trailing ',
    'folder//file.txt',
    'folder/./file.txt',
    '%2e%2e/secret.txt',
    'folder\\file.txt'
  ])('rejects unsafe relative path %s', (unsafePath) => {
    expect(() => validateRelativePath(unsafePath)).toThrowError(
      expect.objectContaining({ code: 'PATH_INVALID' })
    );
  });

  it('accepts Unicode and spaces while preserving the relative path', () => {
    expect(validateRelativePath('场景/第一 章.txt')).toBe('场景/第一 章.txt');
    expect(validateRelativePath('')).toBe('');
  });

  it('reads UTF-8 text with spaces and Unicode from within the root', async () => {
    await mkdir(path.join(root, '场景'));
    await writeFile(path.join(root, '场景', '第一 章.txt'), '你好\n世界\n', 'utf8');

    const document = await readText(root, '场景/第一 章.txt');
    expect(document).toMatchObject({
      text: '你好\n世界\n',
      encoding: 'utf-8',
      newline: 'lf',
      bytes: Buffer.byteLength('你好\n世界\n'),
      source: 'disk'
    });
    expect(document.revision).toBe(
      createHash('sha256').update('你好\n世界\n').digest('hex')
    );
  });

  it('detects UTF-8 BOM and CRLF without returning the BOM in text', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('第一行\r\nsecond', 'utf8')
    ]);
    await writeFile(path.join(root, 'bom.txt'), bytes);

    const document = await readText(root, 'bom.txt');
    expect(document.text).toBe('第一行\r\nsecond');
    expect(document.encoding).toBe('utf-8-bom');
    expect(document.newline).toBe('crlf');
    expect(document.bytes).toBe(bytes.byteLength);
    expect(document.revision).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('handles empty files and mixed newlines', async () => {
    await writeFile(path.join(root, 'empty.txt'), '');
    const empty = await readText(root, 'empty.txt');
    expect(empty).toMatchObject({
      text: '',
      encoding: 'utf-8',
      newline: 'none',
      bytes: 0
    });

    await writeFile(path.join(root, 'mixed.txt'), 'a\r\nb\nc', 'utf8');
    expect((await readText(root, 'mixed.txt')).newline).toBe('mixed');
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['UTF-16 LE BOM', Buffer.from([0xff, 0xfe, 0x41, 0x00])],
    ['UTF-16 BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x41])],
    ['binary NUL', Buffer.from([0x61, 0x00, 0x62])],
    ['binary control byte', Buffer.from([0x61, 0x01, 0x62])]
  ])('rejects %s', async (_label, bytes) => {
    await writeFile(path.join(root, 'unsupported.txt'), bytes);
    await expectAppError(readText(root, 'unsupported.txt'), 'UNSUPPORTED_FORMAT');
  });

  it('rejects text above the byte limit', async () => {
    await writeFile(path.join(root, 'large.txt'), Buffer.alloc(LIMITS.textBytes + 1, 0x61));
    await expectAppError(readText(root, 'large.txt'), 'FILE_TOO_LARGE');
  });

  it('reports a missing file rather than treating it as empty', async () => {
    await expectAppError(readText(root, 'missing.txt'), 'FILE_NOT_FOUND');
    await expectAppError(listFiles(root, 'missing'), 'FILE_NOT_FOUND');
  });

  it('rejects a real junction that resolves outside the authorized root', async () => {
    const outside = `${root}-outside`;
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, path.join(root, 'escape'), 'junction');

    await expectAppError(resolveSafe(root, 'escape/secret.txt'), 'PATH_OUTSIDE_PROJECT');
    await expectAppError(readText(root, 'escape/secret.txt'), 'PATH_OUTSIDE_PROJECT');
  });

  it('rejects a canonical root path replaced by a junction after authorization', async () => {
    const original = `${root}-original`;
    const outside = `${root}-outside-replacement`;
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await rename(root, original);
    await symlink(outside, root, 'junction');

    await expectAppError(resolveSafe(root, 'secret.txt'), 'PROJECT_NOT_AUTHORIZED');
    await expectAppError(readText(root, 'secret.txt'), 'PROJECT_NOT_AUTHORIZED');
  });

  it('lists files deterministically relative to the supplied root and filters extensions', async () => {
    const sceneDirectory = path.join(root, 'game', 'scene');
    await mkdir(path.join(sceneDirectory, 'sub'), { recursive: true });
    await writeFile(path.join(sceneDirectory, 'z.txt'), 'z', 'utf8');
    await writeFile(path.join(sceneDirectory, 'A.txt'), 'A', 'utf8');
    await writeFile(path.join(sceneDirectory, 'skip.md'), 'skip', 'utf8');
    await writeFile(path.join(sceneDirectory, 'sub', 'b.TXT'), 'bb', 'utf8');
    await writeFile(path.join(sceneDirectory, 'sub', '中文 文件.txt'), '中', 'utf8');

    const entries = await listFiles(root, 'game/scene', ['txt']);
    expect(entries.map((entry) => entry.path)).toEqual([
      'game/scene/A.txt',
      'game/scene/sub/b.TXT',
      'game/scene/sub/中文 文件.txt',
      'game/scene/z.txt'
    ]);
    expect(entries.find((entry) => entry.path.endsWith('b.TXT'))).toMatchObject({
      size: 2,
      lastModified: expect.any(Number)
    });

    const repeated = await listFiles(root, 'game/scene', ['.TXT']);
    expect(repeated.map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
  });

  it('skips symlink entries while listing without following them outside the root', async () => {
    const outside = path.join(baseDirectory, 'outside-list');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await writeFile(path.join(root, 'local.txt'), 'local', 'utf8');
    await symlink(outside, path.join(root, 'escape'), 'junction');

    const entries = await listFiles(root, '', ['txt']);
    expect(entries.map((entry) => entry.path)).toEqual(['local.txt']);
  });

  it('handles Windows case-insensitive paths without escaping a similarly named sibling', async () => {
    const target = path.join(root, 'Scene.txt');
    const sibling = `${root}-other`;
    await writeFile(target, 'inside', 'utf8');
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'secret.txt'), 'outside', 'utf8');

    const resolved = await resolveSafe(root, process.platform === 'win32' ? 'scene.TXT' : 'Scene.txt');
    expect(resolved).toBe(await realpath(target));
    await expectAppError(resolveSafe(root, '../授权 工程-other/secret.txt'), 'PATH_INVALID');
  });
});
