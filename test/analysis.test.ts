import { describe, expect, it } from 'vitest';
import { analyzeScene, parseGameConfig } from '../src/analysis.js';
import { AppError } from '../src/errors.js';
import { LIMITS } from '../src/types.js';

interface DiagnosticResult {
  startLine: number;
  endLine: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
}

interface SceneResult {
  sentenceCount: number;
  sentences: Array<{ startLine: number; endLine: number; command: string }>;
  diagnostics: DiagnosticResult[];
  staticReferences: Array<{
    path: string;
    kind: string;
    startLine: number;
    endLine: number;
    exists: boolean;
  }>;
  unresolvedReferences: Array<{
    value: string;
    kind: string;
    startLine: number;
    endLine: number;
    reason: string;
  }>;
  limitations: string[];
}

interface ConfigResult {
  itemCount: number;
  items: Array<{
    line: number;
    command: string;
    args: string[];
    options: Array<{ key: string; value: string | number | boolean }>;
    known: boolean;
    duplicateOfLine?: number;
  }>;
  diagnostics: DiagnosticResult[];
  limitations: string[];
}

const sceneText = [
  'changeBg:bg.webp;',
  ':第一行',
  '  |第二行',
  'changeScene:next.txt;',
].join('\n');

describe('analyzeScene', () => {
  it('keeps multiline ranges and filters parser placeholder rows', async () => {
    const checked: string[] = [];
    const result = (await analyzeScene(
      sceneText,
      'chapter/start.txt',
      async (path) => {
        checked.push(path);
        return true;
      },
    )) as SceneResult;

    expect(result.sentenceCount).toBe(3);
    expect(result.sentences).toEqual([
      { startLine: 1, endLine: 1, command: 'changeBg' },
      { startLine: 2, endLine: 3, command: 'say' },
      { startLine: 4, endLine: 4, command: 'changeScene' },
    ]);
    expect(result.staticReferences).toEqual([
      {
        path: 'game/background/bg.webp',
        kind: 'background',
        startLine: 1,
        endLine: 1,
        exists: true,
      },
      {
        path: 'game/scene/next.txt',
        kind: 'scene',
        startLine: 4,
        endLine: 4,
        exists: true,
      },
    ]);
    expect(checked).toEqual([
      'game/background/bg.webp',
      'game/scene/next.txt',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports missing local files while keeping dynamic, URL, and none unresolved', async () => {
    const checked: string[] = [];
    const text = [
      'changeBg:missing.webp;',
      'changeFigure:{outfit}.png;',
      'bgm:https://example.com/music.mp3;',
      'changeFigure:none;',
      'WebGAL:Hello -vocal=voice.mp3;',
      'changeScene:next.txt;',
    ].join('\n');

    const result = (await analyzeScene(text, 'start.txt', async (path) => {
      checked.push(path);
      return path === 'game/vocal/voice.mp3';
    })) as SceneResult;

    expect(checked).toEqual([
      'game/background/missing.webp',
      'game/vocal/voice.mp3',
      'game/scene/next.txt',
    ]);
    expect(result.staticReferences).toEqual([
      {
        path: 'game/background/missing.webp',
        kind: 'background',
        startLine: 1,
        endLine: 1,
        exists: false,
      },
      {
        path: 'game/vocal/voice.mp3',
        kind: 'vocal',
        startLine: 5,
        endLine: 5,
        exists: true,
      },
      {
        path: 'game/scene/next.txt',
        kind: 'scene',
        startLine: 6,
        endLine: 6,
        exists: false,
      },
    ]);
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'dynamic', value: 'game/figure/{outfit}.png' }),
        expect.objectContaining({
          reason: 'remote-url',
          value: 'https://example.com/music.mp3',
        }),
        expect.objectContaining({ reason: 'none', value: 'none' }),
        expect.objectContaining({
          reason: 'missing',
          value: 'game/background/missing.webp',
        }),
        expect.objectContaining({
          reason: 'missing',
          value: 'game/scene/next.txt',
        }),
      ]),
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REFERENCE_MISSING', severity: 'error' }),
        expect.objectContaining({
          code: 'REFERENCE_DYNAMIC_NOT_CHECKED',
          severity: 'info',
        }),
        expect.objectContaining({
          code: 'REFERENCE_REMOTE_NOT_CHECKED',
          severity: 'info',
        }),
        expect.objectContaining({ code: 'REFERENCE_NONE', severity: 'info' }),
      ]),
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'REFERENCE_MISSING' &&
          diagnostic.message.includes('https://'),
      ),
    ).toBe(false);
  });

  it('does not call exists for unsafe paths', async () => {
    const checked: string[] = [];
    const text = [
      'changeBg:../secret.webp;',
      'changeScene:C:\\secret.txt;',
      'changeBg:/etc/passwd;',
      'changeBg:%2e%2e/secret.webp;',
      'changeBg:bad%00name.webp;',
    ].join('\n');

    const result = (await analyzeScene(text, 'start.txt', async (path) => {
      checked.push(path);
      return true;
    })) as SceneResult;

    expect(checked).toEqual([]);
    expect(result.staticReferences).toEqual([]);
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'invalid-path' }),
        expect.objectContaining({ reason: 'invalid-path' }),
        expect.objectContaining({ reason: 'invalid-path' }),
        expect.objectContaining({ reason: 'invalid-path' }),
        expect.objectContaining({ reason: 'invalid-path' }),
      ]),
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'REFERENCE_PATH_INVALID',
      ),
    ).toHaveLength(5);
  });

  it('does not treat unknown commands or speakers as invalid', async () => {
    const text = [
      'CustomCommand:value;',
      'WebGAL:Hello;',
      'playVideo:movie.mp4;',
      'character:alice;',
      'pixiPerform:snow;',
    ].join('\n');

    const result = (await analyzeScene(text, 'start.txt', async () => true)) as SceneResult;

    expect(result.sentences.map((sentence) => sentence.command)).toEqual([
      'say',
      'say',
      'playVideo',
      'character',
      'pixiPerform',
    ]);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'REFERENCE_MISSING' ||
          diagnostic.message.toLowerCase().includes('speaker'),
      ),
    ).toBe(false);
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'complex-character-dependency' }),
        expect.objectContaining({ reason: 'unsupported-static-semantics' }),
      ]),
    );
  });

  it('bounds large responses and reports truncation', async () => {
    const path = 'a'.repeat(140);
    const text = Array.from(
      { length: 5000 },
      (_, index) => `changeBg:${path}-${index}.webp;`,
    ).join('\n');

    const result = (await analyzeScene(
      text,
      'start.txt',
      async () => false,
    )) as SceneResult;

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      LIMITS.responseBytes,
    );
    expect(result.staticReferences.length).toBeLessThan(5000);
    expect(result.diagnostics.length).toBeLessThan(5000);
    expect(result.limitations).toContain(
      `Response arrays were truncated to stay within the ${LIMITS.responseBytes}-byte response limit.`,
    );
  });

  it('checks parser-mapped effect, unlock, and choice scene references', async () => {
    const text = [
      'playEffect:se.mp3;',
      'unlockCg:cg.webp;',
      'unlockBgm:theme.mp3;',
      'choose:One:one.txt|Two:label;',
    ].join('\n');

    const result = (await analyzeScene(text, 'start.txt', async () => true)) as SceneResult;

    expect(result.staticReferences.map((reference) => reference.path)).toEqual([
      'game/vocal/se.mp3',
      'game/background/cg.webp',
      'game/bgm/theme.mp3',
      'game/scene/one.txt',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('handles a UTF-8 BOM without changing line numbers', async () => {
    const sceneResult = (await analyzeScene(
      '\uFEFFchangeBg:bg.webp;',
      'start.txt',
      async () => true,
    )) as SceneResult;
    const configResult = parseGameConfig('\uFEFFGame_name:Demo;') as ConfigResult;

    expect(sceneResult.sentences).toEqual([
      { startLine: 1, endLine: 1, command: 'changeBg' },
    ]);
    expect(configResult.items[0]).toMatchObject({
      line: 1,
      command: 'Game_name',
      known: true,
    });
  });

  it('rejects unsafe scene paths and oversized text', async () => {
    await expect(
      analyzeScene('', '../start.txt', async () => true),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });

    await expect(
      analyzeScene('x'.repeat(LIMITS.textBytes + 1), 'start.txt', async () => true),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('parseGameConfig', () => {
  it('parses recognized and unknown keys, options, and duplicate warnings', () => {
    const text = [
      '; comment',
      'Game_name:Demo;',
      'Game_key:abc;',
      'Unknown_Key:value;',
      'Game_name:Second;',
      'Title_logos:1.png | 2.png| -show -active=false -count=3;',
    ].join('\n');

    const result = parseGameConfig(text) as ConfigResult;

    expect(result.itemCount).toBe(5);
    expect(result.items).toEqual([
      {
        line: 2,
        command: 'Game_name',
        args: ['Demo'],
        options: [],
        known: true,
      },
      {
        line: 3,
        command: 'Game_key',
        args: ['abc'],
        options: [],
        known: true,
      },
      {
        line: 4,
        command: 'Unknown_Key',
        args: ['value'],
        options: [],
        known: false,
      },
      {
        line: 5,
        command: 'Game_name',
        args: ['Second'],
        options: [],
        known: true,
        duplicateOfLine: 2,
      },
      {
        line: 6,
        command: 'Title_logos',
        args: ['1.png', '2.png'],
        options: [
          { key: 'show', value: true },
          { key: 'active', value: false },
          { key: 'count', value: 3 },
        ],
        known: true,
      },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CONFIG_DUPLICATE_KEY',
        severity: 'warning',
        startLine: 5,
      }),
    ]);
    expect('text' in result).toBe(false);
  });

  it('handles an empty configuration without inventing items', () => {
    const result = parseGameConfig('') as ConfigResult;

    expect(result.itemCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('recognizes configuration keys used by parser tests, WebGAL, and Terre', () => {
    const keys = [
      'Game_name',
      'Game_key',
      'Description',
      'Package_name',
      'Steam_AppID',
      'Cubism_Memory_Reserved_Size_MB',
      'Title_img',
      'Title_bgm',
      'Title_logos',
      'Game_Logo',
      'Show_panic',
      'Enable_Appreciation',
      'Enable_flowchart',
      'Flowchart_Locked_Node_Visibility',
      'Enable_Continue',
      'Default_Language',
      'Textbox_theme',
      'Max_line',
      'Line_height',
      'Legacy_Expression_Blend_Mode',
    ];
    const result = parseGameConfig(
      keys.map((key) => `${key}:value;`).join('\n'),
    ) as ConfigResult;

    expect(result.items.map((item) => item.command)).toEqual(keys);
    expect(result.items.every((item) => item.known)).toBe(true);
  });

  it('rejects oversized configuration text', () => {
    expect(() =>
      parseGameConfig('x'.repeat(LIMITS.textBytes + 1)),
    ).toThrowError(AppError);
  });
});
