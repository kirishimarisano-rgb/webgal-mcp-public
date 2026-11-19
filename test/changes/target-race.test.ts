import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('publishes exactly one winner when two processes create the same new scene', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'wgmcp-create-race-'));
  const root = path.join(base, 'project');
  const children: ChildProcessWithoutNullStreams[] = [];
  await mkdir(path.join(root, 'game', 'scene'), { recursive: true });
  try {
    const racers = ['first contender', 'second contender'].map(content => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/create-child.mjs', import.meta.url)), root, content], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let output = '';
      let stderr = '';
      let readyResolve: () => void;
      let readyReject: (reason?: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) readyResolve(); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise<{ status: string; content?: string; code?: string }>((resolve, reject) => {
        child.once('error', error => { readyReject(error); reject(error); });
        child.once('close', code => {
          if (code !== 0) { const error = new Error(`Create fixture failed (${code}): ${stderr}`); readyReject(error); reject(error); return; }
          try { resolve(JSON.parse(output.trim().split('\n').at(-1)!)); } catch (error) { readyReject(error); reject(error); }
        });
      });
      return { child, ready, done };
    });
    await Promise.all(racers.map(racer => racer.ready));
    racers.forEach(racer => racer.child.stdin.end('go\n'));
    const results = await Promise.all(racers.map(racer => racer.done));
    expect(results.filter(result => result.status === 'created')).toHaveLength(1);
    expect(results.filter(result => result.status === 'refused')).toEqual([{ status: 'refused', code: 'TARGET_EXISTS' }]);
    expect(await readFile(path.join(root, 'game', 'scene', 'race.txt'), 'utf8')).toBe(results.find(result => result.status === 'created')!.content);
    expect(await readdir(path.join(root, 'game', 'scene'))).toEqual(['race.txt']);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once('close', () => resolve())); }
    }
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
}, 15000);
