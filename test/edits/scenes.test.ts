import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { applySceneEdits, createScene } from '../../src/edits/scenes.js';
import { LIMITS } from '../../src/types.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function expectAppError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected AppError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe('scene edits', () => {
  it('applies ordered Chinese edits while preserving BOM, escapes, and mixed newlines', () => {
    const originalText = '角色:你好\\;世界;\r\n第二行\n第三行\r第四行';
    const input = Buffer.concat([BOM, Buffer.from(originalText, 'utf8')]);
    const firstStart = originalText.indexOf('你好');
    const firstEnd = firstStart + '你好'.length;
    const secondStart = originalText.indexOf('第二行');
    const result = applySceneEdits(input, [
      { start: firstStart, end: firstEnd, text: '您好' },
      { start: secondStart, end: secondStart, text: '插入' }
    ]);

    const expectedText = `${originalText.slice(0, firstStart)}您好${originalText.slice(firstEnd, secondStart)}插入${originalText.slice(secondStart)}`;
    expect(result).toEqual(Buffer.concat([BOM, Buffer.from(expectedText, 'utf8')]));
    expect(result.toString('utf8')).toContain('\\;');
    expect(result.toString('utf8')).toContain('\r\n');
    expect(result.toString('utf8')).toContain('\n');
    expect(result.toString('utf8')).toContain('\r');
    expect(input).toEqual(Buffer.concat([BOM, Buffer.from(originalText, 'utf8')]));
  });

  it('creates UTF-8 candidates without adding a BOM and supports empty insertions', () => {
    expect(createScene('')).toEqual(Buffer.alloc(0));
    expect(createScene('第一行\r\n第二行\n')).toEqual(
      Buffer.from('第一行\r\n第二行\n', 'utf8')
    );
    expect(applySceneEdits(Buffer.alloc(0), [
      { start: 0, end: 0, text: '新场景\r\n' }
    ])).toEqual(Buffer.from('新场景\r\n', 'utf8'));
    expect(applySceneEdits(Buffer.from('abc', 'utf8'), [
      { start: 1, end: 2, text: '' }
    ])).toEqual(Buffer.from('ac', 'utf8'));
    expect(applySceneEdits(BOM, [
      { start: 0, end: 0, text: '新' }
    ])).toEqual(Buffer.concat([BOM, Buffer.from('新', 'utf8')]));
  });

  it('uses UTF-16 offsets and rejects edits that split an astral character', () => {
    const input = Buffer.concat([BOM, Buffer.from('A😀B', 'utf8')]);
    expect(applySceneEdits(input, [
      { start: 1, end: 3, text: '猫' }
    ])).toEqual(Buffer.concat([BOM, Buffer.from('A猫B', 'utf8')]));
    expect(applySceneEdits(input, [
      { start: 1, end: 3, text: '🚀' }
    ])).toEqual(Buffer.concat([BOM, Buffer.from('A🚀B', 'utf8')]));

    expectAppError(
      () => applySceneEdits(input, [{ start: 2, end: 2, text: 'x' }]),
      'INVALID_ARGUMENT'
    );
    expectAppError(
      () => applySceneEdits(input, [{ start: 2, end: 3, text: 'x' }]),
      'INVALID_ARGUMENT'
    );
    expectAppError(
      () => applySceneEdits(input, [{ start: 1, end: 3, text: '\ud83d' }]),
      'INVALID_ARGUMENT'
    );
  });

  it.each([
    ['empty edit list', []],
    ['unordered edits', [
      { start: 4, end: 5, text: 'X' },
      { start: 1, end: 2, text: 'Y' }
    ]],
    ['overlapping edits', [
      { start: 1, end: 4, text: 'X' },
      { start: 3, end: 5, text: 'Y' }
    ]],
    ['same-position insertions', [
      { start: 2, end: 2, text: 'X' },
      { start: 2, end: 2, text: 'Y' }
    ]],
    ['insertion at a replacement start', [
      { start: 1, end: 3, text: 'X' },
      { start: 1, end: 1, text: 'Y' }
    ]],
    ['negative start', [{ start: -1, end: 1, text: 'X' }]],
    ['reversed range', [{ start: 3, end: 2, text: 'X' }]],
    ['range beyond text', [{ start: 1, end: 7, text: 'X' }]],
    ['fractional offset', [{ start: 1.5, end: 2, text: 'X' }]],
    ['empty insertion', [{ start: 2, end: 2, text: '' }]],
    ['control replacement', [{ start: 1, end: 2, text: '\u0001' }]],
    ['NUL replacement', [{ start: 1, end: 2, text: '\0' }]],
    ['lone surrogate replacement', [{ start: 1, end: 2, text: '\udc00' }]]
  ])('rejects %s', (_label, edits) => {
    expectAppError(
      () => applySceneEdits(Buffer.from('abcdef', 'utf8'), edits),
      'INVALID_ARGUMENT'
    );
  });

  it.each([
    ['UTF-16 LE BOM', Buffer.from([0xff, 0xfe, 0x41, 0x00])],
    ['UTF-16 BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x41])],
    ['NUL byte', Buffer.from([0x41, 0x00, 0x42])],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['binary control byte', Buffer.from([0x41, 0x01, 0x42])]
  ])('rejects %s scene input', (_label, bytes) => {
    expectAppError(
      () => applySceneEdits(bytes, [{ start: 0, end: 0, text: 'x' }]),
      'UNSUPPORTED_FORMAT'
    );
  });

  it('rejects invalid text passed to createScene', () => {
    expectAppError(() => createScene('\0'), 'INVALID_ARGUMENT');
    expectAppError(() => createScene('\u0001'), 'INVALID_ARGUMENT');
    expectAppError(() => createScene('\ud800'), 'INVALID_ARGUMENT');
  });

  it('enforces the 1 MiB input and output limits', () => {
    const atLimit = Buffer.alloc(LIMITS.textBytes, 0x61);
    expect(applySceneEdits(atLimit, [
      { start: 0, end: 1, text: 'b' }
    ])).toHaveLength(LIMITS.textBytes);
    expect(createScene('a'.repeat(LIMITS.textBytes))).toHaveLength(LIMITS.textBytes);

    expectAppError(
      () => applySceneEdits(Buffer.alloc(LIMITS.textBytes + 1, 0x61), [
        { start: 0, end: 0, text: 'b' }
      ]),
      'FILE_TOO_LARGE'
    );
    expectAppError(
      () => applySceneEdits(atLimit, [{ start: 0, end: 0, text: 'b' }]),
      'FILE_TOO_LARGE'
    );
    expectAppError(
      () => applySceneEdits(Buffer.from('a', 'utf8'), [
        { start: 0, end: 0, text: 'a'.repeat(LIMITS.textBytes + 1) }
      ]),
      'FILE_TOO_LARGE'
    );
    expectAppError(
      () => createScene('a'.repeat(LIMITS.textBytes + 1)),
      'FILE_TOO_LARGE'
    );
  });
});
