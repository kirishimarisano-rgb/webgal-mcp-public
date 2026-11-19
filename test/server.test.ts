import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

let temporary: string;
let project: string;
let client: Client;
let stderr = '';
let before: string;
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function snapshot(dir: string): Promise<string> {
  const all: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    all.push(entry.isDirectory() ? `${entry.name}/${await snapshot(child)}` : `${entry.name}:${createHash('sha256').update(await readFile(child)).digest('hex')}`);
  }
  return all.sort().join('|');
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { type: string; text?: string }[];
  let data: any;
  try { data = JSON.parse(content[0].text!); } catch { data = content[0].text; }
  return { ...response, data };
}
beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'webgal-mcp-server-'));
  project = path.join(temporary, 'game project');
  await mkdir(path.join(project, 'game/scene/chapter'), { recursive: true });
  await mkdir(path.join(project, 'game/background'), { recursive: true });
  await writeFile(path.join(project, 'game/scene/start.txt'), 'changeBg:missing.png;\n角色:你好;\nchangeScene:chapter/next.txt;\n');
  await writeFile(path.join(project, 'game/scene/chapter/next.txt'), '');
  await writeFile(path.join(project, 'game/scene/large.txt'), '"'.repeat(600_000));
  await writeFile(path.join(project, 'game/config.txt'), 'Game_name:P1 fixture;\nGame_key:p1-fixture;\n');
  await writeFile(path.join(project, 'game/background/测试.png'), new Uint8Array([1, 2, 3]));
  const config = path.join(temporary, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, projects: [{ id: 'test', root: project }] }));
  before = await snapshot(project);
  client = new Client({ name: 'webgal-mcp-p1-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', config], stderr: 'pipe' });
  transport.stderr?.on('data', value => { stderr += value.toString(); });
  await client.connect(transport);
});
afterAll(async () => {
  if (client) await client.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
describe('P1 real stdio read-only tool surface', () => {
  it('exposes exactly nine read tools and no mutation surface', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual(['webgal_status', 'project_list', 'project_inspect', 'scene_list', 'scene_read', 'scene_validate', 'asset_list', 'game_config_read', 'preview_get_url'].sort());
    expect(tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
    expect((await call('webgal_status')).data).toMatchObject({ writable: false, editorState: 'unknown' });
  });
  it('reads authorized content, paginates, and preserves empty files', async () => {
    const projects = await call('project_list');
    expect(projects.data.items).toEqual([{ id: 'test', name: 'test' }]);
    const first = await call('scene_list', { projectId: 'test', limit: 1 });
    expect(first.data.items).toHaveLength(1);
    const second = await call('scene_list', { projectId: 'test', limit: 1, cursor: first.data.nextCursor });
    expect(second.data.items).toHaveLength(1);
    expect(first.data.items[0].path).not.toBe(second.data.items[0].path);
    const empty = await call('scene_read', { projectId: 'test', path: 'chapter/next.txt' });
    expect(empty.data).toMatchObject({ text: '', bytes: 0, source: 'disk' });
    expect(empty.data.revision).toMatch(/^[a-f0-9]{64}$/);
    const config = await call('game_config_read', { projectId: 'test' });
    expect(config.data.text).toContain('P1 fixture');
    expect((await call('asset_list', { projectId: 'test' })).data.items).toHaveLength(1);
    expect((await call('project_inspect', { projectId: 'test' })).data.projectType).toBe('content-only');
  });
  it('returns explicit errors without leaking filesystem roots', async () => {
    for (const args of [{ projectId: 'unknown', path: 'start.txt' }, { projectId: 'test', path: '../config.txt' }, { projectId: 'test', path: 'missing.txt' }]) {
      const response = await call('scene_read', args);
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain(temporary);
    }
    expect((await call('scene_list', { projectId: 'test', cursor: 'invalid' })).isError).toBe(true);
    expect((await call('preview_get_url', { projectId: 'test' })).isError).toBe(true);
    expect((await call('scene_read', { projectId: 'test', path: 'start.txt', force: true })).isError).toBe(true);
  });
  it('analyzes references without changing project files or stdout logging', async () => {
    const analyzed = await call('scene_validate', { projectId: 'test', path: 'start.txt' });
    expect(analyzed.isError).not.toBe(true);
    expect(JSON.stringify(analyzed.data)).toContain('missing.png');
    expect(await snapshot(project)).toBe(before);
    expect(stderr).toBe('');
  });
  it('enforces the complete MCP response size and cursor binding', async () => {
    const oversized = await call('scene_read', { projectId: 'test', path: 'large.txt' });
    expect(oversized.isError).toBe(true);
    expect(oversized.data.error.code).toBe('LIMIT_EXCEEDED');
    expect(JSON.stringify(oversized).length).toBeLessThan(1000);
    const scenes = await call('scene_list', { projectId: 'test', limit: 1 });
    expect((await call('asset_list', { projectId: 'test', cursor: scenes.data.nextCursor })).isError).toBe(true);
  });
});
