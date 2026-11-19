import { TextDecoder } from 'node:util';
import { KNOWN_CONFIG_KEYS } from '../analysis.js';
import { AppError } from '../errors.js';
import { LIMITS } from '../types.js';

export interface ConfigUpdate {
  key: string;
  value: string;
}

interface TextLine {
  start: number;
  contentEnd: number;
  end: number;
  ending: '\n' | '\r\n' | '';
}

interface ConfigItemLine {
  command: string;
  commandRaw: string;
  colonIndex: number;
  valueText: string;
  valueStart: number;
  valueEnd: number;
  semicolonIndex: number | null;
  colonBefore: string;
  colonAfter: string;
  semiBefore: string;
  hasCommandWhitespaceBeforeColon: boolean;
  hasOptions: boolean;
  hasEscapedPipe: boolean;
  hasEscapedTerminator: boolean;
}

interface InsertionStyle {
  newline: '\n' | '\r\n';
  colonBefore: string;
  colonAfter: string;
  semiBefore: string;
  hasTerminator: boolean;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const MULTI_VALUE_KEYS = new Set(['Title_logos', 'Game_Logo']);

/*
 * Supported subset: one key per line, the first colon separates key/value,
 * the first semicolon terminates the value, LF/CRLF are preserved, and only
 * the value core of a recognized key is replaced. Options, escaped parser
 * delimiters, scalar pipes, unknown-only insertion styles, and mixed insertion
 * styles are rejected because the source parser cannot represent them
 * unambiguously.
 */

function fail(code: string, message: string): never {
  throw new AppError(code, message);
}

function invalidArgument(message: string): never {
  fail('INVALID_ARGUMENT', message);
}

function ambiguous(message = 'The configuration format is ambiguous.'): never {
  fail('CONFIG_AMBIGUOUS', message);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasUnsupportedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateUpdateValue(key: string, value: string): void {
  if (typeof value !== 'string') {
    invalidArgument('A configuration value must be a string.');
  }
  if (hasLoneSurrogate(value)) {
    invalidArgument('A configuration value contains an invalid Unicode surrogate.');
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) {
    invalidArgument('A configuration value contains a control character or newline.');
  }
  if (value.includes(';')) {
    invalidArgument('A configuration value cannot contain the config terminator.');
  }
  if (value !== value.trim()) {
    invalidArgument('A configuration value cannot have leading or trailing whitespace.');
  }
  if (value.includes(' -')) {
    invalidArgument('A configuration value cannot inject parser options.');
  }
  if (!MULTI_VALUE_KEYS.has(key) && value.includes('|')) {
    invalidArgument('This configuration key accepts a single value.');
  }
  if (MULTI_VALUE_KEYS.has(key)
    && value !== ''
    && value.split('|').some((part) => part.trim() === '')) {
    invalidArgument('A multi-value configuration entry contains an empty item.');
  }
}

function validateUpdates(updates: ConfigUpdate[]): Map<string, string> {
  if (!Array.isArray(updates)) {
    invalidArgument('Configuration updates must be an array.');
  }
  if (updates.length === 0) {
    invalidArgument('At least one configuration update is required.');
  }

  const result = new Map<string, string>();
  for (const update of updates) {
    if (typeof update !== 'object' || update === null) {
      invalidArgument('A configuration update is invalid.');
    }
    const { key, value } = update as Partial<ConfigUpdate>;
    if (typeof key !== 'string' || !KNOWN_CONFIG_KEYS.has(key)) {
      invalidArgument('The configuration key is not supported.');
    }
    if (result.has(key)) {
      invalidArgument('A configuration key cannot be updated more than once.');
    }
    validateUpdateValue(key, value as string);
    result.set(key, value as string);
  }
  return result;
}

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) !== 0x0a) {
        ambiguous('Lone carriage returns are not supported.');
      }
      lines.push({
        start,
        contentEnd: index,
        end: index + 2,
        ending: '\r\n',
      });
      index += 1;
      start = index + 1;
    } else if (code === 0x0a) {
      lines.push({
        start,
        contentEnd: index,
        end: index + 1,
        ending: '\n',
      });
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push({
      start,
      contentEnd: text.length,
      end: text.length,
      ending: '',
    });
  }
  return lines;
}

