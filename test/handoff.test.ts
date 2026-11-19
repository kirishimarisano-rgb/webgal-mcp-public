import { mkdir, mkdtemp, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { ProjectLocks } from '../src/changes/locks.js';

it('revokes previous project handoffs when the user declares not-ready', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'wgmcp-handoff-'));
  const root = path.join(base, 'project');
  await mkdir(path.join(root, 'game/scene'), { recursive: true });
  await writeFile(path.join(root, 'game/config.txt'), 'Game_name:Test;\n');
  const server = createServer({ version: 1, projects: [{ id: 'test', root }], sources: [] }, {
    stateRoot: path.join(base, 'state'),
    coordinatorOptions: { locks: new ProjectLocks(path.join(base, 'locks')), capabilityCheck: async () => true }
  });
  const client = new Client({ name: 'handoff-revocation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse((result.content as { text: string }[])[0].text) };
  }
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const ready = await call('write_session_begin', { projectId: 'test', paths: ['game/scene/new.txt'], decision: 'saved-and-editors-closed', statement: 'Saved and left this temporary project.' });
    const planned = await call('change_plan', { projectId: 'test', sessionId: ready.data.sessionId, operations: [{ type: 'create_scene', path: 'new.txt', text: 'candidate only\n' }] });
    expect(planned.data.committable).toBe(true);
    const declined = await call('write_session_begin', { projectId: 'test', paths: ['game/scene/new.txt'], decision: 'not-ready', statement: 'I have unsaved changes and cannot hand over.' });
    expect(declined.result.isError).toBe(true);
    expect(declined.data.error.code).toBe('HANDOFF_REQUIRED');
    const refused = await call('change_apply', { sessionId: ready.data.sessionId, planId: planned.data.planId, idempotencyKey: 'revoked' });
    expect(refused.result.isError).toBe(true);
    expect(refused.data.error.code).toBe('HANDOFF_REQUIRED');
    await expect(access(path.join(root, 'game/scene/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await client.close();
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
});
