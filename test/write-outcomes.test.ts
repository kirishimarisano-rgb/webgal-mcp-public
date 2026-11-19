import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProjectLocks } from '../src/changes/locks.js';
import { createServer } from '../src/server.js';
import type { AppConfig } from '../src/types.js';

const projectId = 'project';
const scenePath = 'game/scene/new.txt';
const sceneBytes = Buffer.from('new bytes after publish\n', 'utf8');

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ response: Awaited<ReturnType<Client['callTool']>>; data: any }> {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { type: string; text?: string }[];
  let data: any;
  try {
    data = JSON.parse(content[0]?.text ?? 'null');
  } catch {
    data = content[0]?.text;
  }
  return { response, data };
}

describe('write result outcome transport', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let stateRoot: string;
  let lockRoot: string;
  let client: Client | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-outcomes-')));
    projectRoot = path.join(baseDirectory, 'Project');
    stateRoot = path.join(baseDirectory, 'state');
    lockRoot = path.join(baseDirectory, 'locks');
    await mkdir(path.join(projectRoot, 'game', 'scene'), { recursive: true });
    await writeFile(path.join(projectRoot, 'game', 'config.txt'), 'Game_name:Test;\n');
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  it('marks an actual after-write uncertain result as isError while preserving recovery metadata', async () => {
    const config: AppConfig = {
      version: 1,
      projects: [{ id: projectId, root: projectRoot }],
      sources: []
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createServer(config, {
      stateRoot,
      coordinatorOptions: {
        locks: new ProjectLocks(lockRoot),
        capabilityCheck: async () => true,
        fault: (point, index) => {
          if (point === 'after-write' && index === 0) {
            throw new Error('injected after-write fault');
          }
        }
      }
    });
    client = new Client({ name: 'webgal-mcp-outcome-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const session = await call(client, 'write_session_begin', {
      projectId,
      paths: [scenePath],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    expect(session.response.isError).not.toBe(true);
    const plan = await call(client, 'change_plan', {
      projectId,
      sessionId: session.data.sessionId,
      operations: [{
        type: 'create_scene',
        path: 'new.txt',
        text: sceneBytes.toString('utf8')
      }]
    });
    expect(plan.response.isError).not.toBe(true);

    const applied = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'after-write-outcome'
    });
    expect(applied.response.isError).toBe(true);
    expect(applied.data).toMatchObject({
      status: 'uncertain',
      batchId: expect.any(String),
      errorCode: 'WRITE_FAILED',
      replayed: false
    });
    expect(applied.data.operations).toHaveLength(1);

    const inspected = await call(client, 'recovery_inspect', {
      projectId,
      batchId: applied.data.batchId
    });
    expect(inspected.data.batchId).toBe(applied.data.batchId);
    expect(inspected.data.status).toBe('uncertain');
    expect(inspected.data.operations[0]).toMatchObject({
      path: scenePath,
      phase: 'intent',
      currentRevision: sha256(sceneBytes),
      diskState: 'planned'
    });
    expect(await readFile(path.join(projectRoot, 'game', 'scene', 'new.txt')))
      .toEqual(sceneBytes);
  });
});