function parseConfigItem(text: string, line: TextLine): ConfigItemLine | null {
  const content = text.slice(line.start, line.contentEnd);
  const semicolonOffset = content.indexOf(';');
  const statementEnd = semicolonOffset === -1 ? content.length : semicolonOffset;
  const statement = content.slice(0, statementEnd);
  if (statement.trim() === '') {
    return null;
  }

  const colonOffset = statement.indexOf(':');
  if (colonOffset === -1) {
    const possibleKey = statement.trim().split(/\s+/, 1)[0];
    if (possibleKey !== undefined && KNOWN_CONFIG_KEYS.has(possibleKey)) {
      ambiguous('Configuration key "' + possibleKey + '" has no unambiguous colon separator.');
    }
    return null;
  }

  const commandRaw = statement.slice(0, colonOffset);
  const command = commandRaw.trim();
  if (command === '') {
    return null;
  }
  let valueOffset = colonOffset + 1;
  while (valueOffset < statementEnd
    && (content[valueOffset] === ' ' || content[valueOffset] === '\t')) {
    valueOffset += 1;
  }
  let valueEndOffset = statementEnd;
  while (valueEndOffset > valueOffset
    && (content[valueEndOffset - 1] === ' ' || content[valueEndOffset - 1] === '\t')) {
    valueEndOffset -= 1;
  }

  return {
    command,
    commandRaw,
    colonIndex: line.start + colonOffset,
    valueText: content.slice(valueOffset, valueEndOffset),
    valueStart: line.start + valueOffset,
    valueEnd: line.start + valueEndOffset,
    semicolonIndex: semicolonOffset === -1 ? null : line.start + semicolonOffset,
    colonBefore: commandRaw.slice(command.length),
    colonAfter: content.slice(colonOffset + 1, valueOffset),
    semiBefore: content.slice(valueEndOffset, statementEnd),
    hasCommandWhitespaceBeforeColon: commandRaw !== command,
    hasOptions: content.slice(colonOffset + 1, statementEnd).includes(' -'),
    hasEscapedPipe: content.slice(colonOffset + 1, statementEnd).includes('\\|'),
    hasEscapedTerminator: semicolonOffset > 0 && content[semicolonOffset - 1] === '\\',
  };
}

function parseItems(text: string): {
  lines: TextLine[];
  items: ConfigItemLine[];
  byKey: Map<string, ConfigItemLine>;
} {
  const lines = splitLines(text);
  const items: ConfigItemLine[] = [];
  const byKey = new Map<string, ConfigItemLine>();
  for (const line of lines) {
    const item = parseConfigItem(text, line);
    if (!item) {
      continue;
    }
    if (byKey.has(item.command)) {
      fail(
        'CONFIG_DUPLICATE_KEY',
        'Configuration key "' + item.command + '" appears more than once.',
      );
    }
    byKey.set(item.command, item);
    items.push(item);
  }
  return { lines, items, byKey };
}

function assertEditableTarget(item: ConfigItemLine): void {
  if (item.hasCommandWhitespaceBeforeColon) {
    ambiguous('Editing a configuration entry with whitespace before its colon is not supported.');
  }
  if (item.hasOptions) {
    ambiguous('Editing a configuration entry with parser options is not supported.');
  }
  if (item.hasEscapedPipe || item.hasEscapedTerminator) {
    ambiguous('Editing a configuration entry with escaped parser delimiters is not supported.');
  }
  if (!MULTI_VALUE_KEYS.has(item.command) && item.valueText.includes('|')) {
    ambiguous('Editing a scalar configuration entry with multiple arguments is not supported.');
  }
}

function inferNewline(text: string): '\n' | '\r\n' | null {
  let hasLf = false;
  let hasCrlf = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      if (index > 0 && text.charCodeAt(index - 1) === 0x0d) {
        hasCrlf = true;
      } else {
        hasLf = true;
      }
    }
  }
  if (hasLf && hasCrlf) {
    return null;
  }
  return hasCrlf ? '\r\n' : '\n';
}

