import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applySceneEdits } from '../src/edits/scenes.js';

const helper = fileURLToPath(new URL('../skills/webgal-creator/scripts/scene-patch.mjs', import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const dialogue = '小禾:「等一下。」;\n';
const otherDialogue = '說:別走;\n';
const reviewedStory = [
  '## 第一幕', '<!-- scene: S001 -->', '<!-- fragment: F001 -->', '第一句',
  '<!-- fragment: F002 -->', '第二句',
  '## 第二幕', '<!-- scene: S002 -->', '<!-- fragment: F003 -->', '第三句',
].join('\n');

function savedScene(path: string, text: string, encoding = 'utf-8') {
  const bytes = Buffer.from((encoding === 'utf-8-bom' ? '\ufeff' : '') + text);
  return { path, text, encoding, source: 'disk', bytes: bytes.length, revision: sha256(bytes) };
}

const firstScene = savedScene('start.txt', dialogue + otherDialogue);
const secondScene = savedScene('second.txt', dialogue);
const fragment = (webgal: string, left = '', right = '') => ({ webgal, left, right, state: 'synced' });
const makeMap = (scene = firstScene) => ({
  schemaVersion: 1,
  scenes: {
    S001: { path: scene.path, verifiedRevision: scene.revision, fragments: { F001: fragment(dialogue, '', otherDialogue), F002: fragment(otherDialogue, dialogue) } },
    S002: { path: secondScene.path, verifiedRevision: secondScene.revision, fragments: { F003: fragment(dialogue) } },
  },
});

function call(request: object) {
  const result = spawnSync(process.execPath, [helper], { input: JSON.stringify(request), encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function patch(changes: object[], overrides: object = {}) {
  return call({ mode: 'patch', storyText: reviewedStory, sceneId: 'S001', scene: firstScene, scriptMap: makeMap(), changes, ...overrides });
}

function expectFailure(result: ReturnType<typeof call>, code: string) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr).code).toBe(code);
}

describe('webgal-creator scene patch CLI', () => {
  it('rejects a saved snapshot from another mapped scene with identical dialogue', () => {
    expectFailure(patch([{ fragmentId: 'F001', before: dialogue, after: '修改;\n' }], { scene: secondScene }), 'INVALID_BASELINE');
  });

  it('rejects edits without a synchronization map', () => {
    expectFailure(patch([{ fragmentId: 'F001', before: dialogue, after: '修改;\n' }], { scriptMap: undefined }), 'INVALID_BASELINE');
  });

  it('rejects deletions for never-synced, wrong-scene or wrong-text fragments', () => {
    const absentStory = reviewedStory.replace('<!-- fragment: F002 -->\n第二句\n', '')
      .replace('<!-- fragment: F003 -->\n第三句', '<!-- fragment: F004 -->\n第三句');
    for (const [fragmentId, before] of [['F099', dialogue], ['F003', dialogue], ['F002', dialogue]]) {
      expectFailure(patch([{ fragmentId, before, after: '', removed: true }], { storyText: absentStory }),
        fragmentId === 'F002' ? 'TARGET_CHANGED' : 'INVALID_BASELINE');
    }
  });

  it('removes the exact saved fragment even after an unrelated manual edit', () => {
    const changed = savedScene('start.txt', dialogue + otherDialogue + 'unknown:preserved;\n');
    const storyText = reviewedStory.replace('<!-- fragment: F002 -->\n第二句\n', '');
    const result = patch([{ fragmentId: 'F002', before: otherDialogue, after: '', removed: true }], { scene: changed, storyText });
    expect(result.status, result.stderr).toBe(0);
    const { operation, afterRevision } = JSON.parse(result.stdout);
    const bytes = applySceneEdits(Buffer.from(changed.text), operation.edits);
    expect(bytes.toString()).toBe(dialogue + 'unknown:preserved;\n');
    expect(afterRevision).toBe(sha256(bytes));
  });

  it('uses recorded context instead of letting a caller select an identical occurrence', () => {
    const otherCue = 'say:unmapped;\n';
    const changed = savedScene('start.txt', dialogue + otherDialogue + dialogue + otherCue);
    const edit = { fragmentId: 'F001', before: dialogue, after: 'say:修改;\n' };
    const result = patch([edit], { scene: changed });
    expect(result.status, result.stderr).toBe(0);
    expect(applySceneEdits(Buffer.from(changed.text), JSON.parse(result.stdout).operation.edits).toString())
      .toBe(edit.after + otherDialogue + dialogue + otherCue);
    expectFailure(patch([{ ...edit, right: otherCue }], { scene: changed }), 'TARGET_CHANGED');
    expectFailure(patch([{ ...edit, right: '' }], { scene: changed }), 'AMBIGUOUS_TARGET');
  });

  it('allows a shorter recorded anchor when the neighboring line has a saved manual edit', () => {
    const changed = savedScene('start.txt', dialogue + '說:還請留步;\n');
    const edit = { fragmentId: 'F001', before: dialogue, after: 'say:修改;\n', right: '說:' };
    const result = patch([edit], { scene: changed });
    expect(result.status, result.stderr).toBe(0);
    expect(applySceneEdits(Buffer.from(changed.text), JSON.parse(result.stdout).operation.edits).toString())
      .toBe(edit.after + '說:還請留步;\n');
  });

  it('allows a new fragment to insert at an explicit boundary, but not to replace existing text', () => {
    const storyText = reviewedStory.replace('## 第二幕', '<!-- fragment: F005 -->\n新增一句\n## 第二幕');
    const edit = { fragmentId: 'F005', before: '', after: 'say:新增;\n', left: dialogue, right: otherDialogue };
    const result = patch([edit], { storyText });
    expect(result.status, result.stderr).toBe(0);
    expect(applySceneEdits(Buffer.from(firstScene.text), JSON.parse(result.stdout).operation.edits).toString())
      .toBe(dialogue + edit.after + otherDialogue);
    expectFailure(patch([{ ...edit, before: dialogue, left: '' }], { storyText }), 'INVALID_BASELINE');
  });

  it('counts visible fenced content without treating it as headings or markers', () => {
    const storyText = [
      '## 第一幕', '<!-- scene: S001 -->', '<!-- fragment: F001 -->',
      '  ````text', '## 示例标题', '<!-- fragment: F099 -->', '  ```', '## 仍在围栏内', '  ````',
      '<!-- fragment: F002 -->', '~~~', '<!-- scene: S099 -->', '~~~',
    ].join('\r\n');
    const result = call({ mode: 'validate-story', storyText });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ scenes: { S001: ['F001', 'F002'] } });
  });

  it('ignores headings and IDs in multiline HTML comments and retains visible text outside', () => {
    const storyText = [
      '<!-- draft notes', '## 隐藏标题', '<!-- scene: S999 -->',
      '## 第一幕', '<!-- scene: S001 -->', '<!-- fragment: F001 -->',
      '<!-- fragment: later edit notes', '```', '## 也隐藏', '--> 正文',
    ].join('\n');
    const result = call({ mode: 'validate-story', storyText });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ scenes: { S001: ['F001'] } });
  });

  it('rejects a fragment with only multiline HTML notes and an empty fence', () => {
    const storyText = ['## 第一幕', '<!-- scene: S001 -->', '<!-- fragment: F001 -->',
      '<!-- draft', 'private notes', '-->', '~~~', '  ', '~~~'].join('\n');
    expectFailure(call({ mode: 'validate-story', storyText }), 'INVALID_ID');
  });

  it.each(['\f', '\u000b', '\u007f', '\u0000', '\ud83d'])('rejects invalid scene text %j before proposing an operation', (value) => {
    expectFailure(patch([{ fragmentId: 'F001', before: dialogue, after: `say:bad${value};\n` }]), 'INVALID_TEXT');
  });

  it('keeps tabs, CRLF, BOM and emoji in server-compatible UTF-16 edits', () => {
    const before = '說:原文;\r\n';
    const scene = savedScene('start.txt', 'say:🔦;\r\n' + before, 'utf-8-bom');
    const scriptMap = makeMap(scene);
    scriptMap.scenes.S001.fragments.F001 = fragment(before, 'say:🔦;\r\n');
    const after = '說:\t更改;\r\n';
    const result = patch([{ fragmentId: 'F001', before, after }], { scene, scriptMap });
    expect(result.status, result.stderr).toBe(0);
    const { operation, afterRevision } = JSON.parse(result.stdout);
    const bytes = applySceneEdits(Buffer.from('\ufeff' + scene.text), operation.edits);
    expect(bytes.toString()).toBe('\ufeffsay:🔦;\r\n說:\t更改;\r\n');
    expect(afterRevision).toBe(sha256(bytes));
  });
});
