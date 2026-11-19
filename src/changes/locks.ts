import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink
} from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { AppError } from '../errors.js';
import type { AppConfig } from '../types.js';

const MAX_LOCK_BYTES = 4096;

interface LockRecord {
  token: string;
  pid: number;
  instanceId: string;
}

type LockFileState =
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'valid'; record: LockRecord };

function isNodeError(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function casefoldForPlatform(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePath(left: string, right: string): boolean {
  return casefoldForPlatform(path.resolve(left))
    === casefoldForPlatform(path.resolve(right));
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  const comparable = casefoldForPlatform(relative);
  return comparable === ''
    || (!path.isAbsolute(relative)
      && comparable !== '..'
      && !comparable.startsWith(`..${path.sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithinRoot(left, right) || isWithinRoot(right, left);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function snapshotMatches(before: BigIntStats, after: BigIntStats): boolean {
  return sameFileIdentity(before, after)
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function projectNotAuthorized(): never {
  throw new AppError(
    'PROJECT_NOT_AUTHORIZED',
    'The project root is not a canonical directory.'
  );
}

function lockRootOverlap(): never {
  throw new AppError(
    'LOCK_ROOT_OVERLAP',
    'The lock root must be separate from every configured project and source root.'
  );
}

function lockUnavailable(): never {
  throw new AppError(
    'LOCKED',
    'The project is locked by another webgal-mcp process.'
  );
}

function lockNotReclaimable(): never {
  throw new AppError(
    'LOCK_NOT_RECLAIMABLE',
    'The project lock cannot be safely reclaimed.'
  );
}

function lockReleaseFailed(): never {
  throw new AppError(
    'LOCK_RELEASE_FAILED',
    'The project lock could not be safely released.'
  );
}

function defaultLockRoot(): string {
  return path.join(homedir(), '.webgal-mcp', 'locks');
}

function ownerAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, ['ESRCH'])) {
      return false;
    }
    return null;
  }
}

function parseLockRecord(content: string): LockRecord | undefined {
  if (Buffer.byteLength(content, 'utf8') > MAX_LOCK_BYTES) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as Partial<LockRecord>;
  if (typeof candidate.token !== 'string'
    || candidate.token === ''
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid ?? 0) <= 0
    || typeof candidate.instanceId !== 'string'
    || candidate.instanceId === '') {
    return undefined;
  }

  return {
    token: candidate.token,
    pid: candidate.pid as number,
    instanceId: candidate.instanceId
  };
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readLockFile(
  lockPath: string,
  canonicalLockRoot: string
): Promise<LockFileState> {
  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      return { kind: 'missing' };
    }
    return { kind: 'malformed' };
  }

  if (!pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || pathBefore.size > BigInt(MAX_LOCK_BYTES)) {
    return { kind: 'malformed' };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.size > BigInt(MAX_LOCK_BYTES)
      || !snapshotMatches(pathBefore, before)) {
      return { kind: 'malformed' };
    }

    const canonicalLockPath = await realpath(lockPath);
    if (!samePath(canonicalLockPath, lockPath)
      || !isWithinRoot(canonicalLockRoot, canonicalLockPath)) {
      return { kind: 'malformed' };
    }

    const pathAfterOpen = await lstat(lockPath, { bigint: true });
    if (pathAfterOpen.isSymbolicLink()
      || !pathAfterOpen.isFile()
      || !snapshotMatches(before, pathAfterOpen)) {
      return { kind: 'malformed' };
    }

    const bytes = await readBounded(handle, MAX_LOCK_BYTES);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(lockPath, { bigint: true });
    if (!snapshotMatches(before, after)
      || !snapshotMatches(before, pathAfter)
      || BigInt(bytes.byteLength) !== after.size
      || bytes.byteLength > MAX_LOCK_BYTES) {
      return { kind: 'malformed' };
    }

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { kind: 'malformed' };
    }
    const record = parseLockRecord(content);
    return record ? { kind: 'valid', record } : { kind: 'malformed' };
  } catch (error) {
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      return { kind: 'missing' };
    }
    return { kind: 'malformed' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function canonicalProjectDirectory(root: string): Promise<string> {
  if (typeof root !== 'string' || root.trim() === '') {
    projectNotAuthorized();
  }

  const expectedRoot = path.resolve(root);
  try {
    const canonicalRoot = await realpath(expectedRoot);
    if (!samePath(canonicalRoot, expectedRoot)) {
      projectNotAuthorized();
    }
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      projectNotAuthorized();
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    projectNotAuthorized();
  }
}

export async function canonicalProjectKey(root: string): Promise<string> {
  const canonicalRoot = await canonicalProjectDirectory(root);
  return createHash('sha256')
    .update(casefoldForPlatform(canonicalRoot), 'utf8')
    .digest('hex');
}

async function resolveLockRootCandidate(requestedRoot: string): Promise<string> {
  let existing = requestedRoot;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const entryStat = await lstat(existing);
      if (entryStat.isSymbolicLink()) {
        const canonical = await realpath(existing);
        const canonicalStat = await stat(canonical);
        if (!canonicalStat.isDirectory()) {
          projectNotAuthorized();
        }
        return path.join(canonical, ...missingSegments);
      }
      if (!entryStat.isDirectory()) {
        projectNotAuthorized();
      }
      const canonical = await realpath(existing);
      return path.join(canonical, ...missingSegments);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (!isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        projectNotAuthorized();
      }
      if (isNodeError(error, ['ENOTDIR'])) {
        projectNotAuthorized();
      }
    }

    const parent = path.dirname(existing);
    if (parent === existing) {
      projectNotAuthorized();
    }
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
}

export class ProjectLocks {
  private readonly requestedLockRoot: string;
  private readonly instanceId = randomUUID();
  private authorizedLockRoot: string | undefined;
  private lockRootIdentity: BigIntStats | undefined;

  constructor(lockRoot: string = defaultLockRoot()) {
    this.requestedLockRoot = path.resolve(lockRoot);
  }

  private async lockRootCandidate(): Promise<string> {
    const candidate = await resolveLockRootCandidate(this.requestedLockRoot);
    if (!samePath(candidate, this.requestedLockRoot)) {
      projectNotAuthorized();
    }
    return candidate;
  }

  private async ensureLockRoot(expectedCandidate?: string): Promise<string> {
    const candidate = expectedCandidate ?? await this.lockRootCandidate();
    try {
      await mkdir(this.requestedLockRoot, { recursive: true, mode: 0o700 });
      await chmod(this.requestedLockRoot, 0o700);
      const canonicalRoot = await realpath(this.requestedLockRoot);
      if (!samePath(canonicalRoot, this.requestedLockRoot)
        || !samePath(canonicalRoot, candidate)) {
        projectNotAuthorized();
      }
      const rootStat = await lstat(canonicalRoot, { bigint: true });
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        projectNotAuthorized();
      }
      if (this.authorizedLockRoot !== undefined
        && (!samePath(this.authorizedLockRoot, canonicalRoot)
          || this.lockRootIdentity === undefined
          || !sameFileIdentity(this.lockRootIdentity, rootStat))) {
        projectNotAuthorized();
      }
      this.authorizedLockRoot = canonicalRoot;
      this.lockRootIdentity = rootStat;
      return canonicalRoot;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      projectNotAuthorized();
    }
  }

  async validateIsolation(config: AppConfig): Promise<void> {
    const candidate = await this.lockRootCandidate();
    const configuredRoots: { lexical: string; canonical: string }[] = [];
    for (const root of [
      ...config.projects.map((project) => project.root),
      ...config.sources.map((source) => source.root)
    ]) {
      const lexical = path.resolve(root);
      try {
        const canonical = await realpath(lexical);
        const rootStat = await stat(canonical);
        if (!rootStat.isDirectory()) {
          projectNotAuthorized();
        }
        configuredRoots.push({ lexical, canonical });
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        projectNotAuthorized();
      }
    }

    for (const configured of configuredRoots) {
      if (pathsOverlap(this.requestedLockRoot, configured.lexical)
        || pathsOverlap(this.requestedLockRoot, configured.canonical)
        || pathsOverlap(candidate, configured.lexical)
        || pathsOverlap(candidate, configured.canonical)) {
        lockRootOverlap();
      }
    }

    await this.ensureLockRoot(candidate);
  }

  private async lockPathFor(root: string): Promise<{
    lockPath: string;
    lockRoot: string;
  }> {
    const canonicalProjectRoot = await canonicalProjectDirectory(root);
    const projectKey = createHash('sha256')
      .update(casefoldForPlatform(canonicalProjectRoot), 'utf8')
      .digest('hex');
    const candidate = await this.lockRootCandidate();
    if (pathsOverlap(this.requestedLockRoot, canonicalProjectRoot)
      || pathsOverlap(candidate, canonicalProjectRoot)) {
      lockRootOverlap();
    }
    const lockRoot = await this.ensureLockRoot(candidate);
    return {
      lockPath: path.join(lockRoot, `${projectKey}.lock`),
      lockRoot
    };
  }

  private async releaseOwnedLock(
    lockPath: string,
    lockRoot: string,
    token: string
  ): Promise<void> {
    const current = await readLockFile(lockPath, lockRoot);
    if (current.kind === 'missing') {
      return;
    }
    if (current.kind !== 'valid' || current.record.token !== token) {
      lockReleaseFailed();
    }

    const confirmation = await readLockFile(lockPath, lockRoot);
    if (confirmation.kind !== 'valid' || confirmation.record.token !== token) {
      lockReleaseFailed();
    }

    try {
      await unlink(lockPath);
    } catch (error) {
      if (isNodeError(error, ['ENOENT'])) {
        lockReleaseFailed();
      }
      lockReleaseFailed();
    }
  }

  async withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
    if (typeof action !== 'function') {
      throw new AppError('INVALID_ARGUMENT', 'A lock action is required.');
    }

    const { lockPath, lockRoot } = await this.lockPathFor(root);
    const reclaimPath = `${lockPath}.reclaim`;
    if ((await readLockFile(reclaimPath, lockRoot)).kind !== 'missing') lockUnavailable();
    const token = randomUUID();
    const record: LockRecord = {
      token,
      pid: process.pid,
      instanceId: this.instanceId
    };

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isNodeError(error, ['EEXIST'])) {
        lockUnavailable();
      }
      throw new AppError(
        'LOCK_CREATE_FAILED',
        'The project lock could not be created.'
      );
    }
    await handle.close();

    // A reclaimer may have started after the first check. It cannot delete this
    // live owner's lock, and we cannot enter business writes while it is active.
    if ((await readLockFile(reclaimPath, lockRoot)).kind !== 'missing') {
      await this.releaseOwnedLock(lockPath, lockRoot, token);
      lockUnavailable();
    }

    let actionFailed = false;
    let actionError: unknown;
    let result: T | undefined;
    try {
      result = await action();
    } catch (error) {
      actionFailed = true;
      actionError = error;
    }

    let releaseError: unknown;
    try {
      await this.releaseOwnedLock(lockPath, lockRoot, token);
    } catch (error) {
      releaseError = error;
    }

    if (actionFailed) {
      throw actionError;
    }
    if (releaseError !== undefined) {
      throw releaseError;
    }
    return result as T;
  }

  async inspect(root: string): Promise<{
    locked: boolean;
    token?: string;
    ownerAlive?: boolean | null;
    maintenance?: true;
  }> {
    const { lockPath, lockRoot } = await this.lockPathFor(root);
    const maintenance = await readLockFile(`${lockPath}.reclaim`, lockRoot);
    if (maintenance.kind !== 'missing') {
      return { locked: true, maintenance: true, ...(maintenance.kind === 'valid' ? { token: maintenance.record.token, ownerAlive: ownerAlive(maintenance.record.pid) } : { ownerAlive: null }) };
    }
    const current = await readLockFile(lockPath, lockRoot);
    if (current.kind === 'missing') {
      return { locked: false };
    }
    if (current.kind === 'malformed') {
      return { locked: true, ownerAlive: null };
    }
    return {
      locked: true,
      token: current.record.token,
      ownerAlive: ownerAlive(current.record.pid)
    };
  }

  async reclaim(root: string, token: string): Promise<void> {
    if (typeof token !== 'string' || token === '') {
      lockNotReclaimable();
    }

    const { lockPath, lockRoot } = await this.lockPathFor(root);
    const reclaimPath = `${lockPath}.reclaim`;
    const guardToken = randomUUID();
    let guard: Awaited<ReturnType<typeof open>> | undefined;
    try {
      guard = await open(reclaimPath, 'wx', 0o600);
      await guard.writeFile(JSON.stringify({ token: guardToken, pid: process.pid, instanceId: this.instanceId }));
      await guard.sync();
    } catch {
      await guard?.close().catch(() => undefined);
      // Partial maintenance records stay conservative; never remove an unknown guard.
      lockNotReclaimable();
    }
    await guard.close();
    try {
      const first = await readLockFile(lockPath, lockRoot);
      if (first.kind !== 'valid' || first.record.token !== token || ownerAlive(first.record.pid) !== false) lockNotReclaimable();
      const confirmation = await readLockFile(lockPath, lockRoot);
      if (confirmation.kind !== 'valid'
        || confirmation.record.token !== token
        || confirmation.record.pid !== first.record.pid
        || confirmation.record.instanceId !== first.record.instanceId) lockNotReclaimable();
      try { await unlink(lockPath); } catch { lockNotReclaimable(); }
    } finally {
      await this.releaseOwnedLock(reclaimPath, lockRoot, guardToken);
    }
  }
}
