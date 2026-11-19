import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReadService } from '../src/service.js';
let root: string;
let service: ReadService;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'webgal-mcp-service-'));
  await mkdir(path.join(root, 'game/scene'), { recursive: true });
  await writeFile(path.join(root, 'game/config.txt'), '');
  service = new ReadService({ version: 1, projects: [{ id: 'test', root }], sources: [] });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('requires the configured project to remain valid for candidate analysis', async () => {
  await rm(path.join(root, 'game/scene'), { recursive: true });
  await expect(service.validate('test', 'start.txt', '角色:hello;')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
});
it('does not mistake directories for engine, scene or resource files', async () => {
  await mkdir(path.join(root, 'index.html'));
  await mkdir(path.join(root, 'game/scene/start.txt'));
  await mkdir(path.join(root, 'game/background/missing.png'), { recursive: true });
  expect(await service.inspect('test')).toMatchObject({ projectType: 'content-only', entryExists: false });
  const result = await service.validate('test', 'start.txt', 'changeBg:missing.png;');
  expect(JSON.stringify(result)).toContain('missing.png');
  expect(JSON.stringify(result)).toContain('missing');
  const refs = result.staticReferences;
  expect(refs[0].exists).toBe(false);
});
it('distinguishes a missing asset directory from an empty one', async () => {
  await expect(service.assets('test', 'bgm', {})).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  expect(await service.assets('test', undefined, {})).toMatchObject({ missingKinds: ['background', 'figure', 'bgm', 'vocal', 'video', 'animation'] });
  await mkdir(path.join(root, 'game/bgm'));
  expect(await service.assets('test', 'bgm', {})).toMatchObject({ items: [], missingKinds: [] });
});
it('does not report an ordinary file named game as an empty game tree', async () => {
  await rm(path.join(root, 'game'), { recursive: true });
  await writeFile(path.join(root, 'game'), 'not a directory');
  await expect(service.assets('test', undefined, {})).rejects.toMatchObject({ code: 'FILE_NOT_DIRECTORY' });
});
