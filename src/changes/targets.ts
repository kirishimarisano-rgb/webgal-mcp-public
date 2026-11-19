import type { BigIntStats } from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { AppError } from '../errors.js';
import { resolveSafe, validateRelativePath } from '../filesystem.js';
import { WRITE_LIMITS } from './types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[0-9a-f]{64}$/i;
const ASSET_DIRECTORIES = new Set([
  'background',
  'figure',
  'bgm',
  'vocal',
  'video'
]);

interface WritePolicy {
  create: boolean;
  replace: boolean;
}

interface TargetContext {
  requestedRoot: string;
  canonicalRoot: string;
  rootIdentity: BigIntStats;
  parent: string;
  parentIdentity: BigIntStats;
  parentRelative: string;
  target: string;
}

interface FileSnapshot {
  revision: string;
  bytes: Buffer;
}

type CleanupResult = 'removed' | 'missing' | 'not-owned';

function fail(code: string, message: string): never {
  throw new AppError(code, message);
}

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

function parentRelative(relative: string): string {
  const parent = path.posix.dirname(relative);
  return parent === '.' ? '' : parent;
}

function policyFor(relative: string): WritePolicy {
  if (typeof relative !== 'string' || relative === '') {
    fail('PATH_INVALID', 'The write path is invalid.');
  }

  const validated = validateRelativePath(relative);
  const segments = validated.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) {
    fail('PATH_INVALID', 'Hidden path segments are not allowed.');
  }

  if (validated === 'game/config.txt') {
    return { create: false, replace: true };
  }
  if (validated.startsWith('game/scene/')
    && validated.endsWith('.txt')
    && validated.length > 'game/scene/.txt'.length) {
    return { create: true, replace: true };
  }

  const assetMatch = /^game\/([^/]+)\/(.+)$/.exec(validated);
  if (assetMatch
    && ASSET_DIRECTORIES.has(assetMatch[1] as string)
    && (assetMatch[2] as string) !== '') {
    return { create: true, replace: false };
  }

  fail('PATH_INVALID', 'The path is outside the supported WebGAL write targets.');
}

function normalizeBatchId(batchId: string): string {
  if (typeof batchId !== 'string' || !UUID_PATTERN.test(batchId)) {
    fail('INVALID_ARGUMENT', 'The batch identifier must be a UUID.');
  }
  return batchId.toLowerCase();
}

function normalizeIndex(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= WRITE_LIMITS.maxFiles) {
    fail(
      'INVALID_ARGUMENT',
      `The operation index must be an integer from 0 to ${WRITE_LIMITS.maxFiles - 1}.`
    );
  }
  return index;
}

function normalizeRevision(expectedRevision: string | null): string | null {
  if (expectedRevision === null) {
    return null;
  }
  if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
    fail('INVALID_ARGUMENT', 'The expected revision must be a SHA-256 hash or null.');
  }
  return expectedRevision.toLowerCase();
}

function mapPathInspectionError(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }
  if (isNodeError(error, ['ENOENT'])) {
    fail('FILE_NOT_FOUND', 'The requested file or directory was not found.');
  }
  if (isNodeError(error, ['ENOTDIR'])) {
    fail('FILE_NOT_DIRECTORY', 'A path component is not a directory.');
  }
  if (isNodeError(error, ['ELOOP'])) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (isNodeError(error, ['EACCES', 'EPERM'])) {
    fail('FILE_NOT_READABLE', 'The requested path could not be inspected.');
  }
  fail('FILE_READ_FAILED', 'The requested path could not be inspected.');
}

async function assertNoSymlinkSegments(
  canonicalRoot: string,
  relative: string
): Promise<void> {
  if (relative === '') {
    return;
  }

  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let entryStat: BigIntStats;
    try {
      entryStat = await lstat(current, { bigint: true });
    } catch (error) {
      mapPathInspectionError(error);
    }
    if (entryStat.isSymbolicLink()) {
      fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
    }
    if (!entryStat.isDirectory()) {
      fail('FILE_NOT_DIRECTORY', 'A path component is not a directory.');
    }
  }
}

async function readRootIdentity(root: string): Promise<{
  canonicalRoot: string;
  identity: BigIntStats;
}> {
  const canonicalRoot = await resolveSafe(root, '');
  let identity: BigIntStats;
  try {
    identity = await lstat(canonicalRoot, { bigint: true });
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    fail('PROJECT_NOT_AUTHORIZED', 'The project root is not a canonical directory.');
  }
  return { canonicalRoot, identity };
}

