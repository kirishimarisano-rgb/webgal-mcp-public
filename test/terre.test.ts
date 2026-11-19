import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  inspectTerre,
  normalizeTerreUrl,
  previewUrl,
  type TerreInspection,
} from '../src/terre.js';
import { LIMITS, type ProjectConfig } from '../src/types.js';

const servers = new Set<Server>();
const tempRoots = new Set<string>();

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();

  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe('normalizeTerreUrl', () => {
  it('accepts only normalized loopback HTTP roots', () => {
    expect(normalizeTerreUrl('http://localhost:3001')).toBe(
      'http://localhost:3001',
    );
    expect(normalizeTerreUrl('http://localhost:3001/')).toBe(
      'http://localhost:3001',
    );
    expect(normalizeTerreUrl('http://127.0.0.1:3001/')).toBe(
      'http://127.0.0.1:3001',
    );
    expect(normalizeTerreUrl('http://[::1]:3001/')).toBe(
      'http://[::1]:3001',
    );
  });

  it.each([
    'https://localhost:3001',
    'http://example.com:3001',
    'http://user@localhost:3001',
    'http://localhost:3001?x=1',
    'http://localhost:3001#x',
    'http://localhost:3001/api',
    'http://127.1:3001',
    'http://localhost%2e:3001',
    'http://localhost:3001/%2e%2e',
    'http://localhost:3001\\api',
    ' http://localhost:3001',
  ])('rejects unsafe or non-loopback URL %s', (input) => {
    expect(() => normalizeTerreUrl(input)).toThrow(AppError);
  });
});

describe('previewUrl', () => {
  it('encodes the configured game directory', () => {
    expect(
      previewUrl({
        id: 'demo',
        root: 'C:\\unused',
        terreUrl: 'http://127.0.0.1:3001/',
        terreGameDir: '游戏 项目',
      }),
    ).toBe(
      `http://127.0.0.1:3001/games/${encodeURIComponent('游戏 项目')}/`,
    );
  });

  it('requires both URL and directory mapping', () => {
    expect(() =>
      previewUrl({
        id: 'demo',
        root: 'C:\\unused',
        terreUrl: 'http://127.0.0.1:3001',
      }),
    ).toThrow(
      expect.objectContaining({ code: 'CONFIG_REQUIRED' }) as AppError,
    );
  });
});

