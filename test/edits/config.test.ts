import { describe, expect, it } from 'vitest';
import { parseGameConfig } from '../../src/analysis.js';
import { editGameConfig } from '../../src/edits/config.js';
import { AppError } from '../../src/errors.js';
import { LIMITS } from '../../src/types.js';

async function expectAppError(
  operation: () => unknown,
  code: string,
): Promise<void> {
  try {
    await operation();
    throw new Error('Expected AppError ' + code);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe('editGameConfig', () => {
  it('edits only recognized value spans and preserves BOM, CRLF, comments, unknown items, and whitespace', () => {
    const input = '\uFEFF; header\r\n'
      + 'Game_name:  Old: Name  ; keep this comment\r\n'
      + 'Title_logos:1.png | 2.png| -show -count=2;\r\n'
      + 'Unknown_Key:  keep  \r\n'
      + 'Game_key:abc;\r\n';
    const output = editGameConfig(Buffer.from(input, 'utf8'), [
      { key: 'Game_name', value: 'New: Name' },
      { key: 'Game_key', value: 'xyz' },
    ]);
    const expected = '\uFEFF; header\r\n'
      + 'Game_name:  New: Name  ; keep this comment\r\n'
      + 'Title_logos:1.png | 2.png| -show -count=2;\r\n'
      + 'Unknown_Key:  keep  \r\n'
      + 'Game_key:xyz;\r\n';

    expect(output.toString('utf8')).toBe(expected);
    const parsed = parseGameConfig(expected.slice(1));
    expect(parsed.items.find((item) => item.command === 'Game_name')?.args)
      .toEqual(['New: Name']);
  });

  it('supports empty values, multi-value keys, and literal backslashes', () => {
    const input = 'Game_key:;\n'
      + 'Title_logos:old.png|old2.png;\n'
      + 'Description:old\\\\path;';
    const output = editGameConfig(Buffer.from(input, 'utf8'), [
      { key: 'Game_key', value: 'abc' },
      { key: 'Title_logos', value: 'new.png | 新.png' },
      { key: 'Description', value: 'new\\\\path' },
    ]);

    expect(output.toString('utf8')).toBe(
      'Game_key:abc;\n'
      + 'Title_logos:new.png | 新.png;\n'
      + 'Description:new\\\\path;',
    );
    const parsed = parseGameConfig(output.toString('utf8'));
    expect(parsed.items.find((item) => item.command === 'Title_logos')?.args)
      .toEqual(['new.png', '新.png']);
    expect(parsed.items.find((item) => item.command === 'Description')?.args)
      .toEqual(['new\\\\path']);
  });

  it('appends missing keys using the existing colon, terminator, and CRLF style', () => {
    const input = 'Game_name:  Demo ;\r\nUnknown_Key: keep;\r\n';
    const output = editGameConfig(Buffer.from(input, 'utf8'), [
      { key: 'Game_key', value: 'abc' },
      { key: 'Show_panic', value: 'true' },
    ]);

    expect(output.toString('utf8')).toBe(
      'Game_name:  Demo ;\r\n'
      + 'Unknown_Key: keep;\r\n'
      + 'Game_key:  abc ;\r\n'
      + 'Show_panic:  true ;\r\n',
    );
    const parsed = parseGameConfig(output.toString('utf8'));
    expect(parsed.items.find((item) => item.command === 'Game_name')?.args)
      .toEqual(['Demo']);
    expect(parsed.items.find((item) => item.command === 'Game_key')?.args)
      .toEqual(['abc']);
  });

  it('appends to an empty configuration with a deterministic minimal style', () => {
    const output = editGameConfig(Buffer.alloc(0), [
      { key: 'Game_name', value: 'Demo' },
      { key: 'Game_key', value: 'abc' },
    ]);

    expect(output.toString('utf8')).toBe('Game_name:Demo;\nGame_key:abc;');
  });

  it('preserves a missing final newline when appending', () => {
    const output = editGameConfig(Buffer.from('Game_name:Demo;', 'utf8'), [
      { key: 'Game_key', value: 'abc' },
    ]);

    expect(output.toString('utf8')).toBe('Game_name:Demo;\nGame_key:abc;');
  });

  it('rejects an empty update list', async () => {
    const input = Buffer.from('\uFEFFGame_name:Demo;\r\n', 'utf8');
    await expectAppError(
      () => editGameConfig(input, []),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects duplicate keys in the source and duplicate updates', async () => {
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A;\nGame_name:B;', 'utf8'),
        [{ key: 'Game_key', value: 'abc' }],
      ),
      'CONFIG_DUPLICATE_KEY',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A;', 'utf8'),
        [
          { key: 'Game_name', value: 'B' },
          { key: 'Game_name', value: 'C' },
        ],
      ),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects unsupported keys and ambiguous source formats', async () => {
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A;', 'utf8'),
        [{ key: 'Unknown_Key', value: 'x' }],
      ),
      'INVALID_ARGUMENT',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name Demo;', 'utf8'),
        [{ key: 'Game_key', value: 'abc' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('  Game_name:Demo;', 'utf8'),
        [{ key: 'Game_key', value: 'abc' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name :Demo;', 'utf8'),
        [{ key: 'Game_key', value: 'abc' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:Demo;\nGame_key: abc;', 'utf8'),
        [{ key: 'Show_panic', value: 'true' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:Demo;\r\nGame_key:abc;\n', 'utf8'),
        [{ key: 'Show_panic', value: 'true' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Unknown_Key:value;', 'utf8'),
        [{ key: 'Game_name', value: 'Demo' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
  });

  it('round-trips the upstream colon-whitespace bug and refuses that edit or insertion style', async () => {
    const ambiguousText = 'Game_name :Old;';
    const parsed = parseGameConfig(ambiguousText);
    expect(parsed.items[0]?.args).toEqual([':Old']);

    await expectAppError(
      () => editGameConfig(
        Buffer.from(ambiguousText, 'utf8'),
        [{ key: 'Game_name', value: 'New' }],
      ),
      'CONFIG_AMBIGUOUS',
    );

    const preserved = editGameConfig(
      Buffer.from('Game_name :Old;\nGame_key:abc;', 'utf8'),
      [{ key: 'Game_key', value: 'xyz' }],
    );
    expect(preserved.toString('utf8')).toBe('Game_name :Old;\nGame_key:xyz;');

    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name :Old;\nGame_key:abc;', 'utf8'),
        [{ key: 'Show_panic', value: 'true' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
  });

  it('rejects editing target values with options, escapes, or scalar argument lists', async () => {
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Title_logos:1.png| -show -count=2;', 'utf8'),
        [{ key: 'Title_logos', value: '2.png' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Title_logos:1.png\\|2.png;', 'utf8'),
        [{ key: 'Title_logos', value: '3.png' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A\\;B;', 'utf8'),
        [{ key: 'Game_name', value: 'C' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A|B;', 'utf8'),
        [{ key: 'Game_name', value: 'C' }],
      ),
      'CONFIG_AMBIGUOUS',
    );
  });

  it.each([
    ['terminator', 'Game_name', 'A;B'],
    ['newline', 'Game_name', 'A\nB'],
    ['carriage return', 'Game_name', 'A\rB'],
    ['leading whitespace', 'Game_name', ' A'],
    ['trailing whitespace', 'Game_name', 'A '],
    ['parser options', 'Title_logos', 'a.png -show'],
    ['empty multi-value item', 'Title_logos', 'a.png||b.png'],
    ['scalar pipe', 'Game_name', 'A|B'],
  ])('rejects injected %s in update values', async (_label, key, value) => {
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:Demo;', 'utf8'),
        [{ key, value }],
      ),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects invalid UTF-8, NUL bytes, and lone surrogates', async () => {
    await expectAppError(
      () => editGameConfig(Buffer.from([0xff]), []),
      'UNSUPPORTED_FORMAT',
    );
    await expectAppError(
      () => editGameConfig(Buffer.from('Game_name:A\u0000B;', 'utf8'), []),
      'UNSUPPORTED_FORMAT',
    );
    await expectAppError(
      () => editGameConfig(Buffer.from('Game_name:A\u0001B;', 'utf8'), []),
      'UNSUPPORTED_FORMAT',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A;', 'utf8'),
        [{ key: 'Game_name', value: '\ud800' }],
      ),
      'INVALID_ARGUMENT',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A;', 'utf8'),
        [{ key: 'Game_name', value: 'x\ud800' }],
      ),
      'INVALID_ARGUMENT',
    );
  });

  it('enforces the input and output 1 MiB limits', async () => {
    await expectAppError(
      () => editGameConfig(Buffer.alloc(LIMITS.textBytes + 1), []),
      'LIMIT_EXCEEDED',
    );
    await expectAppError(
      () => editGameConfig(
        Buffer.from('Game_name:A;', 'utf8'),
        [{ key: 'Description', value: 'x'.repeat(LIMITS.textBytes) }],
      ),
      'LIMIT_EXCEEDED',
    );
  });
});