async function assertContextUnchanged(context: TargetContext): Promise<void> {
  const currentRoot = await readRootIdentity(context.requestedRoot);
  if (!samePath(currentRoot.canonicalRoot, context.canonicalRoot)
    || !sameFileIdentity(currentRoot.identity, context.rootIdentity)) {
    fail('PROJECT_NOT_AUTHORIZED', 'The authorized project root was replaced.');
  }

  await assertNoSymlinkSegments(context.canonicalRoot, context.parentRelative);

  let currentParent: BigIntStats;
  try {
    currentParent = await lstat(context.parent, { bigint: true });
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (currentParent.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!currentParent.isDirectory()) {
    fail('FILE_NOT_DIRECTORY', 'The target parent is not a directory.');
  }
  if (!sameFileIdentity(currentParent, context.parentIdentity)) {
    fail('FILE_CHANGED', 'The target parent changed while the operation was in progress.');
  }

  let canonicalParent: string;
  try {
    canonicalParent = await realpath(context.parent);
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (!samePath(canonicalParent, context.parent)
    || !isWithinRoot(context.canonicalRoot, canonicalParent)) {
    fail('PATH_OUTSIDE_PROJECT', 'The target parent is outside the authorized root.');
  }
}

async function resolveTargetContext(root: string, relative: string): Promise<TargetContext> {
  policyFor(relative);
  const { canonicalRoot, identity: rootIdentity } = await readRootIdentity(root);
  const parentRel = parentRelative(relative);
  await assertNoSymlinkSegments(canonicalRoot, parentRel);

  const parent = await resolveSafe(canonicalRoot, parentRel);
  let parentIdentity: BigIntStats;
  try {
    parentIdentity = await lstat(parent, { bigint: true });
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (parentIdentity.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!parentIdentity.isDirectory()) {
    fail('FILE_NOT_DIRECTORY', 'The target parent is not a directory.');
  }

  const target = path.join(parent, path.posix.basename(relative));
  if (!isWithinRoot(canonicalRoot, target)) {
    fail('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
  }

  const context: TargetContext = {
    requestedRoot: root,
    canonicalRoot,
    rootIdentity,
    parent,
    parentIdentity,
    parentRelative: parentRel,
    target
  };
  await assertContextUnchanged(context);
  return context;
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset
    );
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readRegularFile(
  canonicalRoot: string,
  target: string,
  missingCode: 'FILE_NOT_FOUND' | 'FILE_CHANGED'
): Promise<FileSnapshot> {
  const pathBefore = await lstat(target, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, ['ENOENT'])) {
      return fail(missingCode, 'The requested target was not found.');
    }
    return mapPathInspectionError(error);
  });
  if (pathBefore.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!pathBefore.isFile()) {
    fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
  }
  if (pathBefore.size > BigInt(WRITE_LIMITS.maxFileBytes)) {
    fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
    }
    if (!snapshotMatches(pathBefore, before)) {
      fail('FILE_CHANGED', 'The target changed while it was being opened.');
    }
    if (before.size > BigInt(WRITE_LIMITS.maxFileBytes)) {
      fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
    }

    const canonicalTarget = await realpath(target);
    if (!samePath(canonicalTarget, target)
      || !isWithinRoot(canonicalRoot, canonicalTarget)) {
      fail('PATH_OUTSIDE_PROJECT', 'The target is outside the authorized root.');
    }

    const pathAfterOpen = await lstat(target, { bigint: true });
    if (pathAfterOpen.isSymbolicLink()
      || !pathAfterOpen.isFile()
      || !snapshotMatches(before, pathAfterOpen)) {
      fail('FILE_CHANGED', 'The target changed while it was being opened.');
    }

    const bytes = await readBounded(handle, WRITE_LIMITS.maxFileBytes);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(target, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        return fail('FILE_CHANGED', 'The target changed while it was being read.');
      }
      return mapPathInspectionError(error);
    });

    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !snapshotMatches(before, after)
      || !snapshotMatches(before, pathAfter)
      || BigInt(bytes.byteLength) !== after.size) {
      fail('FILE_CHANGED', 'The target changed while it was being read.');
    }
    if (bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
      fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
    }

    return {
      revision: createHash('sha256').update(bytes).digest('hex'),
      bytes
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      fail('FILE_CHANGED', 'The target changed while it was being read.');
    }
    if (isNodeError(error, ['EACCES', 'EPERM'])) {
      fail('FILE_NOT_READABLE', 'The target could not be read.');
    }
    if (isNodeError(error, ['EISDIR'])) {
      fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
    }
    return fail('FILE_READ_FAILED', 'The target could not be read.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function snapshotContext(context: TargetContext): Promise<FileSnapshot | null> {
  let targetStat: BigIntStats;
  try {
    targetStat = await lstat(context.target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT'])) {
      await assertContextUnchanged(context);
      return null;
    }
    mapPathInspectionError(error);
  }
  if (targetStat.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!targetStat.isFile()) {
    fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
  }

  const snapshot = await readRegularFile(
    context.canonicalRoot,
    context.target,
    'FILE_NOT_FOUND'
  );
  await assertContextUnchanged(context);
  return snapshot;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset
    );
    if (result.bytesWritten === 0) {
      fail('WRITE_FAILED', 'The temporary file could not be written.');
    }
    offset += result.bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (isNodeError(error, [
      'EACCES',
      'EBADF',
      'EINVAL',
      'EISDIR',
      'ENOTSUP',
      'EPERM'
    ])) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeOwnedFile(
  target: string,
  identity: BigIntStats
): Promise<CleanupResult> {
  let current: BigIntStats;
  try {
    current = await lstat(target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      return 'missing';
    }
    return 'not-owned';
  }
  if (current.isSymbolicLink()
    || !current.isFile()
    || !sameFileIdentity(current, identity)) {
    return 'not-owned';
  }

  try {
    await unlink(target);
    return 'removed';
  } catch {
    return 'not-owned';
  }
}