function uniqueStyleValue(
  items: ConfigItemLine[],
  read: (item: ConfigItemLine) => string,
): string {
  const values = new Set(items.map(read));
  if (values.size !== 1) {
    ambiguous('The existing configuration does not have one unambiguous insertion style.');
  }
  return values.values().next().value as string;
}

function inferInsertionStyle(text: string, items: ConfigItemLine[]): InsertionStyle {
  const knownItems = items.filter((item) => KNOWN_CONFIG_KEYS.has(item.command));
  if (knownItems.length === 0) {
    if (text.trim() !== '') {
      ambiguous('No recognized configuration line can establish an insertion style.');
    }
    return {
      newline: '\n',
      colonBefore: '',
      colonAfter: '',
      semiBefore: '',
      hasTerminator: true,
    };
  }

  const newline = inferNewline(text);
  if (newline === null) {
    ambiguous('Mixed LF and CRLF line endings make insertion ambiguous.');
  }
  const terminatorValues = new Set(
    knownItems.map((item) => item.semicolonIndex !== null),
  );
  if (terminatorValues.size !== 1) {
    ambiguous('The existing configuration mixes terminated and unterminated entries.');
  }
  if (knownItems.some((item) => item.hasCommandWhitespaceBeforeColon)) {
    ambiguous('Whitespace before a recognized key colon makes insertion style ambiguous.');
  }

  return {
    newline,
    colonBefore: uniqueStyleValue(knownItems, (item) => item.colonBefore),
    colonAfter: uniqueStyleValue(knownItems, (item) => item.colonAfter),
    semiBefore: uniqueStyleValue(knownItems, (item) => item.semiBefore),
    hasTerminator: terminatorValues.values().next().value as boolean,
  };
}

function appendMissing(
  text: string,
  missing: Array<[string, string]>,
  style: InsertionStyle,
): string {
  const suffix = missing.map(([key, value]) => (
    key + style.colonBefore + ':' + style.colonAfter + value
    + style.semiBefore + (style.hasTerminator ? ';' : '')
  ));
  if (text === '') {
    return suffix.join(style.newline);
  }
  if (text.endsWith(style.newline)) {
    return text + suffix.join(style.newline) + style.newline;
  }
  return text + style.newline + suffix.join(style.newline);
}

export function editGameConfig(
  bytes: Uint8Array,
  updates: ConfigUpdate[],
): Buffer {
  if (!(bytes instanceof Uint8Array)) {
    invalidArgument('Configuration input must be UTF-8 bytes.');
  }
  if (bytes.byteLength > LIMITS.textBytes) {
    fail('LIMIT_EXCEEDED', 'The configuration input exceeds the size limit.');
  }

  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasBom = input.length >= 3
    && input[0] === UTF8_BOM[0]
    && input[1] === UTF8_BOM[1]
    && input[2] === UTF8_BOM[2];
  const content = hasBom ? input.subarray(3) : input;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    fail('UNSUPPORTED_FORMAT', 'The configuration is not valid UTF-8.');
  }
  if (hasUnsupportedControlCharacter(text)) {
    fail('UNSUPPORTED_FORMAT', 'The configuration contains binary control characters.');
  }

  const requested = validateUpdates(updates);
  const parsed = parseItems(text);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const missing: Array<[string, string]> = [];

  for (const [key, value] of requested) {
    const item = parsed.byKey.get(key);
    if (item) {
      assertEditableTarget(item);
      replacements.push({
        start: item.valueStart,
        end: item.valueEnd,
        value,
      });
    } else {
      missing.push([key, value]);
    }
  }

  let edited = text;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    edited = edited.slice(0, replacement.start)
      + replacement.value
      + edited.slice(replacement.end);
  }
  if (missing.length > 0) {
    edited = appendMissing(edited, missing, inferInsertionStyle(edited, parsed.items));
  }

  const outputBytes = Buffer.byteLength(edited, 'utf8');
  const totalBytes = outputBytes + (hasBom ? UTF8_BOM.byteLength : 0);
  if (totalBytes > LIMITS.textBytes) {
    fail('LIMIT_EXCEEDED', 'The edited configuration exceeds the size limit.');
  }
  const output = Buffer.from(edited, 'utf8');
  const result = hasBom ? Buffer.concat([UTF8_BOM, output]) : output;
  return result;
}
