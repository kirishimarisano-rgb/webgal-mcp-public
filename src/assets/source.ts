import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  realpath
} from 'node:fs/promises';
import * as path from 'node:path';
import { AppError } from '../errors.js';
import { validateRelativePath } from '../filesystem.js';
import { canonicalProjectKey } from '../changes/locks.js';
import type { AppConfig, SourceConfig } from '../types.js';
import { LIMITS } from '../types.js';

function sourceNotAuthorized(): never {
  throw new AppError('SOURCE_NOT_AUTHORIZED', 'Source is not authorized.');
}

function pathInvalid(message = 'The source path is invalid.'): never {
  throw new AppError('PATH_INVALID', message);
}

function fileNotFound(): never {
  throw new AppError('FILE_NOT_FOUND', 'The requested source file was not found.');
}

function fileNotRegular(): never {
  throw new AppError('FILE_NOT_REGULAR', 'The requested source target is not a regular file.');
}

function fileNotDirectory(): never {
  throw new AppError('FILE_NOT_DIRECTORY', 'A source path component is not a directory.');
}

function fileTooLarge(): never {
  throw new AppError('FILE_TOO_LARGE', 'The requested source file exceeds the configured size limit.');
}

function fileChanged(): never {
  throw new AppError('FILE_CHANGED', 'The source file changed while it was being read.');
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

function mapInspectionError(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }
  if (isNodeError(error, ['ENOENT'])) {
    fileNotFound();
  }
  if (isNodeError(error, ['ENOTDIR'])) {
    fileNotDirectory();
  }
  if (isNodeError(error, ['ELOOP'])) {
    pathInvalid('Symbolic links are not allowed in source paths.');
  }
  if (isNodeError(error, ['EACCES', 'EPERM'])) {
    throw new AppError('FILE_NOT_READABLE', 'The requested source path could not be read.');
  }
  if (isNodeError(error, ['EISDIR'])) {
    fileNotRegular();
  }
  throw new AppError('FILE_READ_FAILED', 'The requested source file could not be read.');
}

function findSource(config: AppConfig, sourceId: string): SourceConfig {
  if (typeof sourceId !== 'string'
    || sourceId === ''
    || typeof config !== 'object'
    || config === null
    || !Array.isArray(config.sources)) {
    sourceNotAuthorized();
  }
  const source = config.sources.find((candidate) => candidate?.id === sourceId);
  if (!source) {
    sourceNotAuthorized();
  }
  return source;
}

async function canonicalSourceRoot(source: SourceConfig): Promise<{
  root: string;
  rootKey: string;
  rootIdentity: BigIntStats;
}> {
  let rootKey: string;
  try {
    rootKey = await canonicalProjectKey(source.root);
  } catch {
    sourceNotAuthorized();
  }

  let root: string;
  try {
    root = await realpath(path.resolve(source.root));
  } catch {
    sourceNotAuthorized();
  }
  if (!samePath(root, path.resolve(source.root))) {
    sourceNotAuthorized();
  }

  let rootIdentity: BigIntStats;
  try {
    rootIdentity = await lstat(root, { bigint: true });
  } catch {
    sourceNotAuthorized();
  }
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) {
    sourceNotAuthorized();
  }
  return { root, rootKey, rootIdentity };
}

async function assertRootIdentity(root: string, rootIdentity: BigIntStats): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(root, { bigint: true });
  } catch {
    sourceNotAuthorized();
  }
  if (current.isSymbolicLink()
    || !current.isDirectory()
    || !sameFileIdentity(rootIdentity, current)) {
    sourceNotAuthorized();
  }
}

async function assertNoSymlinkSegments(
  root: string,
  relative: string,
  rootIdentity: BigIntStats
): Promise<void> {
  await assertRootIdentity(root, rootIdentity);
  let current = root;
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string);
    let entryStat: BigIntStats;
    try {
      entryStat = await lstat(current, { bigint: true });
    } catch (error) {
      mapInspectionError(error);
    }
    if (entryStat.isSymbolicLink()) {
      pathInvalid('Symbolic links are not allowed in source paths.');
    }
    if (index < segments.length - 1 && !entryStat.isDirectory()) {
      fileNotDirectory();
    }
  }
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(LIMITS.textBytes + 1);
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

