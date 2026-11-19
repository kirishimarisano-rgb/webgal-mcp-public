import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { publicError, AppError } from './errors.js';
import { ReadService, ASSET_DIRS } from './service.js';
import { PROJECT_SCAN_LIMITS } from './project-scan.js';
import { LIMITS, type AppConfig } from './types.js';
import { registerWriteTools, type WriteToolOptions } from './write-tools.js';

const projectId = z.string().min(1).max(64);
const relativePath = z.string().min(1).max(1024);
const paging = { cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(LIMITS.pageSize).optional() };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(config: AppConfig, options: WriteToolOptions = {}) {
  config = structuredClone(config);
  const server = new McpServer({ name: 'webgal-mcp', version: '0.2.0' });
  const service = new ReadService(config);
  const writeToolsEnabled = Boolean(options.stateRoot);
  async function result(operation: () => unknown | Promise<unknown>) {
    try {
      const data = await operation();
      const text = JSON.stringify(data);
      const businessFailure = typeof data === 'object' && data !== null && 'status' in data && ['failed', 'partial', 'uncertain'].includes(String(data.status));
      const response = { ...(businessFailure ? { isError: true } : {}), content: [{ type: 'text' as const, text }], structuredContent: { data } };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > LIMITS.responseBytes) throw new AppError('LIMIT_EXCEEDED', 'The result exceeds the response limit. Use a smaller page or narrower query.');
      return response;
    } catch (error) {
      const detail = publicError(error);
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
    }
  }
  server.registerTool('webgal_status', {
    description: 'Check local project files, Terre connectivity and project mapping, and get next steps. Pass projectId for project checks. Reports write-tool availability and the manual handoff requirement.',
    inputSchema: z.object({ projectId: projectId.optional() }).strict(),
    annotations,
  }, args => result(async () => {
    const status = await service.status(args.projectId);
    const writeNextStep = writeToolsEnabled
      ? '每批写入前，请用户在 Terre 中成功保存、关闭该工程的所有编辑页，再明确确认本批交接。'
      : '如需修改文件，在 MCP 启动参数中添加 --state-root，指定与所有工程和素材目录分开的私有目录，再重启 MCP 连接。';
    return {
      ...status,
      ...(writeToolsEnabled ? { stage: 'P3', readOnly: false } : {}),
      writeToolsEnabled,
      handoffRequired: true,
      nextSteps: [...status.nextSteps, writeNextStep],
    };
  }));
  server.registerTool('project_list', { description: 'List only projects authorized in the local configuration.', inputSchema: z.object(paging).strict(), annotations }, args => result(() => service.projects(args)));
  server.registerTool('project_inspect', { description: 'Inspect an authorized WebGAL project and its configuration summary. Use webgal_status with the projectId for connection troubleshooting and next steps.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(async () => ({ ...await service.inspect(args.projectId), ...(writeToolsEnabled ? { readOnly: false, writeToolsEnabled: true, writeAuthorization: 'per-session' } : {}) })));
  server.registerTool('project_scan', {
    description: 'Report missing and unverified references in saved scenes of an authorized project. Read-only and bounded. Check coverage and continue with scope.nextStartAfter when present. Does not fetch URLs or run the game.',
    inputSchema: z.object({
      projectId,
      limit: z.number().int().min(1).max(PROJECT_SCAN_LIMITS.scenes).optional(),
      startAfter: z.string().min(1).max(32767).optional(),
    }).strict(),
    annotations,
  }, args => result(() => service.scan(args.projectId, args)));
  server.registerTool('scene_list', { description: 'List .txt scenes recursively, with paths relative to game/scene and bounded pagination.', inputSchema: z.object({ projectId, ...paging }).strict(), annotations }, args => result(() => service.scenes(args.projectId, args)));
  server.registerTool('scene_read', { description: 'Read a UTF-8 scene from disk with raw-byte SHA-256 revision and newline metadata. It may differ from unsaved Terre content.', inputSchema: z.object({ projectId, path: relativePath }).strict(), annotations }, args => result(() => service.scene(args.projectId, args.path)));
  server.registerTool('scene_validate', { description: 'Analyze scene syntax and static references without executing scripts or fetching resources. Dynamic references remain unresolved.', inputSchema: z.object({ projectId, path: relativePath, candidateText: z.string().max(LIMITS.textBytes).optional() }).strict(), annotations }, args => result(() => service.validate(args.projectId, args.path, args.candidateText)));
  server.registerTool('asset_list', { description: 'List existing assets in known game asset directories; no import, overwrite or download.', inputSchema: z.object({ projectId, kind: z.enum(Object.keys(ASSET_DIRS) as [keyof typeof ASSET_DIRS, ...(keyof typeof ASSET_DIRS)[]]).optional(), ...paging }).strict(), annotations }, args => result(() => service.assets(args.projectId, args.kind, args)));
  server.registerTool('game_config_read', { description: 'Read game/config.txt as original text with a revision and parsed configuration summary.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(() => service.gameConfig(args.projectId)));
  server.registerTool('preview_get_url', { description: 'Return the configured official Terre preview URL. Does not open a browser, execute preview commands or prove the game runs.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(() => service.preview(args.projectId)));
  if (writeToolsEnabled) registerWriteTools(server, config, options, result);
  return server;
}
