import type { BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { AppError } from '../errors.js';
import { validateRelativePath } from '../filesystem.js';
import type { AppConfig } from '../types.js';
import { WRITE_LIMITS } from './types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_JSON_PATTERN =
  /^keys\/[0-9a-f]{64}\/[0-9a-f]{64}\.json$/;
const PLAN_JSON_PATTERN =
  /^plans\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const JOURNAL_JSON_PATTERN =
  /^batches\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/journal\.json$/i;
const BACKUP_PATTERN =
  /^batches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/backups\/(0|[1-9][0-9]*)\.bin$/i;
const MAX_BATCH_DIRECTORIES = 1024;

interface ConfiguredRoot {
  lexical: string;
  canonical: string;
}

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
  return casefoldForPlatform(path.resolve(left)) === casefoldForPlatform(path.resolve(right));
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

function snapshotMatches(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function parentRelative(relative: string): string {
  const parent = path.posix.dirname(relative);
  return parent === '.' ? '' : parent;
}

function assertJsonRelative(relative: string): string {
  const validated = validateRelativePath(relative);
  if (!KEY_JSON_PATTERN.test(validated)
    && !PLAN_JSON_PATTERN.test(validated)
    && !JOURNAL_JSON_PATTERN.test(validated)) {
    fail('INVALID_ARGUMENT', 'The state metadata path is not an allowed key, plan, or journal path.');
  }
  return validated;
}

function assertBackupRelative(relative: string): { relative: string; index: number } {
  const validated = validateRelativePath(relative);
  const match = BACKUP_PATTERN.exec(validated);
  if (!match) {
    fail('INVALID_ARGUMENT', 'The backup path is invalid.');
  }
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index >= WRITE_LIMITS.maxFiles) {
    fail('INVALID_ARGUMENT', 'The backup index is invalid.');
  }
  return { relative: validated, index };
}

function serializeJson(value: unknown): Buffer {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('INVALID_ARGUMENT', 'The state metadata could not be serialized as JSON.');
  }
  if (serialized === undefined) {
    fail('INVALID_ARGUMENT', 'The state metadata could not be serialized as JSON.');
  }

  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.byteLength > WRITE_LIMITS.maxRecordBytes) {
    fail('FILE_TOO_LARGE', 'The state metadata exceeds the configured size limit.');
  }
  return bytes;
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, offset);
    if (result.bytesRead === 0) {
      fail('FILE_CHANGED', 'The state file changed while it was being read.');
    }
    offset += result.bytesRead;
  }
  return buffer;
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

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (isNodeError(error, ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'])) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class StateStore {
  private constructor(
    public readonly root: string,
    private readonly configuredRoots: readonly ConfiguredRoot[]
  ) {}

  static async create(stateRoot: string, config: AppConfig): Promise<StateStore> {
    if (typeof stateRoot !== 'string' || stateRoot === '' || stateRoot.includes('\0')) {
      fail('STATE_ROOT_INVALID', 'The state root is invalid.');
    }

    const requestedRoot = path.resolve(stateRoot);
    const configuredRoots: ConfiguredRoot[] = [];
    for (const root of [
      ...config.projects.map((project) => project.root),
      ...config.sources.map((source) => source.root)
    ]) {
      const lexical = path.resolve(root);
      let canonical: string;
      try {
        canonical = await realpath(lexical);
        const rootStat = await stat(canonical);
        if (!rootStat.isDirectory()) {
          fail('STATE_ROOT_INVALID', 'A configured root is not a directory.');
        }
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        fail('STATE_ROOT_INVALID', 'A configured root could not be resolved.');
      }
      configuredRoots.push({ lexical, canonical });
    }

    const expectedCanonical = await StateStore.resolveStateRootCandidate(requestedRoot);
    StateStore.assertDisjoint(requestedRoot, expectedCanonical, configuredRoots);

    try {
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, ['EEXIST'])) {
        fail('STATE_ROOT_INVALID', 'The state root could not be created.');
      }
    }

    let canonical: string;
    try {
      canonical = await realpath(requestedRoot);
      const rootStat = await stat(canonical);
      if (!rootStat.isDirectory()) {
        fail('STATE_ROOT_INVALID', 'The state root is not a directory.');
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      fail('STATE_ROOT_INVALID', 'The state root could not be resolved.');
    }

    if (!samePath(canonical, expectedCanonical)) {
      fail('STATE_ROOT_CHANGED', 'The state root changed while it was being authorized.');
    }
    StateStore.assertDisjoint(requestedRoot, canonical, configuredRoots);

    try {
      await chmod(canonical, 0o700);
    } catch {
      fail('STATE_ROOT_INVALID', 'The state root permissions could not be secured.');
    }

    return new StateStore(canonical, configuredRoots);
  }

  private static async resolveStateRootCandidate(requestedRoot: string): Promise<string> {
    let existing = requestedRoot;
    const missingSegments: string[] = [];

    while (true) {
      try {
        const entryStat = await lstat(existing);
        if (entryStat.isSymbolicLink()) {
          const canonical = await realpath(existing);
          const canonicalStat = await stat(canonical);
          if (!canonicalStat.isDirectory()) {
            fail('STATE_ROOT_INVALID', 'The state root is not a directory.');
          }
          return path.join(canonical, ...missingSegments);
        }
        if (!entryStat.isDirectory()) {
          fail('STATE_ROOT_INVALID', 'The state root is not a directory.');
        }
        const canonical = await realpath(existing);
        return path.join(canonical, ...missingSegments);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        if (!isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
          fail('STATE_ROOT_INVALID', 'The state root could not be resolved.');
        }
        if (isNodeError(error, ['ENOTDIR'])) {
          fail('STATE_ROOT_INVALID', 'A state root parent is not a directory.');
        }
      }

      const parent = path.dirname(existing);
      if (parent === existing) {
        fail('STATE_ROOT_INVALID', 'The state root could not be resolved.');
      }
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }

  private static assertDisjoint(
    requestedRoot: string,
    canonicalRoot: string,
    configuredRoots: readonly ConfiguredRoot[]
  ): void {
    for (const configured of configuredRoots) {
      if (pathsOverlap(requestedRoot, configured.lexical)
        || pathsOverlap(requestedRoot, configured.canonical)
        || pathsOverlap(canonicalRoot, configured.lexical)
        || pathsOverlap(canonicalRoot, configured.canonical)) {
        fail(
          'STATE_ROOT_OVERLAP',
          'The state root must be separate from every configured project and source root.'
        );
      }
    }
  }

  async createJson(relative: string, value: unknown): Promise<void> {
    const validated = assertJsonRelative(relative);
    const bytes = serializeJson(value);
    await this.ensureDirectory(parentRelative(validated));
    const target = await this.resolveRelative(validated);
    await this.writeNewFile(target, bytes, WRITE_LIMITS.maxRecordBytes, 'STATE_WRITE_FAILED');
  }

  async replaceJson(relative: string, value: unknown): Promise<void> {
    const validated = assertJsonRelative(relative);
    const bytes = serializeJson(value);
    const target = await this.resolveRelative(validated);
    await this.readBoundedFile(target, WRITE_LIMITS.maxRecordBytes);

    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${randomUUID()}.tmp`
    );
    let renamed = false;
    try {
      await this.writeNewFile(
        temporary,
        bytes,
        WRITE_LIMITS.maxRecordBytes,
        'STATE_WRITE_FAILED'
      );
      await this.readBoundedFile(target, WRITE_LIMITS.maxRecordBytes);
      await rename(temporary, target);
      renamed = true;
      await syncDirectory(path.dirname(target));
      await this.assertRoot();
      const verified = await this.readBoundedFile(target, WRITE_LIMITS.maxRecordBytes);
      if (!verified.equals(bytes)) {
        fail('STATE_WRITE_FAILED', 'The state metadata failed write-back verification.');
      }
    } catch (error) {
      if (!renamed) {
        await unlink(temporary).catch(() => undefined);
      }
      if (error instanceof AppError) {
        throw error;
      }
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fail('FILE_NOT_FOUND', 'The state metadata file was not found.');
      }
      fail('STATE_WRITE_FAILED', 'The state metadata could not be replaced.');
    }
  }

  async readJson<T = unknown>(relative: string): Promise<T> {
    const validated = assertJsonRelative(relative);
    const target = await this.resolveRelative(validated);
    let bytes: Buffer;
    try {
      bytes = await this.readBoundedFile(target, WRITE_LIMITS.maxRecordBytes);
    } catch (error) {
      if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') {
        fail('STATE_NOT_FOUND', 'The requested state record was not found.');
      }
      throw error;
    }
    const content = bytes.length >= 3
      && bytes[0] === 0xef
      && bytes[1] === 0xbb
      && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      fail('UNSUPPORTED_FORMAT', 'The state metadata is not valid UTF-8 JSON.');
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      fail('UNSUPPORTED_FORMAT', 'The state metadata is not valid UTF-8 JSON.');
    }
  }

  async writeBackup(batchId: string, index: number, bytes: Uint8Array): Promise<string> {
    if (typeof batchId !== 'string' || !UUID_PATTERN.test(batchId)) {
      fail('INVALID_ARGUMENT', 'The backup batch identifier is invalid.');
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= WRITE_LIMITS.maxFiles) {
      fail('INVALID_ARGUMENT', 'The backup index is invalid.');
    }
    if (!(bytes instanceof Uint8Array)) {
      fail('INVALID_ARGUMENT', 'Backup content must be bytes.');
    }
    if (bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
      fail('FILE_TOO_LARGE', 'The backup exceeds the configured size limit.');
    }

    const normalizedBatchId = batchId.toLowerCase();
    const relative = `batches/${normalizedBatchId}/backups/${index}.bin`;
    await this.ensureDirectory(`batches/${normalizedBatchId}/backups`);
    const target = await this.resolveRelative(relative);
    await this.writeNewFile(
      target,
      Buffer.from(bytes),
      WRITE_LIMITS.maxFileBytes,
      'BACKUP_FAILED'
    );
    return relative;
  }

  async readBackup(relative: string): Promise<Buffer> {
    assertBackupRelative(relative);
    const target = await this.resolveRelative(relative);
    return this.readBoundedFile(target, WRITE_LIMITS.maxFileBytes);
  }

  async listBatchIds(): Promise<string[]> {
    await this.assertRoot();
    const batches = await this.resolveRelative('batches');
    let entries;
    try {
      entries = await readdir(batches, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, ['ENOENT'])) {
        return [];
      }
      if (isNodeError(error, ['ENOTDIR', 'EISDIR'])) {
        fail('FILE_NOT_DIRECTORY', 'The batches state path is not a directory.');
      }
      fail('STATE_READ_FAILED', 'The batch state directory could not be read.');
    }

    if (entries.length > MAX_BATCH_DIRECTORIES) {
      fail('LIMIT_EXCEEDED', 'The batch state directory exceeds the entry limit.');
    }
    entries.sort((left, right) => {
      if (left.name < right.name) {
        return -1;
      }
      if (left.name > right.name) {
        return 1;
      }
      return 0;
    });

    const batchIds: string[] = [];
    for (const entry of entries) {
      if (!UUID_PATTERN.test(entry.name)) {
        continue;
      }

      const candidate = path.join(batches, entry.name);
      let entryStat;
      try {
        entryStat = await lstat(candidate);
      } catch (error) {
        if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
          fail('FILE_CHANGED', 'A batch state directory changed while it was being listed.');
        }
        fail('STATE_READ_FAILED', 'A batch state directory could not be inspected.');
      }
      if (entryStat.isSymbolicLink()) {
        fail('PATH_INVALID', 'Symbolic links are not allowed in batch state paths.');
      }
      if (!entryStat.isDirectory()) {
        continue;
      }

      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        fail('STATE_READ_FAILED', 'A batch state directory could not be resolved.');
      }
      if (!samePath(canonical, candidate) || !isWithinRoot(this.root, canonical)) {
        fail('PATH_OUTSIDE_PROJECT', 'A batch state directory is outside the authorized root.');
      }
      batchIds.push(entry.name);
    }

    await this.assertRoot();
    return batchIds;
  }

  async ensureDirectory(relative: string): Promise<void> {
    const validated = validateRelativePath(relative);
    await this.assertRoot();
    if (validated === '') {
      return;
    }

    const segments = validated.split('/');
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let entryStat;
      try {
        entryStat = await lstat(current);
      } catch (error) {
        if (!isNodeError(error, ['ENOENT'])) {
          fail('STATE_WRITE_FAILED', 'The state directory could not be inspected.');
        }
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, ['EEXIST'])) {
            fail('STATE_WRITE_FAILED', 'The state directory could not be created.');
          }
        }
        try {
          entryStat = await lstat(current);
        } catch {
          fail('STATE_WRITE_FAILED', 'The state directory could not be created.');
        }
      }

      if (entryStat.isSymbolicLink()) {
        fail('PATH_INVALID', 'Symbolic links are not allowed in state paths.');
      }
      if (!entryStat.isDirectory()) {
        fail('FILE_NOT_DIRECTORY', 'A state path component is not a directory.');
      }

      let canonical: string;
      try {
        canonical = await realpath(current);
      } catch {
        fail('STATE_WRITE_FAILED', 'The state directory could not be resolved.');
      }
      if (!samePath(canonical, current) || !isWithinRoot(this.root, canonical)) {
        fail('PATH_OUTSIDE_PROJECT', 'The state directory is outside the authorized root.');
      }

      try {
        await chmod(current, 0o700);
      } catch {
        fail('STATE_WRITE_FAILED', 'The state directory permissions could not be secured.');
      }
    }

    await this.assertRoot();
  }

  private async assertRoot(): Promise<void> {
    let canonical: string;
    try {
      canonical = await realpath(this.root);
      const rootStat = await stat(canonical);
      if (!rootStat.isDirectory()) {
        fail('STATE_ROOT_CHANGED', 'The state root is no longer a directory.');
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      fail('STATE_ROOT_CHANGED', 'The canonical state root is no longer valid.');
    }
    if (!samePath(canonical, this.root)) {
      fail('STATE_ROOT_CHANGED', 'The canonical state root was replaced.');
    }

    for (const configured of this.configuredRoots) {
      if (pathsOverlap(this.root, configured.canonical)) {
        fail('STATE_ROOT_OVERLAP', 'The state root overlaps a configured root.');
      }
    }
  }

  private async resolveRelative(relative: string): Promise<string> {
    const validated = validateRelativePath(relative);
    await this.assertRoot();
    const candidate = validated === ''
      ? this.root
      : path.join(this.root, ...validated.split('/'));
    if (!isWithinRoot(this.root, candidate)) {
      fail('PATH_OUTSIDE_PROJECT', 'The requested state path is outside the authorized root.');
    }

    let current = this.root;
    const segments = validated === '' ? [] : validated.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index] as string);
      let entryStat;
      try {
        entryStat = await lstat(current);
      } catch (error) {
        if (isNodeError(error, ['ENOENT'])) {
          break;
        }
        if (isNodeError(error, ['ENOTDIR'])) {
          fail('FILE_NOT_DIRECTORY', 'A state path component is not a directory.');
        }
        fail('STATE_READ_FAILED', 'The requested state path could not be inspected.');
      }

      if (entryStat.isSymbolicLink()) {
        fail('PATH_INVALID', 'Symbolic links are not allowed in state paths.');
      }
      if (index < segments.length - 1 && !entryStat.isDirectory()) {
        fail('FILE_NOT_DIRECTORY', 'A state path component is not a directory.');
      }
    }

    try {
      const canonical = await realpath(candidate);
      if (!samePath(canonical, candidate) || !isWithinRoot(this.root, canonical)) {
        fail('PATH_OUTSIDE_PROJECT', 'The requested state path is outside the authorized root.');
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (!isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fail('STATE_READ_FAILED', 'The requested state path could not be resolved.');
      }
    }

    await this.assertRoot();
    return candidate;
  }

  private async readBoundedFile(target: string, maximum: number): Promise<Buffer> {
    await this.assertRoot();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target, 'r');
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        fail('FILE_NOT_REGULAR', 'The requested state target is not a regular file.');
      }
      if (before.size > BigInt(maximum)) {
        fail('FILE_TOO_LARGE', 'The requested state file exceeds the configured size limit.');
      }

      const canonical = await realpath(target);
      if (!samePath(canonical, target) || !isWithinRoot(this.root, canonical)) {
        fail('PATH_OUTSIDE_PROJECT', 'The requested state path is outside the authorized root.');
      }
      const pathBefore = await stat(target, { bigint: true });
      if (!pathBefore.isFile()
        || pathBefore.dev !== before.dev
        || pathBefore.ino !== before.ino) {
        fail('FILE_CHANGED', 'The state file changed while it was being read.');
      }

      const bytes = await readBounded(handle, maximum);
      const after = await handle.stat({ bigint: true });
      const pathAfter = await stat(target, { bigint: true });
      if (!snapshotMatches(before, after)
        || !snapshotMatches(before, pathAfter)
        || BigInt(bytes.byteLength) !== after.size) {
        fail('FILE_CHANGED', 'The state file changed while it was being read.');
      }
      if (bytes.byteLength > maximum) {
        fail('FILE_TOO_LARGE', 'The requested state file exceeds the configured size limit.');
      }

      await this.assertRoot();
      return bytes;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fail('FILE_NOT_FOUND', 'The requested state file was not found.');
      }
      if (isNodeError(error, ['EACCES', 'EPERM'])) {
        fail('STATE_READ_FAILED', 'The requested state file could not be read.');
      }
      if (isNodeError(error, ['EISDIR'])) {
        fail('FILE_NOT_REGULAR', 'The requested state target is not a regular file.');
      }
      return fail('STATE_READ_FAILED', 'The requested state file could not be read.');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeNewFile(
    target: string,
    bytes: Buffer,
    maximum: number,
    failureCode: string
  ): Promise<void> {
    await this.assertRoot();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let createdIdentity: BigIntStats | undefined;
    try {
      handle = await open(target, 'wx+', 0o600);
      createdIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(bytes);
      await handle.sync();

      const written = await handle.stat({ bigint: true });
      if (!written.isFile() || written.size !== BigInt(bytes.byteLength)) {
        fail(failureCode, 'The state file failed write-back verification.');
      }
      const inHandle = await readExactly(handle, bytes.byteLength);
      if (!inHandle.equals(bytes)) {
        fail(failureCode, 'The state file failed write-back verification.');
      }

      await handle.close();
      handle = undefined;
      await syncDirectory(path.dirname(target));
      await this.assertRoot();
      const verified = await this.readBoundedFile(target, maximum);
      if (!verified.equals(bytes)) {
        fail(failureCode, 'The state file failed write-back verification.');
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (createdIdentity) {
        await this.removeCreatedFile(target, createdIdentity);
      }
      if (error instanceof AppError) {
        throw error;
      }
      if (isNodeError(error, ['EEXIST'])) {
        fail('TARGET_EXISTS', 'The state target already exists.');
      }
      fail(failureCode, 'The state file could not be written.');
    }
  }

  private async removeCreatedFile(target: string, identity: BigIntStats): Promise<void> {
    try {
      const current = await lstat(target, { bigint: true });
      if (current.isFile() && sameFileIdentity(current, identity)) {
        await unlink(target);
      }
    } catch {
      // Cleanup is best-effort and must never remove a target we cannot identify.
    }
  }
}
