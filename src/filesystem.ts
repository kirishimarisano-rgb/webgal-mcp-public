import type { BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  stat
} from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { AppError } from './errors.js';
import type { FileEntry, TextDocument } from './types.js';
import { LIMITS } from './types.js';

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function pathInvalid(message = 'The relative path is invalid.'): never {
  throw new AppError('PATH_INVALID', message);
}

function fileNotFound(): never {
  throw new AppError('FILE_NOT_FOUND', 'The requested file or directory was not found.');
}

function fileNotRegular(): never {
  throw new AppError('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
}

function fileNotDirectory(): never {
  throw new AppError('FILE_NOT_DIRECTORY', 'The requested target is not a directory.');
}

function fileTooLarge(): never {
  throw new AppError('FILE_TOO_LARGE', 'The requested file exceeds the configured size limit.');
}

function unsupportedFormat(): never {
  throw new AppError('UNSUPPORTED_FORMAT', 'The requested file is not supported UTF-8 text.');
}

function fileChanged(): never {
  throw new AppError('FILE_CHANGED', 'The requested file changed while it was being read.');
}

function tooManyEntries(): never {
  throw new AppError('TOO_MANY_ENTRIES', 'The requested directory exceeds the entry limit.');
}

function isNodeError(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function throwMappedReadError(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }
  if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
    fileNotFound();
  }
  if (isNodeError(error, ['EACCES', 'EPERM'])) {
    throw new AppError('FILE_NOT_READABLE', 'The requested file could not be read.');
  }
  if (isNodeError(error, ['ELOOP'])) {
    throw new AppError('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
  }
  if (isNodeError(error, ['EISDIR'])) {
    fileNotRegular();
  }
  throw new AppError('FILE_READ_FAILED', 'The requested file could not be read.');
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

async function resolveAuthorizedRoot(root: string): Promise<string> {
  const expectedRoot = path.resolve(root);
  try {
    const resolved = await realpath(expectedRoot);
    if (!samePath(resolved, expectedRoot)) {
      throw new AppError(
        'PROJECT_NOT_AUTHORIZED',
        'The authorized root is no longer canonical.'
      );
    }
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      pathInvalid('The authorized root is not a directory.');
    }
    return resolved;
  } catch (error) {
    throwMappedReadError(error);
  }
}

export function validateRelativePath(input: string): string {
  if (input === '') {
    return '';
  }

  if (typeof input !== 'string'
    || input.includes('\0')
    || /[\u0000-\u001f\u007f]/.test(input)
    || input.includes('%')
    || input.includes('\\')
    || input.startsWith('/')
    || path.posix.isAbsolute(input)
    || path.win32.isAbsolute(input)) {
    pathInvalid();
  }

  const segments = input.split('/');
  for (const segment of segments) {
    if (segment === ''
      || segment === '.'
      || segment === '..'
      || /[<>:"|?*]/.test(segment)
      || /[. ]$/.test(segment)) {
      pathInvalid();
    }

    const baseName = segment.split('.')[0].replace(/[ .]+$/g, '');
    if (WINDOWS_RESERVED_NAME.test(baseName)) {
      pathInvalid('The relative path uses a reserved Windows name.');
    }
  }

  return input;
}

export async function resolveSafe(root: string, relative: string): Promise<string> {
  const rootResolved = await resolveAuthorizedRoot(root);
  const validated = validateRelativePath(relative);
  const candidate = validated === ''
    ? rootResolved
    : path.join(rootResolved, ...validated.split('/'));

  try {
    const target = await realpath(candidate);
    if (!isWithinRoot(rootResolved, target)) {
      throw new AppError('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
    }
    return target;
  } catch (error) {
    throwMappedReadError(error);
  }
}

async function assertNoSymlinkSegments(rootResolved: string, relative: string): Promise<void> {
  if (relative === '') {
    return;
  }

  let current = rootResolved;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let entryStat;
    try {
      entryStat = await lstat(current);
    } catch (error) {
      throwMappedReadError(error);
    }

    if (entryStat.isSymbolicLink()) {
      pathInvalid('Symbolic links are not allowed in requested paths.');
    }
  }
}

function snapshotMatches(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readLimited(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
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

function detectNewline(text: string): TextDocument['newline'] {
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (code === 0x0a) {
      lf += 1;
    }
  }

  if (crlf === 0 && lf === 0 && cr === 0) {
    return 'none';
  }
  if (crlf > 0 && lf === 0 && cr === 0) {
    return 'crlf';
  }
  if (lf > 0 && crlf === 0 && cr === 0) {
    return 'lf';
  }
  return 'mixed';
}

function decodeText(bytes: Buffer): Pick<TextDocument, 'text' | 'encoding'> {
  if (bytes.length >= 2
    && ((bytes[0] === 0xff && bytes[1] === 0xfe)
      || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    unsupportedFormat();
  }

  const hasUtf8Bom = bytes.length >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf;
  const content = hasUtf8Bom ? bytes.subarray(3) : bytes;

  if (content.includes(0)) {
    unsupportedFormat();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    unsupportedFormat();
  }

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      unsupportedFormat();
    }
  }

  return {
    text,
    encoding: hasUtf8Bom ? 'utf-8-bom' : 'utf-8'
  };
}

export async function readText(root: string, relative: string): Promise<TextDocument> {
  const rootResolved = await resolveAuthorizedRoot(root);
  const target = await resolveSafe(rootResolved, relative);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(target, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fileNotRegular();
    }
    if (before.size > BigInt(LIMITS.textBytes)) {
      fileTooLarge();
    }

    const targetAfterOpen = await realpath(target);
    if (!samePath(target, targetAfterOpen)) {
      fileChanged();
    }
    if (!isWithinRoot(rootResolved, targetAfterOpen)) {
      throw new AppError('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
    }

    const bytes = await readLimited(handle);
    const after = await handle.stat({ bigint: true });
    if (!snapshotMatches(before, after)
      || BigInt(bytes.byteLength) !== after.size) {
      fileChanged();
    }
    if (bytes.byteLength > LIMITS.textBytes) {
      fileTooLarge();
    }

    const decoded = decodeText(bytes);
    return {
      text: decoded.text,
      revision: createHash('sha256').update(bytes).digest('hex'),
      encoding: decoded.encoding,
      newline: detectNewline(decoded.text),
      bytes: bytes.byteLength,
      source: 'disk'
    };
  } catch (error) {
    return throwMappedReadError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeExtensions(extensions: string[] | undefined): Set<string> | undefined {
  if (!extensions || extensions.length === 0) {
    return undefined;
  }

  const normalized = new Set<string>();
  for (const extension of extensions) {
    const trimmed = extension.trim().toLowerCase();
    if (trimmed === ''
      || trimmed === '.'
      || /[\u0000-\u001f\u007f/\\:*?"<>|%]/.test(trimmed)) {
      throw new AppError('INVALID_ARGUMENT', 'An extension filter is invalid.');
    }
    normalized.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return normalized;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export async function listFiles(
  root: string,
  relative: string,
  extensions?: string[]
): Promise<FileEntry[]> {
  const rootResolved = await resolveAuthorizedRoot(root);
  const validated = validateRelativePath(relative);
  const start = await resolveSafe(rootResolved, validated);
  await assertNoSymlinkSegments(rootResolved, validated);

  let startStat;
  try {
    startStat = await lstat(start);
  } catch (error) {
    throwMappedReadError(error);
  }
  if (startStat.isSymbolicLink()) {
    pathInvalid('Symbolic links are not allowed in requested paths.');
  }
  if (!startStat.isDirectory()) {
    fileNotDirectory();
  }

  const extensionSet = normalizeExtensions(extensions);
  const entries: FileEntry[] = [];
  const visitedDirectories = new Set<string>();
  let seenEntries = 0;

  const walk = async (directory: string, directoryRelative: string): Promise<void> => {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch (error) {
      throwMappedReadError(error);
    }
    if (!isWithinRoot(rootResolved, canonicalDirectory)) {
      throw new AppError('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
    }

    const visitKey = casefoldForPlatform(canonicalDirectory);
    if (visitedDirectories.has(visitKey)) {
      fileChanged();
    }
    visitedDirectories.add(visitKey);

    let directoryEntries;
    try {
      directoryEntries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        fileChanged();
      }
      throwMappedReadError(error);
    }

    directoryEntries.sort((left, right) => compareCodePoints(left.name, right.name));

    for (const directoryEntry of directoryEntries) {
      seenEntries += 1;
      if (seenEntries > LIMITS.entries) {
        tooManyEntries();
      }
      if (directoryEntry.isSymbolicLink()) {
        continue;
      }

      const entryPath = path.join(directory, directoryEntry.name);
      const entryRelative = directoryRelative === ''
        ? directoryEntry.name
        : `${directoryRelative}/${directoryEntry.name}`;

      let entryStat;
      try {
        entryStat = await lstat(entryPath);
      } catch (error) {
        if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
          fileChanged();
        }
        throwMappedReadError(error);
      }

      if (entryStat.isSymbolicLink()) {
        continue;
      }

      if (entryStat.isDirectory()) {
        await walk(entryPath, entryRelative);
        continue;
      }

      if (!entryStat.isFile()) {
        continue;
      }

      const lowerRelative = entryRelative.toLowerCase();
      if (extensionSet && ![...extensionSet].some((extension) => lowerRelative.endsWith(extension))) {
        continue;
      }

      let canonicalEntry: string;
      try {
        canonicalEntry = await realpath(entryPath);
      } catch (error) {
        if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
          fileChanged();
        }
        throwMappedReadError(error);
      }
      if (!isWithinRoot(rootResolved, canonicalEntry)) {
        throw new AppError('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
      }

      let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        fileHandle = await open(entryPath, 'r');
        const fileStat = await fileHandle.stat();
        if (!fileStat.isFile()) {
          continue;
        }

        const canonicalAfterOpen = await realpath(entryPath);
        if (!samePath(canonicalEntry, canonicalAfterOpen)) {
          fileChanged();
        }
        if (!isWithinRoot(rootResolved, canonicalAfterOpen)) {
          throw new AppError('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
        }

        entries.push({
          path: entryRelative,
          size: fileStat.size,
          lastModified: fileStat.mtimeMs
        });
      } catch (error) {
        if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
          fileChanged();
        }
        throwMappedReadError(error);
      } finally {
        await fileHandle?.close().catch(() => undefined);
      }
    }
  };

  await walk(start, validated);
  return entries.sort((left, right) => compareCodePoints(left.path, right.path));
}
