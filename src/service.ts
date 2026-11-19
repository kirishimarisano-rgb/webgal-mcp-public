import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getProject } from './config.js';
import { listFiles, readText, resolveSafe, validateRelativePath } from './filesystem.js';
import { analyzeScene, parseGameConfig } from './analysis.js';
import { inspectTerre, previewUrl } from './terre.js';
import { AppError } from './errors.js';
import { LIMITS, type AppConfig, type ProjectConfig } from './types.js';

export interface PageInput { cursor?: string; limit?: number }
export function page<T>(items: T[], key: string, input: PageInput) {
  const limit = input.limit ?? LIMITS.pageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) throw new AppError('INVALID_ARGUMENT', 'Invalid page size.');
  const snapshot = createHash('sha256').update(JSON.stringify(items)).digest('hex');
  let offset = 0;
  if (input.cursor) {
    try {
      if (input.cursor.length > 1024) throw new Error();
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (value.key !== key || value.snapshot !== snapshot || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > items.length) throw new Error();
      offset = value.offset;
    } catch { throw new AppError('INVALID_CURSOR', 'The list changed or the cursor is invalid. Restart the list.'); }
  }
  const end = Math.min(offset + limit, items.length);
  return { items: items.slice(offset, end), total: items.length, nextCursor: end < items.length ? Buffer.from(JSON.stringify({ key, snapshot, offset: end })).toString('base64url') : null };
}

export const ASSET_DIRS = { background: 'background', figure: 'figure', bgm: 'bgm', vocal: 'vocal', video: 'video', animation: 'animation' } as const;
export type AssetKind = keyof typeof ASSET_DIRS;
const scenePath = (input: string) => {
  const relative = validateRelativePath(input);
  if (!relative.toLowerCase().endsWith('.txt')) throw new AppError('INVALID_ARGUMENT', 'Scene paths must end with .txt and be relative to game/scene.');
  return `game/scene/${relative}`;
};
async function exists(root: string, relative: string): Promise<boolean> {
  try { return (await stat(await resolveSafe(root, relative))).isFile(); }
  catch (error) { if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') return false; throw error; }
}
async function optionalFiles(project: ProjectConfig, relative: string) {
  try { return { files: await listFiles(project.root, relative), missing: false }; }
  catch (error) { if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') return { files: [], missing: true }; throw error; }
}
async function directory(root: string, relative: string) {
  if (!(await stat(await resolveSafe(root, relative))).isDirectory()) throw new AppError('FILE_NOT_DIRECTORY', 'The required project directory is not a directory.');
}

export class ReadService {
  constructor(private readonly config: AppConfig) {}
  async status(projectId?: string) {
    return { stage: 'P1', readOnly: true, writable: false, editorState: 'unknown', projectCount: this.config.projects.length, ...(projectId ? { terre: await inspectTerre(getProject(this.config, projectId)) } : {}) };
  }
  projects(input: PageInput) { return page(this.config.projects.map(p => ({ id: p.id, name: p.name ?? p.id })), 'projects', input); }
  async inspect(projectId: string) {
    const project = getProject(this.config, projectId);
    await directory(project.root, 'game/scene');
    const document = await readText(project.root, 'game/config.txt');
    return { id: project.id, name: project.name ?? project.id, projectType: await exists(project.root, 'index.html') ? 'custom-engine' : 'content-only', entryExists: await exists(project.root, 'game/scene/start.txt'), configRevision: document.revision, config: parseGameConfig(document.text), terre: await inspectTerre(project), readOnly: true };
  }
  async scenes(projectId: string, input: PageInput) {
    const project = getProject(this.config, projectId);
    const files = (await listFiles(project.root, 'game/scene', ['.txt'])).map(file => ({ ...file, path: file.path.replace(/^game\/scene\//, '') }));
    return page(files, `scenes:${projectId}`, input);
  }
  async scene(projectId: string, relative: string) {
    const project = getProject(this.config, projectId);
    return { path: validateRelativePath(relative), ...await readText(project.root, scenePath(relative)) };
  }
  async validate(projectId: string, relative: string, candidateText?: string) {
    const project = getProject(this.config, projectId);
    scenePath(relative);
    await directory(project.root, 'game/scene');
    const document = candidateText === undefined ? await readText(project.root, scenePath(relative)) : null;
    const text = document?.text ?? candidateText!;
    if (Buffer.byteLength(text, 'utf8') > LIMITS.textBytes) throw new AppError('LIMIT_EXCEEDED', 'The scene exceeds the text limit.');
    const analysis = await analyzeScene(text, relative, path => exists(project.root, path));
    return { path: relative, source: document ? 'disk' : 'candidate', revision: document?.revision ?? null, ...analysis };
  }
  async assets(projectId: string, kind: AssetKind | undefined, input: PageInput) {
    const project = getProject(this.config, projectId);
    await directory(project.root, 'game');
    const kinds = kind ? [kind] : Object.keys(ASSET_DIRS) as AssetKind[];
    const files = [];
    const missingKinds: AssetKind[] = [];
    for (const item of kinds) {
      const listing = await optionalFiles(project, `game/${ASSET_DIRS[item]}`);
      if (listing.missing) {
        if (kind) throw new AppError('FILE_NOT_FOUND', 'The requested asset directory was not found.');
        missingKinds.push(item);
      }
      files.push(...listing.files.map(file => ({ ...file, kind: item })));
      if (files.length > LIMITS.entries) throw new AppError('LIMIT_EXCEEDED', 'Too many assets. Select a kind.');
    }
    return { ...page(files, `assets:${projectId}:${kind ?? 'all'}`, input), missingKinds };
  }
  async gameConfig(projectId: string) {
    const document = await readText(getProject(this.config, projectId).root, 'game/config.txt');
    return { ...document, parsed: parseGameConfig(document.text) };
  }
  preview(projectId: string) { return { url: previewUrl(getProject(this.config, projectId)), checked: false, gameRuntimeVerified: false }; }
}
