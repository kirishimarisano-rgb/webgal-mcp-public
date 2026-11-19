import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';
import {
  canonicalProjectKey,
  ProjectLocks
} from '../../src/changes/locks.js';

const fixturePath = path.join(
  process.cwd(),
  'test',
  'changes',
  'fixtures',
  'lock-child.mjs'
);

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
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

function runChild(args: string[], timeoutMs = 5000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Child timed out: ${stderr}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
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

async function spawnHoldingChild(
  root: string,
  lockRoot: string
): Promise<{ child: ChildProcess; stdout: () => string; stderr: () => string }> {
  const child = spawn(process.execPath, [
    fixturePath,
    'hold',
    root,
    lockRoot
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Child did not acquire lock: ${stderr}`));
    }, 5000);
    const check = (): void => {
      if (stdout.includes('acquired:')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on('data', check);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!stdout.includes('acquired:')) {
        clearTimeout(timeout);
        reject(new Error(`Child exited before acquiring lock (${code}): ${stderr}`));
      }
    });
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
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

describe('ProjectLocks', () => {
  let baseDirectory: string;
  let root: string;
  let lockRoot: string;
  let locks: ProjectLocks;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-locks-')));
    root = path.join(baseDirectory, 'Project');
    lockRoot = path.join(baseDirectory, 'locks');
    await mkdir(root);
    await mkdir(lockRoot);
    locks = new ProjectLocks(lockRoot);
  });

  afterEach(async () => {
    for (const child of children) {
      await terminate(child).catch(() => undefined);
    }
    children.length = 0;
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createDeadLock(): Promise<string> {
    const holding = await spawnHoldingChild(root, lockRoot);
    children.push(holding.child);
    const observed = await locks.inspect(root);
    const token = observed.token;
    expect(token).toEqual(expect.any(String));
    await terminate(holding.child);
    await waitFor(async () => (await locks.inspect(root)).ownerAlive === false);
    return token as string;
  }

  it('hashes the canonical project root and rejects non-canonical roots', async () => {
    const canonicalRoot = await realpath(root);
    const expected = createHash('sha256')
      .update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot)
      .digest('hex');
    expect(await canonicalProjectKey(root)).toBe(expected);
    if (process.platform === 'win32') {
      expect(await canonicalProjectKey(root.toUpperCase())).toBe(expected);
    }

    const rootLink = path.join(baseDirectory, 'project-link');
    await symlink(root, rootLink, 'junction');
    await expectAppError(() => canonicalProjectKey(rootLink), 'PROJECT_NOT_AUTHORIZED');

    const fileRoot = path.join(baseDirectory, 'not-a-directory');
    await writeFile(fileRoot, 'not a directory', 'utf8');
    await expectAppError(() => canonicalProjectKey(fileRoot), 'PROJECT_NOT_AUTHORIZED');
  });

  it('creates a wx lock with token, pid and instance id and releases it', async () => {
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(await realpath(lockRoot), `${key}.lock`);
    let observed: Record<string, unknown> | undefined;

    await locks.withLock(root, async () => {
      observed = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      expect(await locks.inspect(root)).toMatchObject({
        locked: true,
        ownerAlive: true
      });
      await expectAppError(
        () => locks.withLock(root, async () => undefined),
        'LOCKED'
      );
    });

    expect(observed).toMatchObject({
      token: expect.any(String),
      pid: process.pid,
      instanceId: expect.any(String)
    });
    expect(await locks.inspect(root)).toEqual({ locked: false });
  });

  it('releases the lock when the action throws', async () => {
    await expect(locks.withLock(root, async () => {
      throw new Error('action failed');
    })).rejects.toThrow('action failed');
    expect(await locks.inspect(root)).toEqual({ locked: false });
  });

  it('does not delete a lock whose token changed during the action', async () => {
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(await realpath(lockRoot), `${key}.lock`);
    await expect(locks.withLock(root, async () => {
      const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      await writeFile(lockPath, JSON.stringify({ ...record, token: 'other-token' }), 'utf8');
    })).rejects.toMatchObject({ code: 'LOCK_RELEASE_FAILED' });

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      token: 'other-token'
    });
    await unlink(lockPath);
  });

  it('rejects a symlinked lock root without exposing its path', async () => {
    const actualLockRoot = path.join(baseDirectory, 'actual-locks');
    const linkedLockRoot = path.join(baseDirectory, 'linked-locks');
    await mkdir(actualLockRoot);
    await symlink(actualLockRoot, linkedLockRoot, 'junction');
    const linked = new ProjectLocks(linkedLockRoot);

    await expectAppError(
      () => linked.withLock(root, async () => undefined),
      'PROJECT_NOT_AUTHORIZED'
    );
  });

  it('preflights a missing lock root through its nearest real parent before mkdir', async () => {
    const actualParent = path.join(baseDirectory, 'actual-parent');
    const linkedParent = path.join(baseDirectory, 'linked-parent');
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent, 'junction');
    const linked = new ProjectLocks(path.join(linkedParent, 'locks'));

    await expectAppError(
      () => linked.withLock(root, async () => undefined),
      'PROJECT_NOT_AUTHORIZED'
    );
    await expect(stat(path.join(actualParent, 'locks'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a canonical lock root replaced by a junction after first use', async () => {
    await locks.withLock(root, async () => undefined);
    const original = `${lockRoot}-original`;
    const outside = path.join(baseDirectory, 'replacement-locks');
    await mkdir(outside);
    await rename(lockRoot, original);
    await symlink(outside, lockRoot, 'junction');

    await expectAppError(
      () => locks.inspect(root),
      'PROJECT_NOT_AUTHORIZED'
    );
  });

  it('reports malformed locks conservatively without exposing private paths', async () => {
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(lockRoot, `${key}.lock`);
    await writeFile(lockPath, '{not-json', 'utf8');

    const inspected = await locks.inspect(root);
    expect(inspected).toEqual({ locked: true, ownerAlive: null });
    expect(JSON.stringify(inspected)).not.toContain(baseDirectory);
    await expectAppError(() => locks.reclaim(root, 'any-token'), 'LOCK_NOT_RECLAIMABLE');
    await unlink(lockPath);
  });

  it('rejects oversized lock records before allocating an unbounded read', async () => {
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(lockRoot, `${key}.lock`);
    await writeFile(lockPath, 'x'.repeat(4097), 'utf8');

    expect(await locks.inspect(root)).toEqual({ locked: true, ownerAlive: null });
    await expectAppError(() => locks.reclaim(root, 'any-token'), 'LOCK_NOT_RECLAIMABLE');
    await unlink(lockPath);
  });

  it('rejects lock roots inside or containing the active project before creation', async () => {
    const nestedLockRoot = path.join(root, 'locks');
    const nested = new ProjectLocks(nestedLockRoot);
    await expectAppError(
      () => nested.withLock(root, async () => undefined),
      'LOCK_ROOT_OVERLAP'
    );
    await expect(stat(nestedLockRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const containing = new ProjectLocks(baseDirectory);
    await expectAppError(
      () => containing.withLock(root, async () => undefined),
      'LOCK_ROOT_OVERLAP'
    );
  });

  it('validates the lock root against configured project and source roots', async () => {
    const sourceRoot = path.join(baseDirectory, 'source');
    await mkdir(sourceRoot);
    const config: AppConfig = {
      version: 1,
      projects: [{ id: 'project', root }],
      sources: [{ id: 'source', root: sourceRoot }]
    };

    await locks.validateIsolation(config);

    const sourceLockRoot = path.join(sourceRoot, 'locks');
    const overlapping = new ProjectLocks(sourceLockRoot);
    await expectAppError(
      () => overlapping.validateIsolation(config),
      'LOCK_ROOT_OVERLAP'
    );
    await expect(stat(sourceLockRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats permission-unknown owners as live for reclaim purposes', async () => {
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(lockRoot, `${key}.lock`);
    await writeFile(lockPath, JSON.stringify({
      token: 'permission-unknown',
      pid: 424242,
      instanceId: 'instance'
    }), 'utf8');

    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    try {
      expect(await locks.inspect(root)).toMatchObject({
        locked: true,
        token: 'permission-unknown',
        ownerAlive: null
      });
      await expectAppError(
        () => locks.reclaim(root, 'permission-unknown'),
        'LOCK_NOT_RECLAIMABLE'
      );
    } finally {
      spy.mockRestore();
      await unlink(lockPath);
    }
  });

  it('lets two child processes contend for one project lock', async () => {
    const startAt = String(Date.now() + 500);
    const results = await Promise.all([
      runChild(['contend', root, lockRoot, startAt, '800']),
      runChild(['contend', root, lockRoot, startAt, '800'])
    ]);

    expect(results.every((result) => result.code === 0)).toBe(true);
    const outputs = results.map((result) => result.stdout.trim());
    expect(outputs.filter((output) => output.startsWith('acquired:'))).toHaveLength(1);
    expect(outputs.filter((output) => output === 'locked:LOCKED')).toHaveLength(1);
    expect(await locks.inspect(root)).toEqual({ locked: false });
  });

  it('blocks acquisition and reclaim while a maintenance guard exists without a main lock', async () => {
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(lockRoot, `${key}.lock`);
    const reclaimPath = `${lockPath}.reclaim`;
    await writeFile(reclaimPath, JSON.stringify({
      token: 'maintenance-token',
      pid: 424242,
      instanceId: 'maintenance-instance'
    }), 'utf8');

    expect(await locks.inspect(root)).toMatchObject({
      locked: true,
      maintenance: true,
      token: 'maintenance-token'
    });
    await expectAppError(
      () => locks.withLock(root, async () => undefined),
      'LOCKED'
    );
    await expectAppError(
      () => locks.reclaim(root, 'dead-token'),
      'LOCK_NOT_RECLAIMABLE'
    );
    expect(JSON.parse(await readFile(reclaimPath, 'utf8'))).toMatchObject({
      token: 'maintenance-token'
    });
    await unlink(reclaimPath);
  });

  it('allows exactly one concurrent reclaimer and preserves a newly acquired main lock', async () => {
    const deadToken = await createDeadLock();
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(lockRoot, `${key}.lock`);

    const results = await Promise.allSettled([
      locks.reclaim(root, deadToken),
      locks.reclaim(root, deadToken)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'LOCK_NOT_RECLAIMABLE' });
    expect(await locks.inspect(root)).toEqual({ locked: false });

    let currentToken: string | undefined;
    await locks.withLock(root, async () => {
      const current = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string };
      currentToken = current.token;
      await expectAppError(
        () => locks.reclaim(root, deadToken),
        'LOCK_NOT_RECLAIMABLE'
      );
      const after = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string };
      expect(after.token).toBe(currentToken);
    });
    expect(await locks.inspect(root)).toEqual({ locked: false });
  });

  it('keeps a crashed maintenance guard and dead main lock conservative', async () => {
    const deadToken = await createDeadLock();
    const key = await canonicalProjectKey(root);
    const lockPath = path.join(lockRoot, `${key}.lock`);
    const reclaimPath = `${lockPath}.reclaim`;
    await writeFile(reclaimPath, JSON.stringify({
      token: 'crashed-guard-token',
      pid: 424242,
      instanceId: 'crashed-guard-instance'
    }), 'utf8');

    expect(await locks.inspect(root)).toMatchObject({
      locked: true,
      maintenance: true,
      token: 'crashed-guard-token'
    });
    await expectAppError(
      () => locks.withLock(root, async () => undefined),
      'LOCKED'
    );
    await expectAppError(
      () => locks.reclaim(root, deadToken),
      'LOCK_NOT_RECLAIMABLE'
    );

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      token: deadToken
    });
    expect(JSON.parse(await readFile(reclaimPath, 'utf8'))).toMatchObject({
      token: 'crashed-guard-token'
    });
    await unlink(reclaimPath);
    await unlink(lockPath);
  });

  it('reclaims only a matching lock after its owner PID is gone', async () => {
    const holding = await spawnHoldingChild(root, lockRoot);
    children.push(holding.child);
    const first = await locks.inspect(root);
    expect(first).toMatchObject({
      locked: true,
      ownerAlive: true,
      token: expect.any(String)
    });

    await expectAppError(
      () => locks.reclaim(root, first.token as string),
      'LOCK_NOT_RECLAIMABLE'
    );
    await terminate(holding.child);
    await waitFor(async () => (await locks.inspect(root)).ownerAlive === false);

    await locks.reclaim(root, first.token as string);
    expect(await locks.inspect(root)).toEqual({ locked: false });
  });
});
