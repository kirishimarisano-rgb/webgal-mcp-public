import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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
import {
  assertWritePath,
  publishTarget,
  snapshotTarget,
  stagingRelative
} from '../../src/changes/targets.js';
import { WRITE_LIMITS } from '../../src/changes/types.js';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const POWERSHELL_PATH = 'C:/Program Files/PowerShell/7/pwsh.exe';

function expectAppError(operation: () => Promise<unknown>, code: string): Promise<AppError> {
  return operation().then(
    () => {
      throw new Error(`Expected AppError ${code}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(code);
      return appError;
    }
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function temporaryNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('.wgmcp-') && name.endsWith('.tmp'));
}

describe('write targets', () => {
  let baseDirectory: string;
  let root: string;
  let sceneDirectory: string;
  let configPath: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-targets-')));
    root = path.join(baseDirectory, 'Project');
    sceneDirectory = path.join(root, 'game', 'scene');
    configPath = path.join(root, 'game', 'config.txt');
    await mkdir(sceneDirectory, { recursive: true });
    await mkdir(path.join(root, 'game', 'background'), { recursive: true });
    await writeFile(configPath, 'config', 'utf8');
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.stdin.end('close\n');
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
      }
    }
    children.length = 0;
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  it('allows only supported scene, config, and asset write targets', () => {
    expect(assertWritePath('game/scene/start.txt', true)).toBe('game/scene/start.txt');
    expect(assertWritePath('game/scene/sub/start.txt', false)).toBe('game/scene/sub/start.txt');
    expect(assertWritePath('game/config.txt', false)).toBe('game/config.txt');
    expect(assertWritePath('game/background/bg.png', true)).toBe('game/background/bg.png');
    expect(assertWritePath('game/figure/a.webp', true)).toBe('game/figure/a.webp');
    expect(assertWritePath('game/bgm/theme.ogg', true)).toBe('game/bgm/theme.ogg');
    expect(assertWritePath('game/vocal/voice.ogg', true)).toBe('game/vocal/voice.ogg');
    expect(assertWritePath('game/video/op.mp4', true)).toBe('game/video/op.mp4');

    expect(() => assertWritePath('game/config.txt', true)).toThrowError(
      expect.objectContaining({ code: 'PATH_INVALID' })
    );
    expect(() => assertWritePath('game/background/bg.png', false)).toThrowError(
      expect.objectContaining({ code: 'PATH_INVALID' })
    );

    for (const invalid of [
      'game/scene/start.md',
      'game/scene/start.TXT',
      'game/scene/.hidden.txt',
      'game/.hidden/start.txt',
      'game/scene/../start.txt',
      'game/scene/%2e%2e/start.txt',
      'game/scene/start.txt:stream',
      'game/scene/start\\file.txt',
      'Game/scene/start.txt',
      'game/scene',
      'game/scene/',
      'assets/background/bg.png',
      '../game/scene/start.txt',
      '/game/scene/start.txt',
      'game/scene/start.txt '
    ]) {
      expect(() => assertWritePath(invalid, true)).toThrowError(
        expect.objectContaining({ code: 'PATH_INVALID' })
      );
      expect(() => assertWritePath(invalid, false)).toThrowError(
        expect.objectContaining({ code: 'PATH_INVALID' })
      );
    }
  });

  it('returns deterministic same-directory staging paths and validates batch metadata', () => {
    expect(stagingRelative('game/scene/start.txt', BATCH_ID, 3))
      .toBe(`game/scene/.wgmcp-${BATCH_ID}-3.tmp`);
    expect(stagingRelative('game/config.txt', BATCH_ID.toUpperCase(), 0))
      .toBe(`game/.wgmcp-${BATCH_ID}-0.tmp`);

    expect(() => stagingRelative('game/scene/start.txt', 'not-a-uuid', 0))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => stagingRelative('game/scene/start.txt', BATCH_ID, -1))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => stagingRelative('game/scene/start.txt', BATCH_ID, WRITE_LIMITS.maxFiles))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('returns null for a missing target without creating its parent', async () => {
    expect(await snapshotTarget(root, 'game/scene/missing.txt')).toEqual({
      revision: null,
      bytes: null
    });
    expect(await pathExists(path.join(root, 'game', 'scene'))).toBe(true);

    await rm(sceneDirectory, { recursive: true });
    await expectAppError(
      () => snapshotTarget(root, 'game/scene/missing.txt'),
      'FILE_NOT_FOUND'
    );
    expect(await pathExists(sceneDirectory)).toBe(false);
  });

  it('creates a new scene atomically and never overwrites an existing target', async () => {
    const relative = 'game/scene/start.txt';
    const target = path.join(sceneDirectory, 'start.txt');
    const bytes = Buffer.from('first', 'utf8');

    await publishTarget(root, relative, null, bytes, BATCH_ID, 0);
    expect(await readFile(target)).toEqual(bytes);
    expect(await temporaryNames(sceneDirectory)).toEqual([]);

    await expectAppError(
      () => publishTarget(root, relative, null, Buffer.from('second'), BATCH_ID, 1),
      'TARGET_EXISTS'
    );
    expect(await readFile(target)).toEqual(bytes);
    expect(await temporaryNames(sceneDirectory)).toEqual([]);
  });

  it('replaces a scene only when its revision still matches', async () => {
    const relative = 'game/scene/start.txt';
    const target = path.join(sceneDirectory, 'start.txt');
    const original = Buffer.from('original', 'utf8');
    const replacement = Buffer.from('replacement', 'utf8');
    await writeFile(target, original);

    const snapshot = await snapshotTarget(root, relative);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.bytes).toEqual(original);
    await publishTarget(
      root,
      relative,
      snapshot.revision,
      replacement,
      BATCH_ID,
      0
    );

    expect(await readFile(target)).toEqual(replacement);
    expect(await temporaryNames(sceneDirectory)).toEqual([]);
  });

  it('replaces config.txt only through the revision-checked path', async () => {
    const original = Buffer.from('title=old\r\n', 'utf8');
    const replacement = Buffer.from('title=new\r\n', 'utf8');
    await writeFile(configPath, original);

    const revision = (await snapshotTarget(root, 'game/config.txt')).revision;
    await publishTarget(
      root,
      'game/config.txt',
      revision,
      replacement,
      BATCH_ID,
      0
    );

    expect(await readFile(configPath)).toEqual(replacement);
    expect(await temporaryNames(path.join(root, 'game'))).toEqual([]);
  });

  it('rejects a stale revision with zero target writes and cleans its staging file', async () => {
    const relative = 'game/scene/start.txt';
    const target = path.join(sceneDirectory, 'start.txt');
    const original = Buffer.from('original', 'utf8');
    await writeFile(target, original);

    await expectAppError(
      () => publishTarget(
        root,
        relative,
        '0'.repeat(64),
        Buffer.from('replacement'),
        BATCH_ID,
        0
      ),
      'REVISION_CONFLICT'
    );
    expect(await readFile(target)).toEqual(original);
    expect(await temporaryNames(sceneDirectory)).toEqual([]);
  });

  it('rejects a pre-existing staging path without deleting or overwriting it', async () => {
    const relative = 'game/scene/start.txt';
    const target = path.join(sceneDirectory, 'start.txt');
    const staging = path.join(
      root,
      ...stagingRelative(relative, BATCH_ID, 0).split('/')
    );
    const sentinel = Buffer.from('foreign staging file');
    await writeFile(staging, sentinel);

    await expectAppError(
      () => publishTarget(root, relative, null, Buffer.from('new'), BATCH_ID, 0),
      'STAGING_EXISTS'
    );
    expect(await pathExists(target)).toBe(false);
    expect(await readFile(staging)).toEqual(sentinel);
  });

  it('rejects missing parents for snapshot and publication without creating them', async () => {
    await rm(sceneDirectory, { recursive: true });
    const relative = 'game/scene/new/start.txt';

    await expectAppError(() => snapshotTarget(root, relative), 'FILE_NOT_FOUND');
    await expectAppError(
      () => publishTarget(root, relative, null, Buffer.from('new'), BATCH_ID, 0),
      'FILE_NOT_FOUND'
    );
    expect(await pathExists(sceneDirectory)).toBe(false);
  });

  it('rejects inside and outside junctions in the target parent chain', async () => {
    const inside = path.join(root, 'inside-scene');
    const outside = path.join(baseDirectory, 'outside-scene');
    await mkdir(inside);
    await mkdir(outside);
    await writeFile(path.join(inside, 'inside.txt'), 'inside');
    await writeFile(path.join(outside, 'outside.txt'), 'outside');

    await rm(sceneDirectory, { recursive: true });
    await symlink(
      inside,
      sceneDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expectAppError(
      () => snapshotTarget(root, 'game/scene/inside.txt'),
      'PATH_INVALID'
    );
    await expectAppError(
      () => publishTarget(
        root,
        'game/scene/new.txt',
        null,
        Buffer.from('new'),
        BATCH_ID,
        0
      ),
      'PATH_INVALID'
    );

    await rm(sceneDirectory, { recursive: true });
    await symlink(
      outside,
      sceneDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expectAppError(
      () => snapshotTarget(root, 'game/scene/outside.txt'),
      'PATH_INVALID'
    );
    expect(await readFile(path.join(outside, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('rejects a project root replaced by a junction', async () => {
    const originalRoot = `${root}-original`;
    const outside = path.join(baseDirectory, 'outside-root');
    await rename(root, originalRoot);
    await mkdir(outside);
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');

    await expectAppError(
      () => snapshotTarget(root, 'game/scene/start.txt'),
      'PROJECT_NOT_AUTHORIZED'
    );
    await expectAppError(
      () => publishTarget(
        root,
        'game/scene/start.txt',
        null,
        Buffer.from('new'),
        BATCH_ID,
        0
      ),
      'PROJECT_NOT_AUTHORIZED'
    );
    expect(await pathExists(path.join(outside, 'game', 'scene', 'start.txt'))).toBe(false);
  });

  it('preserves BOM and arbitrary binary bytes exactly', async () => {
    const relative = 'game/background/binary.bin';
    const target = path.join(root, 'game', 'background', 'binary.bin');
    const bytes = Buffer.from([
      0xef, 0xbb, 0xbf,
      0x00, 0xff, 0xfe, 0x80,
      0x0d, 0x0a, 0x41
    ]);

    await publishTarget(root, relative, null, bytes, BATCH_ID, 0);
    const snapshot = await snapshotTarget(root, relative);
    expect(snapshot.bytes).toEqual(bytes);
    expect(await readFile(target)).toEqual(bytes);
  });

  it('accepts exactly the 1 MiB limit and rejects larger snapshots and writes', async () => {
    const relative = 'game/background/limit.bin';
    const target = path.join(root, 'game', 'background', 'limit.bin');
    const maximum = Buffer.alloc(WRITE_LIMITS.maxFileBytes, 0xab);
    await publishTarget(root, relative, null, maximum, BATCH_ID, 0);
    expect((await snapshotTarget(root, relative)).bytes?.byteLength)
      .toBe(WRITE_LIMITS.maxFileBytes);

    await writeFile(target, Buffer.alloc(WRITE_LIMITS.maxFileBytes + 1, 0xcd));
    await expectAppError(
      () => snapshotTarget(root, relative),
      'FILE_TOO_LARGE'
    );
    await expectAppError(
      () => publishTarget(
        root,
        'game/background/too-large.bin',
        null,
        Buffer.alloc(WRITE_LIMITS.maxFileBytes + 1),
        BATCH_ID,
        1
      ),
      'FILE_TOO_LARGE'
    );
    expect(await pathExists(path.join(root, 'game', 'background', 'too-large.bin')))
      .toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'keeps the old scene and cleans staging when Windows denies replacement rename',
    async () => {
      const relative = 'game/scene/start.txt';
      const target = path.join(sceneDirectory, 'start.txt');
      const original = Buffer.from('original');
      await writeFile(target, original);
      const revision = (await snapshotTarget(root, relative)).revision;

      const script = [
        '$stream = [System.IO.File]::Open($env:WGM_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
        '[Console]::Out.WriteLine("ready")',
        '[Console]::Out.Flush()',
        '[Console]::In.ReadLine() | Out-Null',
        '$stream.Dispose()'
      ].join('; ');
      const child = spawn(
        POWERSHELL_PATH,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          env: { ...process.env, WGM_TARGET: target },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`PowerShell did not open the target: ${stderr}`));
        }, 5000);
        child.stdout.on('data', (chunk: Buffer | string) => {
          if (chunk.toString().includes('ready')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          if (!stderr.includes('ready')) {
            clearTimeout(timeout);
            reject(new Error(`PowerShell exited before opening the target (${code}): ${stderr}`));
          }
        });
      });

      await expectAppError(
        () => publishTarget(
          root,
          relative,
          revision,
          Buffer.from('replacement'),
          BATCH_ID,
          0
        ),
        'WRITE_FAILED'
      );
      expect(await readFile(target)).toEqual(original);
      expect(await temporaryNames(sceneDirectory)).toEqual([]);
    }
  );
});