/** New business targets must also be usable by Terre's file chooser.
 * Keep this separate from the historical journal/recovery path policy.
 */
export function assertReferenceableTarget(relative: string): string {
  policyFor(relative);
  // ChooseFile.tsx: commonCheckFileName. Check parent segments as well.
  if (/ -|[*#%&?@"<>|:]/.test(relative)) {
    fail('TARGET_NAME_UNSUPPORTED', 'The target name cannot be referenced safely by Terre. Choose another target name.');
  }
  return relative;
}

export function assertWritePath(relative: string, creating: boolean): string {
  if (typeof creating !== 'boolean') {
    fail('INVALID_ARGUMENT', 'The creating flag must be a boolean.');
  }
  const validated = policyFor(relative);
  if (creating ? !validated.create : !validated.replace) {
    fail(
      'PATH_INVALID',
      creating
        ? 'This WebGAL target cannot be created.'
        : 'This WebGAL target cannot be replaced.'
    );
  }
  return relative;
}

export function stagingRelative(
  relative: string,
  batchId: string,
  index: number
): string {
  policyFor(relative);
  const normalizedBatchId = normalizeBatchId(batchId);
  const normalizedIndex = normalizeIndex(index);
  const parent = parentRelative(relative);
  const temporaryName = `.wgmcp-${normalizedBatchId}-${normalizedIndex}.tmp`;
  return parent === '' ? temporaryName : `${parent}/${temporaryName}`;
}

export async function snapshotTarget(
  root: string,
  relative: string
): Promise<{ revision: string | null; bytes: Buffer | null }> {
  const context = await resolveTargetContext(root, relative);
  const snapshot = await snapshotContext(context);
  return snapshot === null
    ? { revision: null, bytes: null }
    : { revision: snapshot.revision, bytes: snapshot.bytes };
}

/** Inspect only this batch's deterministic staging path; never read/follow its contents. */
export async function inspectStaging(root: string, relative: string, batchId: string, index: number): Promise<boolean> {
  const context = await resolveTargetContext(root, relative);
  const target = path.join(context.parent, path.posix.basename(stagingRelative(relative, batchId, index)));
  try {
    await lstat(target);
    await assertContextUnchanged(context);
    return true;
  } catch (error) {
    if (isNodeError(error, ['ENOENT'])) {
      await assertContextUnchanged(context);
      return false;
    }
    throw error;
  }
}

export async function publishTarget(
  root: string,
  relative: string,
  expectedRevision: string | null,
  bytes: Uint8Array,
  batchId: string,
  index: number,
  authorize?: () => void
): Promise<void> {
  const creating = expectedRevision === null;
  const validated = assertWritePath(relative, creating);
  const normalizedExpectedRevision = normalizeRevision(expectedRevision);
  const normalizedBatchId = normalizeBatchId(batchId);
  const normalizedIndex = normalizeIndex(index);
  if (!(bytes instanceof Uint8Array)) {
    fail('INVALID_ARGUMENT', 'Target content must be bytes.');
  }
  if (bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
    fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
  }
  const content = Buffer.from(bytes);

  const context = await resolveTargetContext(root, validated);
  const initial = await snapshotContext(context);
  if (creating) {
    if (initial !== null) {
      fail('TARGET_EXISTS', 'The create-only target already exists.');
    }
  } else if (initial === null
    || initial.revision !== normalizedExpectedRevision) {
    fail('REVISION_CONFLICT', 'The target revision no longer matches the expected revision.');
  }

  const temporaryRelative = stagingRelative(validated, normalizedBatchId, normalizedIndex);
  const temporaryPath = path.join(
    context.parent,
    path.posix.basename(temporaryRelative)
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let published = false;
  try {
    await assertContextUnchanged(context);
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
    } catch (error) {
      if (isNodeError(error, ['EEXIST'])) {
        fail('STAGING_EXISTS', 'The deterministic staging file already exists.');
      }
      fail('WRITE_FAILED', 'The staging file could not be created.');
    }

    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('WRITE_FAILED', 'The staging target is not a regular file.');
    }
    temporaryIdentity = before;

    await writeAll(handle, content);
    await handle.sync();

    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after)
      || after.size !== BigInt(content.byteLength)) {
      fail('WRITE_FAILED', 'The staging file failed write-back verification.');
    }
    await handle.close();
    handle = undefined;
    await syncDirectory(context.parent);

    const staged = await readRegularFile(
      context.canonicalRoot,
      temporaryPath,
      'FILE_CHANGED'
    );
    if (!sameFileIdentity(
      (await lstat(temporaryPath, { bigint: true })),
      temporaryIdentity
    ) || !staged.bytes.equals(content)) {
      fail('FILE_CHANGED', 'The staging file changed before publication.');
    }

    await assertContextUnchanged(context);
    const current = await snapshotContext(context);
    if (creating) {
      if (current !== null) {
        fail('TARGET_EXISTS', 'The create-only target appeared before publication.');
      }
    } else if (current === null
      || current.revision !== normalizedExpectedRevision) {
      fail('REVISION_CONFLICT', 'The target revision changed before publication.');
    }
    await assertContextUnchanged(context);

    // Revoke expired/disconnected host sessions after staging IO, before publication.
    authorize?.();
    if (creating) {
      try {
        await link(temporaryPath, context.target);
      } catch (error) {
        if (isNodeError(error, ['EEXIST'])) {
          fail('TARGET_EXISTS', 'The create-only target already exists.');
        }
        if (isNodeError(error, [
          'EACCES',
          'ENOSYS',
          'ENOTSUP',
          'EOPNOTSUPP',
          'EPERM',
          'EXDEV'
        ])) {
          fail(
            'CREATE_ONLY_UNSUPPORTED',
            'Atomic create-only publication is unavailable; the target was not written.'
          );
        }
        fail('WRITE_FAILED', 'The create-only target could not be published.');
      }
      published = true;
      await syncDirectory(context.parent);
      await assertContextUnchanged(context);
    } else {
      try {
        await rename(temporaryPath, context.target);
      } catch (error) {
        if (isNodeError(error, ['EEXIST'])) {
          fail('REVISION_CONFLICT', 'The target appeared before replacement.');
        }
        fail('WRITE_FAILED', 'The target could not be replaced.');
      }
      published = true;
      await syncDirectory(context.parent);
      await assertContextUnchanged(context);
    }

    const verified = await readRegularFile(
      context.canonicalRoot,
      context.target,
      'FILE_CHANGED'
    );
    if (!verified.bytes.equals(content)) {
      fail('OUTCOME_UNKNOWN', 'The published target failed write-back verification.');
    }

    if (creating) {
      const cleanup = await removeOwnedFile(temporaryPath, temporaryIdentity);
      if (cleanup === 'not-owned') {
        fail('OUTCOME_UNKNOWN', 'The published target could not be safely detached from staging.');
      }
      await syncDirectory(context.parent);
      await assertContextUnchanged(context);
      const finalSnapshot = await readRegularFile(
        context.canonicalRoot,
        context.target,
        'FILE_CHANGED'
      );
      if (!finalSnapshot.bytes.equals(content)) {
        fail('OUTCOME_UNKNOWN', 'The published target changed after publication.');
      }
    }
    await assertContextUnchanged(context);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (temporaryIdentity) {
      await removeOwnedFile(temporaryPath, temporaryIdentity);
    }
    if (published) {
      if (error instanceof AppError && error.code === 'OUTCOME_UNKNOWN') {
        throw error;
      }
      fail('OUTCOME_UNKNOWN', 'The target may have been published, but final verification failed.');
    }
    if (error instanceof AppError) {
      throw error;
    }
    fail('WRITE_FAILED', 'The target could not be published.');
  }
}