async function assertRootAndParentUnchanged(
  source: SourceConfig,
  root: string,
  rootKey: string,
  rootIdentity: BigIntStats,
  parent: string,
  parentIdentity: BigIntStats
): Promise<void> {
  let rootAfter: BigIntStats;
  try {
    rootAfter = await lstat(root, { bigint: true });
  } catch {
    sourceNotAuthorized();
  }
  if (rootAfter.isSymbolicLink()
    || !rootAfter.isDirectory()
    || !sameFileIdentity(rootIdentity, rootAfter)) {
    sourceNotAuthorized();
  }

  let parentAfter: BigIntStats;
  try {
    parentAfter = await lstat(parent, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      fileChanged();
    }
    mapInspectionError(error);
  }
  if (parentAfter.isSymbolicLink()
    || !parentAfter.isDirectory()
    || !sameFileIdentity(parentIdentity, parentAfter)) {
    fileChanged();
  }

  let rootKeyAfter: string;
  try {
    rootKeyAfter = await canonicalProjectKey(source.root);
  } catch {
    sourceNotAuthorized();
  }
  if (rootKeyAfter !== rootKey) {
    sourceNotAuthorized();
  }
}

export async function readSource(
  config: AppConfig,
  sourceId: string,
  relative: string
): Promise<{ bytes: Buffer; revision: string; rootKey: string }> {
  const source = findSource(config, sourceId);
  const validated = validateRelativePath(relative);
  if (validated === '') {
    pathInvalid();
  }

  const { root, rootKey, rootIdentity } = await canonicalSourceRoot(source);
  const target = path.join(root, ...validated.split('/'));
  if (!isWithinRoot(root, target)) {
    pathInvalid('The requested source path is outside the authorized root.');
  }

  await assertNoSymlinkSegments(root, validated, rootIdentity);
  const parent = path.dirname(target);
  let parentIdentity: BigIntStats;
  try {
    parentIdentity = await lstat(parent, { bigint: true });
  } catch (error) {
    mapInspectionError(error);
  }
  if (parentIdentity.isSymbolicLink() || !parentIdentity.isDirectory()) {
    pathInvalid('The source parent is not a regular directory.');
  }

  let targetBefore: BigIntStats;
  try {
    targetBefore = await lstat(target, { bigint: true });
  } catch (error) {
    mapInspectionError(error);
  }
  if (targetBefore.isSymbolicLink() || !targetBefore.isFile()) {
    fileNotRegular();
  }
  if (targetBefore.size > BigInt(LIMITS.textBytes)) {
    fileTooLarge();
  }
  await assertRootIdentity(root, rootIdentity);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fileNotRegular();
    }
    if (!snapshotMatches(targetBefore, before)) {
      fileChanged();
    }
    if (before.size > BigInt(LIMITS.textBytes)) {
      fileTooLarge();
    }

    let targetAfterOpen: string;
    try {
      targetAfterOpen = await realpath(target);
    } catch (error) {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fileChanged();
      }
      mapInspectionError(error);
    }
    if (!samePath(target, targetAfterOpen) || !isWithinRoot(root, targetAfterOpen)) {
      pathInvalid('The source target is not a canonical regular file.');
    }
    let pathAfterOpen: BigIntStats;
    try {
      pathAfterOpen = await lstat(target, { bigint: true });
    } catch (error) {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fileChanged();
      }
      mapInspectionError(error);
    }
    if (pathAfterOpen.isSymbolicLink()
      || !pathAfterOpen.isFile()
      || !snapshotMatches(before, pathAfterOpen)) {
      fileChanged();
    }

    const bytes = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    let pathAfter: BigIntStats;
    try {
      pathAfter = await lstat(target, { bigint: true });
    } catch (error) {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fileChanged();
      }
      mapInspectionError(error);
    }
    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !snapshotMatches(before, after)
      || !snapshotMatches(before, pathAfter)
      || BigInt(bytes.byteLength) !== after.size) {
      fileChanged();
    }
    if (bytes.byteLength > LIMITS.textBytes) {
      fileTooLarge();
    }

    await assertRootAndParentUnchanged(
      source,
      root,
      rootKey,
      rootIdentity,
      parent,
      parentIdentity
    );

    return {
      bytes,
      revision: createHash('sha256').update(bytes).digest('hex'),
      rootKey
    };
  } catch (error) {
    return mapInspectionError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function inspectSource(
  config: AppConfig,
  sourceId: string,
  relative: string
): Promise<{ sourceId: string; path: string; revision: string; bytes: number }> {
  const validated = validateRelativePath(relative);
  if (validated === '') {
    pathInvalid();
  }
  const result = await readSource(config, sourceId, validated);
  return {
    sourceId,
    path: validated,
    revision: result.revision,
    bytes: result.bytes.byteLength
  };
}