describe('inspectTerre', () => {
  it('returns an offline status without connecting when terreUrl is absent', async () => {
    const result = await inspectTerre({
      id: 'offline',
      root: await createProjectRoot(),
      terreGameDir: 'demo',
    });

    expect(result).toEqual({
      reachable: false,
      compatibility: 'unknown',
      capabilities: {
        apiTest: 'unknown',
        openApi: 'unknown',
        readGameAssets: 'unknown',
        preview: 'unknown',
      },
      mappingVerified: false,
      version: 'unknown',
    });
  });

  it('verifies the real API signature, OpenAPI routes, and scene mapping', async () => {
    const root = await createProjectRoot();
    const gameDir = '游戏 项目';
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
        return;
      }
      if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
        return;
      }
      if (
        path ===
        `/api/manageGame/readGameAssets/${encodeURIComponent(gameDir)}/game/scene`
      ) {
        sendJson(response, 200, {
          readDirPath: `${gameDir}/game/scene`,
          dirPath: join(root, 'game', 'scene'),
          dirInfo: [],
        });
        return;
      }
      sendText(response, 404, 'not found');
    });

    const result = await inspectTerre(project(root, server.baseUrl, gameDir));

    expect(result).toMatchObject({
      reachable: true,
      compatibility: 'unknown',
      capabilities: {
        apiTest: 'available',
        openApi: 'available',
        readGameAssets: 'available',
        preview: 'unknown',
      },
      mappingVerified: true,
      version: 'unknown',
    });
    expect(server.requests).toEqual([
      '/api/test',
      '/api-json',
      `/api/manageGame/readGameAssets/${encodeURIComponent(gameDir)}/game/scene`,
    ]);
    expect(server.requests).not.toContain('/api/userData/status');
    expect(server.requests).not.toContain('/api/manageGame/gameList');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('does not request readGameAssets without an explicit mapping', async () => {
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
      } else if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.capabilities.readGameAssets).toBe('unavailable');
    expect(result.capabilities.preview).toBe('unavailable');
    expect(server.requests).toEqual(['/api/test', '/api-json']);
  });

  it('marks an invalid /api/test body as incompatible', async () => {
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'OK');
      } else if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.reachable).toBe(true);
    expect(result.compatibility).toBe('incompatible');
    expect(result.capabilities.apiTest).toBe('unavailable');
  });

  it('keeps reachability separate from an HTTP error body', async () => {
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 500, '<html>failure</html>');
      } else if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.reachable).toBe(true);
    expect(result.compatibility).toBe('incompatible');
    expect(result.capabilities.apiTest).toBe('unavailable');
  });

  it('rejects invalid OpenAPI JSON', async () => {
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
      } else if (path === '/api-json') {
        sendText(response, 200, '{invalid');
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.reachable).toBe(true);
    expect(result.compatibility).toBe('incompatible');
    expect(result.capabilities.openApi).toBe('unavailable');
  });

  it('requires the expected OpenAPI title and routes', async () => {
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
      } else if (path === '/api-json') {
        sendJson(response, 200, {
          openapi: '3.0.0',
          info: { title: 'Other API', version: '1.0' },
          paths: { '/api/test': { get: {} } },
        });
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.compatibility).toBe('incompatible');
    expect(result.capabilities.openApi).toBe('unavailable');
  });

  it('does not accept a failure string from readGameAssets', async () => {
    const root = await createProjectRoot();
    const gameDir = 'demo';
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
      } else if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
      } else if (
        path ===
        `/api/manageGame/readGameAssets/${encodeURIComponent(gameDir)}/game/scene`
      ) {
        sendJson(response, 200, 'path error or no right.');
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre(project(root, server.baseUrl, gameDir));

    expect(result.capabilities.readGameAssets).toBe('unavailable');
    expect(result.mappingVerified).toBe(false);
    expect(result.compatibility).toBe('incompatible');
  });

  it.each([null, {}, []])(
    'does not treat an empty readGameAssets value as success: %j',
    async (emptyValue) => {
      const root = await createProjectRoot();
      const gameDir = 'demo';
      const server = await startServer((request, response) => {
        const path = requestPath(request.url);
        if (path === '/api/test') {
          sendText(response, 200, 'WebGAL Terre Application API Test OK');
        } else if (path === '/api-json') {
          sendJson(response, 200, compatibleOpenApi());
        } else if (
          path ===
          `/api/manageGame/readGameAssets/${encodeURIComponent(gameDir)}/game/scene`
        ) {
          sendJson(response, 200, emptyValue);
        } else {
          sendText(response, 404, 'not found');
        }
      });

      const result = await inspectTerre(project(root, server.baseUrl, gameDir));

      expect(result.capabilities.readGameAssets).toBe('unavailable');
      expect(result.mappingVerified).toBe(false);
      expect(result.compatibility).toBe('incompatible');
    },
  );

  it('rejects a scene dirPath that does not match the project root', async () => {
    const root = await createProjectRoot();
    const otherRoot = await createProjectRoot();
    const gameDir = 'demo';
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
      } else if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
      } else if (
        path ===
        `/api/manageGame/readGameAssets/${encodeURIComponent(gameDir)}/game/scene`
      ) {
        sendJson(response, 200, {
          readDirPath: `${gameDir}/game/scene`,
          dirPath: join(otherRoot, 'game', 'scene'),
          dirInfo: [],
        });
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre(project(root, server.baseUrl, gameDir));

    expect(result.capabilities.readGameAssets).toBe('available');
    expect(result.mappingVerified).toBe(false);
    expect(result.compatibility).toBe('unknown');
  });

  it('does not follow redirects', async () => {
    const server = await startServer((request, response) => {
      const path = requestPath(request.url);
      if (path === '/api/test') {
        response.writeHead(302, { location: '/redirect-target' });
        response.end();
      } else if (path === '/redirect-target') {
        sendText(response, 200, 'WebGAL Terre Application API Test OK');
      } else if (path === '/api-json') {
        sendJson(response, 200, compatibleOpenApi());
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.reachable).toBe(true);
    expect(result.capabilities.apiTest).toBe('unavailable');
    expect(result.compatibility).toBe('incompatible');
    expect(server.requests).not.toContain('/redirect-target');
  });

  it('returns an offline status on timeout', async () => {
    const server = await startServer(() => undefined);

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.reachable).toBe(false);
    expect(result.capabilities.apiTest).toBe('unavailable');
    expect(result.compatibility).toBe('unknown');
  });

  it('stops reading a response above the byte cap', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request.url) === '/api/test') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': String(LIMITS.responseBytes + 1),
        });
        response.end(Buffer.alloc(LIMITS.responseBytes + 1, 'x'));
      } else {
        sendText(response, 404, 'not found');
      }
    });

    const result = await inspectTerre({
      id: 'demo',
      root: await createProjectRoot(),
      terreUrl: server.baseUrl,
    });

    expect(result.reachable).toBe(true);
    expect(result.capabilities.apiTest).toBe('unavailable');
    expect(result.compatibility).toBe('incompatible');
  });
});

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'webgal-mcp-terre-'));
  tempRoots.add(root);
  await mkdir(join(root, 'game', 'scene'), { recursive: true });
  return root;
}

function project(
  root: string,
  terreUrl: string,
  terreGameDir: string,
): ProjectConfig {
  return { id: 'demo', root, terreUrl, terreGameDir };
}

function compatibleOpenApi(): object {
  return {
    openapi: '3.0.0',
    info: { title: 'WebGAL Terre API', version: '1.0' },
    paths: {
      '/api/test': { get: {} },
      '/api/manageGame/readGameAssets/{readDirPath}': { get: {} },
    },
  };
}

function requestPath(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').pathname;
}

function sendText(
  response: import('node:http').ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function startServer(
  handler: (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => void,
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    handler(request, response);
  });
  servers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  };
}
