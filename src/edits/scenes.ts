import { TextDecoder } from 'node:util';
import { AppError } from '../errors.js';
import { LIMITS } from '../types.js';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function invalidEdit(message: string): never {
  throw new AppError('INVALID_ARGUMENT', message);
}

function unsupportedFormat(): never {
  throw new AppError('UNSUPPORTED_FORMAT', 'The scene is not supported UTF-8 text.');
}

function fileTooLarge(): never {
  throw new AppError('FILE_TOO_LARGE', 'The scene exceeds the configured size limit.');
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasUnsupportedControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateSceneText(value: string, invalid: () => never): void {
  if (typeof value !== 'string' || hasLoneSurrogate(value) || hasUnsupportedControl(value)) {
    invalid();
  }
}

function decodeScene(bytes: Uint8Array): { text: string; bom: Buffer | null } {
  if (!(bytes instanceof Uint8Array)) {
    invalidEdit('Scene bytes must be a Uint8Array.');
  }
  if (bytes.byteLength > LIMITS.textBytes) {
    fileTooLarge();
  }

  const buffer = Buffer.from(bytes);
  if (buffer.length >= 2
    && ((buffer[0] === 0xff && buffer[1] === 0xfe)
      || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    unsupportedFormat();
  }

  const hasBom = buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf;
  const content = hasBom ? buffer.subarray(3) : buffer;
  if (content.includes(0)) {
    unsupportedFormat();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    unsupportedFormat();
  }
  validateSceneText(text, unsupportedFormat);
  return { text, bom: hasBom ? buffer.subarray(0, 3) : null };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return false;
  }
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff
    && current >= 0xdc00 && current <= 0xdfff;
}

function validateEdit(edit: unknown, text: string): TextEdit {
  if (typeof edit !== 'object' || edit === null) {
    invalidEdit('Each scene edit must be an object.');
  }
  const candidate = edit as Partial<TextEdit>;
  const start = candidate.start;
  const end = candidate.end;
  const replacement = candidate.text;
  if (typeof start !== 'number'
    || typeof end !== 'number'
    || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || typeof replacement !== 'string') {
    invalidEdit('Scene edit offsets and replacement text are invalid.');
  }
  if (start < 0 || end < start || end > text.length) {
    invalidEdit('Scene edit range is outside the original text.');
  }
  if (start === end && replacement === '') {
    invalidEdit('An empty insertion is not a scene edit.');
  }
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) {
    invalidEdit('A scene edit cannot split a surrogate pair.');
  }
  validateSceneText(replacement, () => invalidEdit('The replacement text is invalid.'));
  return { start, end, text: replacement };
}

function validateEditOrder(edits: TextEdit[]): void {
  for (let index = 1; index < edits.length; index += 1) {
    const previous = edits[index - 1] as TextEdit;
    const current = edits[index] as TextEdit;
    if (current.start < previous.start
      || current.start < previous.end
      || current.start === previous.start) {
      invalidEdit('Scene edits must be ordered and unambiguous.');
    }
  }
}

function assertProjectedSceneSize(
  text: string,
  bom: Buffer | null,
  edits: TextEdit[]
): void {
  let byteLength = bom?.byteLength ?? 0;
  let cursor = 0;
  for (const edit of edits) {
    byteLength += Buffer.byteLength(text.slice(cursor, edit.start), 'utf8');
    byteLength += Buffer.byteLength(edit.text, 'utf8');
    if (byteLength > LIMITS.textBytes) {
      fileTooLarge();
    }
    cursor = edit.end;
  }
  byteLength += Buffer.byteLength(text.slice(cursor), 'utf8');
  if (byteLength > LIMITS.textBytes) {
    fileTooLarge();
  }
}

function encodeScene(text: string, bom: Buffer | null): Buffer {
  validateSceneText(text, () => invalidEdit('The scene text is invalid.'));
  const byteLength = (bom?.byteLength ?? 0) + Buffer.byteLength(text, 'utf8');
  if (byteLength > LIMITS.textBytes) {
    fileTooLarge();
  }
  const encoded = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([bom, encoded]) : encoded;
}

export function applySceneEdits(bytes: Uint8Array, edits: TextEdit[]): Buffer {
  const decoded = decodeScene(bytes);
  if (!Array.isArray(edits) || edits.length === 0) {
    invalidEdit('At least one scene edit is required.');
  }
  const normalized = edits.map((edit) => validateEdit(edit, decoded.text));
  validateEditOrder(normalized);
  assertProjectedSceneSize(decoded.text, decoded.bom, normalized);

  let cursor = 0;
  let text = '';
  for (const edit of normalized) {
    text += decoded.text.slice(cursor, edit.start);
    text += edit.text;
    cursor = edit.end;
  }
  text += decoded.text.slice(cursor);
  return encodeScene(text, decoded.bom);
}

export function createScene(text: string): Buffer {
  return encodeScene(text, null);
}
