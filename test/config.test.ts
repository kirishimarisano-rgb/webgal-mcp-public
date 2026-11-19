import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProject, loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { LIMITS } from '../src/types.js';

describe('config', () => {
  let baseDirectory: string;
  let configDirectory: string;
  let configPath: string;

  beforeEach(async () => {
    baseDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-config-')));
    configDirectory = path.join(baseDirectory, '配置 目录');
    configPath = path.join(configDirectory, 'webgal-mcp.json');
    await mkdir(configDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 });
  });

  async function writeConfig(value: unknown): Promise<void> {
    await writeFile(configPath, JSON.stringify(value), 'utf8');
  }

  async function expectAppError(
    operation: Promise<unknown>,
    code: string
  ): Promise<AppError> {
    try {
      await operation;
      throw new Error(`Expected AppError ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(code);
      expect(appError.message).not.toContain(baseDirectory);
      return appError;
    }
  }

  it('loads strict version 1 config, resolves relative roots, and defaults sources', async () => {
    const projectRoot = path.join(baseDirectory, '工程 A');
    await mkdir(projectRoot);
    await writeConfig({
      version: 1,
      projects: [
        {
          id: 'main',
          name: '中文 工程',
          root: '../工程 A',
          terreUrl: 'http://127.0.0.1:3001/',
          terreGameDir: 'main project'
        }
      ]
    });

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.projects).toEqual([
      {
        id: 'main',
        name: '中文 工程',
        root: await realpath(projectRoot),
        terreUrl: 'http://127.0.0.1:3001',
        terreGameDir: 'main project'
      }
    ]);
    expect(config.sources).toEqual([]);
  });

  it('resolves project and source roots to real directories', async () => {
    const projectTarget = path.join(baseDirectory, 'project-target');
    const projectLink = path.join(baseDirectory, 'project-link');
    const sourceRoot = path.join(baseDirectory, '素材 来源');
    await mkdir(projectTarget);
    await mkdir(sourceRoot);
    await symlink(projectTarget, projectLink, 'junction');
    await writeConfig({
      version: 1,
      projects: [{ id: 'project', root: '../project-link' }],
      sources: [{ id: 'source', root: '../素材 来源' }]
    });

    const config = await loadConfig(configPath);
    expect(config.projects[0]?.root).toBe(await realpath(projectTarget));
    expect(config.sources[0]?.root).toBe(await realpath(sourceRoot));
  });

  it('returns registered projects and rejects unknown project ids', async () => {
    const projectRoot = path.join(baseDirectory, 'project');
    await mkdir(projectRoot);
    await writeConfig({
      version: 1,
      projects: [{ id: 'known', root: '../project' }]
    });

    const config = await loadConfig(configPath);
    expect(getProject(config, 'known').id).toBe('known');
    await expectAppError(
      Promise.resolve().then(() => getProject(config, 'missing')),
      'PROJECT_NOT_AUTHORIZED'
    );
  });

  it.each([
    ['unknown root key', { version: 1, projects: [], extra: true }],
    ['unknown project key', {
      version: 1,
      projects: [{ id: 'a', root: '.', extra: true }]
    }],
    ['wrong version', { version: 2, projects: [] }],
    ['missing projects', { version: 1 }],
    ['duplicate project id', {
      version: 1,
      projects: [
        { id: 'same', root: '.' },
        { id: 'same', root: '.' }
      ]
    }],
    ['duplicate source id', {
      version: 1,
      projects: [],
      sources: [
        { id: 'same', root: '.' },
        { id: 'same', root: '.' }
      ]
    }],
    ['invalid project id', {
      version: 1,
      projects: [{ id: '_invalid', root: '.' }]
    }],
    ['invalid source id', {
      version: 1,
      projects: [],
      sources: [{ id: 'invalid.id', root: '.' }]
    }],
    ['project id above 64 characters', {
      version: 1,
      projects: [{ id: 'a'.repeat(65), root: '.' }]
    }],
    ['project name above 256 characters', {
      version: 1,
      projects: [{ id: 'valid', name: 'a'.repeat(257), root: '.' }]
    }],
    ['root above 4096 characters', {
      version: 1,
      projects: [{ id: 'valid', root: 'a'.repeat(4097) }]
    }],
    ['more than 64 projects', {
      version: 1,
      projects: Array.from({ length: 65 }, (_, index) => ({
        id: `project${index}`,
        root: '.'
      }))
    }],
    ['more than 64 sources', {
      version: 1,
      projects: [],
      sources: Array.from({ length: 65 }, (_, index) => ({
        id: `source${index}`,
        root: '.'
      }))
    }]
  ])('rejects %s', async (_label, value) => {
    await writeConfig(value);
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');
  });

  it('accepts a 64-character id and rejects incomplete or remote Terre mappings', async () => {
    await writeConfig({
      version: 1,
      projects: [{ id: 'a'.repeat(64), root: '.' }]
    });
    expect((await loadConfig(configPath)).projects[0]?.id).toBe('a'.repeat(64));

    await writeConfig({
      version: 1,
      projects: [{
        id: 'pair',
        root: '.',
        terreUrl: 'http://127.0.0.1:3001'
      }]
    });
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');

    await writeConfig({
      version: 1,
      projects: [{
        id: 'pair',
        root: '.',
        terreGameDir: 'demo'
      }]
    });
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');

    await writeConfig({
      version: 1,
      projects: [{
        id: 'remote',
        root: '.',
        terreUrl: 'http://example.com:3001',
        terreGameDir: 'demo'
      }]
    });
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');
  });

  it.each(['a/b', 'a\\b', '..', '.', 'CON', 'trailing.'])(
    'rejects invalid Terre game directory %s',
    async (terreGameDir) => {
      await writeConfig({
        version: 1,
        projects: [{
          id: 'project',
          root: '.',
          terreUrl: 'http://127.0.0.1:3001',
          terreGameDir
        }]
      });
      await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');
    }
  );

  it('rejects a root that is missing or is not a directory', async () => {
    await writeConfig({
      version: 1,
      projects: [{ id: 'missing', root: '../missing' }]
    });
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');

    const fileRoot = path.join(baseDirectory, 'not-a-directory');
    await writeFile(fileRoot, 'content', 'utf8');
    await writeConfig({
      version: 1,
      projects: [{ id: 'file', root: '../not-a-directory' }]
    });
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');
  });

  it('reports missing and invalid config without exposing raw paths', async () => {
    await expectAppError(loadConfig(configPath), 'CONFIG_NOT_FOUND');

    await writeFile(configPath, '{not-json', 'utf8');
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');
  });

  it('rejects non-regular, invalid UTF-8, and oversized config files', async () => {
    await rm(configPath, { force: true });
    await mkdir(configPath);
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');

    await rm(configPath, { recursive: true });
    await writeFile(configPath, Buffer.from([0x7b, 0xff, 0x7d]));
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');

    await writeFile(configPath, Buffer.alloc(LIMITS.textBytes + 1, 0x20));
    await expectAppError(loadConfig(configPath), 'INVALID_CONFIG');
  });
});
