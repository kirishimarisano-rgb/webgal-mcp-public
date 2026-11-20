import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getProject } from './config.js';
import { listFiles, readText, resolveSafe, validateRelativePath } from './filesystem.js';
import { analyzeScene, parseGameConfig } from './analysis.js';
import { scanProject, type ProjectScanInput } from './project-scan.js';
import { inspectTerre, previewUrl, type TerreInspection } from './terre.js';
import { AppError, publicError } from './errors.js';
import { LIMITS, type AppConfig, type ProjectConfig } from './types.js';
import { createLive2dSceneCheck } from './live2d/scene.js';

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

async function readProjectConfig(project: ProjectConfig) {
  await directory(project.root, 'game/scene');
  return readText(project.root, 'game/config.txt');
}

async function checkProjectFiles(project: ProjectConfig) {
  try {
    await readProjectConfig(project);
    return { readable: true as const };
  } catch (error) {
    return { readable: false as const, errorCode: publicError(error).code };
  }
}

function projectFileNextStep(errorCode: string): string {
  switch (errorCode) {
    case 'FILE_NOT_FOUND':
    case 'FILE_NOT_DIRECTORY':
    case 'FILE_NOT_REGULAR':
    case 'PROJECT_NOT_AUTHORIZED':
    case 'PATH_INVALID':
    case 'PATH_OUTSIDE_PROJECT':
      return '核对 root 是否指向包含 game/scene 和 game/config.txt 的工程目录，并确认两者都在授权工程内。';
    case 'UNSUPPORTED_FORMAT':
      return '确认 game/config.txt 使用 UTF-8 编码，再运行 webgal_status。';
    case 'FILE_TOO_LARGE':
      return '确认 game/config.txt 是该工程的配置文件，且大小在 1 MiB 读取上限内。';
    case 'FILE_CHANGED':
      return '等文件修改完成后，再运行 webgal_status。';
    default:
      return '确认 MCP 进程能访问 game/scene 并读取 game/config.txt，再运行 webgal_status。';
  }
}

function terreNextStep(terre: TerreInspection): string | undefined {
  if (terre.connectionStatus === 'not_configured') {
    return '如需连接 Terre，将 terreUrl 设为本机 Terre 的 HTTP 地址，将 terreGameDir 设为工程的实际文件夹名。';
  }
  if (terre.connectionStatus === 'no_response') {
    return '未收到 HTTP 响应。确认 Terre 是否已启动，以及 terreUrl 的端口是否与它一致。';
  }
  if (terre.capabilities.apiTest !== 'available' || terre.capabilities.openApi !== 'available') {
    return '配置的端口有响应，但未能核对 Terre API。确认 terreUrl 指向正在运行的 Terre，并检查其 API 是否受支持。';
  }
  if (terre.mappingStatus === 'not_configured') {
    return '将 terreGameDir 设为 Terre 中该工程的实际文件夹名。';
  }
  if (terre.mappingStatus === 'mismatch') {
    return 'Terre 返回的场景目录与本机工程不匹配。核对 root 和 terreGameDir 是否指向同一个工程。';
  }
  if (terre.mappingStatus === 'unverified') {
    return '未能验证工程映射。核对 terreGameDir 的实际文件夹名，并确认 Terre 和 MCP 都能访问该工程。';
  }
}

export class ReadService {
  constructor(private readonly config: AppConfig) {}
  async status(projectId?: string) {
    const status = { stage: 'P1', readOnly: true, writable: false, editorState: 'unknown', projectCount: this.config.projects.length };
    if (!projectId) {
      const nextStep = status.projectCount > 0
        ? '用 project_list 找到工程 ID，再将它作为 projectId 运行 webgal_status。'
        : '在本机配置中登记一个工程，再重启 MCP 连接。';
      return { ...status, nextSteps: [nextStep] };
    }

    const project = getProject(this.config, projectId);
    const [projectFiles, terre] = await Promise.all([checkProjectFiles(project), inspectTerre(project)]);
    const nextSteps = projectFiles.readable ? [] : [projectFileNextStep(projectFiles.errorCode)];
    const terreStep = terreNextStep(terre);
    if (terreStep) nextSteps.push(terreStep);
    if (!projectFiles.readable || terreStep) {
      nextSteps.push('如有修改本机配置，重启 MCP 连接后再运行 webgal_status。');
    }
    if (projectFiles.readable) {
      nextSteps.push(terreStep
        ? '本机文件基础检查已通过。可以用 scene_list 选择场景，再用 scene_read 读取。'
        : '可用 scene_list 和 scene_read 读取场景，或用 preview_get_url 获取链接后在 Terre 中验证游戏运行。');
    }
    return { ...status, projectFiles, terre, nextSteps };
  }
  projects(input: PageInput) { return page(this.config.projects.map(p => ({ id: p.id, name: p.name ?? p.id })), 'projects', input); }
  async inspect(projectId: string) {
    const project = getProject(this.config, projectId);
    const document = await readProjectConfig(project);
    return { id: project.id, name: project.name ?? project.id, projectType: await exists(project.root, 'index.html') ? 'custom-engine' : 'content-only', entryExists: await exists(project.root, 'game/scene/start.txt'), configRevision: document.revision, config: parseGameConfig(document.text), terre: await inspectTerre(project), readOnly: true };
  }
  scan(projectId: string, input: ProjectScanInput): ReturnType<typeof scanProject> {
    const project = getProject(this.config, projectId);
    return scanProject(project, input, path => exists(project.root, path));
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
    const analysis = await analyzeScene(text, relative, path => exists(project.root, path), { checkLive2d: createLive2dSceneCheck(project) });
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
