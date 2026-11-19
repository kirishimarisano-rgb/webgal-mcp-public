import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROJECT_SCAN_LIMITS, scanProject } from '../src/project-scan.js';
import { ReadService } from '../src/service.js';

let fixture: string;
let root: string;
let service: ReadService;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'webgal-project-scan-')));
  root = join(fixture, 'project');
  await mkdir(join(root, 'game/scene'), { recursive: true });
  service = new ReadService({ version: 1, projects: [{ id: 'test', root }], sources: [] });
});

afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

async function file(relative: string, contents: string | Uint8Array) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

it('checks existing Chinese scene and asset paths without following a cycle', async () => {
  await file('game/background/大厅.png', '');
  await file('game/bgm/开场.ogg', '');
  await file('game/scene/start.txt', 'changeBg:大厅.png;\nbgm:开场.ogg;\nchangeScene:章节/回到开场.txt;\n');
  await file('game/scene/章节/回到开场.txt', 'changeScene:start.txt;\n');

  const report = await service.scan('test', {});
  expect(report.complete).toBe(true);
  expect(report.scope).toMatchObject({ totalScenes: 2, checkedScenes: 2, incompleteScenes: 0, remainingScenes: 0 });
  expect(report.scenes).toEqual([
    { path: 'start.txt', status: 'checked', reason: null, issues: [] },
    { path: '章节/回到开场.txt', status: 'checked', reason: null, issues: [] },
  ]);
});

it('reports missing assets and jumps, and distinguishes dynamic and unsafe references', async () => {
  await file('game/scene/start.txt', [
    'changeBg:missing.png;',
    'changeScene:missing.txt;',
    'changeBg:{背景}.png;',
    'changeBg:../escape.png;',
    'changeBg:https://example.invalid/asset?token=private;',
    'changeBg:none;',
  ].join('\n'));

  const report = await service.scan('test', {});
  expect(report.complete).toBe(true);
  expect(report.scenes[0].issues).toMatchObject([
    { category: 'missing', reason: 'missing', kind: 'background', target: 'game/background/missing.png', line: 1 },
    { category: 'missing', reason: 'missing', kind: 'scene', target: 'game/scene/missing.txt', line: 2 },
    { category: 'unverified', reason: 'dynamic', line: 3 },
    { category: 'unverified', reason: 'invalid-path', line: 4, target: null },
    { category: 'unverified', reason: 'remote-url', line: 5, target: null },
  ]);
  expect(JSON.stringify(report)).not.toContain('token=private');
});

it('does not traverse a scene link or report an out-of-project asset as missing', async () => {
  const outside = join(fixture, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'PRIVATE OUTSIDE CONTENT');
  await mkdir(join(root, 'game/background'));
  await symlink(outside, join(root, 'game/scene/linked'), 'junction');
  await symlink(outside, join(root, 'game/background/linked'), 'junction');
  await file('game/scene/start.txt', 'changeBg:linked/secret.txt;');

  const report = await service.scan('test', {});
  expect(report.complete).toBe(false);
  expect(report.scope).toMatchObject({ totalScenes: 1, incompleteScenes: 1 });
  expect(report.scenes[0]).toMatchObject({
    path: 'start.txt', status: 'incomplete', reason: 'REFERENCE_CHECK_FAILED',
    issues: [{ category: 'unverified', reason: 'check-failed' }],
  });
  expect(JSON.stringify(report)).not.toContain('PRIVATE OUTSIDE CONTENT');
});

it('continues past unsupported text and oversized scenes and resumes after the first batch', async () => {
  await file('game/scene/a.txt', Uint8Array.from([0xff, 0xfe, 0, 0]));
  await file('game/scene/b.txt', 'x'.repeat(PROJECT_SCAN_LIMITS.sceneBytes + 1));
  await file('game/scene/c.txt', '');

  const first = await service.scan('test', { limit: 2 });
  expect(first.complete).toBe(false);
  expect(first.stopReason).toBe('scene_limit');
  expect(first.scope).toMatchObject({
    totalScenes: 3, checkedScenes: 0, incompleteScenes: 2, remainingScenes: 1,
    firstRemainingPath: 'c.txt', nextStartAfter: 'b.txt',
  });
  expect(first.scenes).toMatchObject([
    { path: 'a.txt', reason: 'UNSUPPORTED_FORMAT' },
    { path: 'b.txt', reason: 'FILE_TOO_LARGE' },
  ]);

  const second = await service.scan('test', { startAfter: first.scope.nextStartAfter! });
  expect(second.scope).toMatchObject({ scenesBeforeStart: 2, checkedScenes: 1, remainingScenes: 0, nextStartAfter: null });
  expect(second.scenes[0].path).toBe('c.txt');
  expect(second.complete).toBe(false);
});

it('reports inventory failure without claiming that the project is empty', async () => {
  await rm(join(root, 'game/scene'), { recursive: true });
  const report = await service.scan('test', {});
  expect(report).toMatchObject({
    complete: false, stopReason: 'inventory_error', inventoryError: 'FILE_NOT_FOUND',
    scope: { totalScenes: null, remainingScenes: null, checkedScenes: 0 }, scenes: [],
  });
});

it('keeps completed scene results when the time budget expires on the next scene', async () => {
  await file('game/scene/a.txt', '');
  await file('game/scene/b.txt', 'bgm:b.ogg;');
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const report = await scanProject({ id: 'test', root }, {}, async () => {
      now = PROJECT_SCAN_LIMITS.timeMs;
      return true;
    });
    expect(report.complete).toBe(false);
    expect(report.stopReason).toBe('time_limit');
    expect(report.scope).toMatchObject({ checkedScenes: 1, remainingScenes: 1, firstRemainingPath: 'b.txt', nextStartAfter: 'a.txt' });
  } finally {
    clock.mockRestore();
  }
});

it('marks truncated issue details and preserves the next scene position under the output cap', async () => {
  const reference = 'changeBg:{' + 'x'.repeat(350) + '}.png;\n';
  await file('game/scene/a.txt', reference.repeat(310));
  await file('game/scene/b.txt', '');
  const report = await service.scan('test', {});
  expect(report.complete).toBe(false);
  expect(report.stopReason).toBe('report_limit');
  expect(report.scenes[0]).toMatchObject({ path: 'a.txt', status: 'incomplete', reason: 'REPORT_LIMIT' });
  expect(report.scenes[0].issues.length).toBeGreaterThan(0);
  expect(report.scenes[0].issues.length).toBeLessThan(310);
  expect(Buffer.byteLength(JSON.stringify(report.scenes))).toBeLessThanOrEqual(PROJECT_SCAN_LIMITS.detailBytes);
  expect(report.scope).toMatchObject({ firstRemainingPath: 'b.txt', nextStartAfter: 'a.txt', remainingScenes: 1 });
});
