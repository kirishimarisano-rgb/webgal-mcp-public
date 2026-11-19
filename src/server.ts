import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { publicError, AppError } from './errors.js';
import { ReadService, ASSET_DIRS } from './service.js';
import { LIMITS, type AppConfig } from './types.js';
import { registerWriteTools, type WriteToolOptions } from './write-tools.js';

const projectId = z.string().min(1).max(64);
const relativePath = z.string().min(1).max(1024);
const paging = { cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(LIMITS.pageSize).optional() };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(config: AppConfig, options: WriteToolOptions = {}) {
  config = structuredClone(config);
  const server = new McpServer({ name: 'webgal-mcp', version: '0.1.0' });
  const service = new ReadService(config);
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
  server.registerTool('webgal_status', { description: 'Read stage, configured write capability and optional Terre check. User handoff is required for writes; unsaved editor buffers are unknown.', inputSchema: z.object({ projectId: projectId.optional() }).strict(), annotations }, args => result(async () => ({ ...await service.status(args.projectId), ...(options.stateRoot ? { stage: 'P3', readOnly: false, writable: false, writeToolsEnabled: true, handoffRequired: true } : { writeToolsEnabled: false }) })));
  server.registerTool('project_list', { description: 'List only projects authorized in the local configuration.', inputSchema: z.object(paging).strict(), annotations }, args => result(() => service.projects(args)));
  server.registerTool('project_inspect', { description: 'Inspect an authorized WebGAL project without exposing its physical root.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(async () => ({ ...await service.inspect(args.projectId), ...(options.stateRoot ? { readOnly: false, writeToolsEnabled: true, writeAuthorization: 'per-session' } : {}) })));
  server.registerTool('scene_list', { description: 'List .txt scenes recursively, with paths relative to game/scene and bounded pagination.', inputSchema: z.object({ projectId, ...paging }).strict(), annotations }, args => result(() => service.scenes(args.projectId, args)));
  server.registerTool('scene_read', { description: 'Read a UTF-8 scene from disk with raw-byte SHA-256 revision and newline metadata. It may differ from unsaved Terre content.', inputSchema: z.object({ projectId, path: relativePath }).strict(), annotations }, args => result(() => service.scene(args.projectId, args.path)));
  server.registerTool('scene_validate', { description: 'Analyze scene syntax and static references without executing scripts or fetching resources. Dynamic references remain unresolved.', inputSchema: z.object({ projectId, path: relativePath, candidateText: z.string().max(LIMITS.textBytes).optional() }).strict(), annotations }, args => result(() => service.validate(args.projectId, args.path, args.candidateText)));
  server.registerTool('asset_list', { description: 'List existing assets in known game asset directories; no import, overwrite or download.', inputSchema: z.object({ projectId, kind: z.enum(Object.keys(ASSET_DIRS) as [keyof typeof ASSET_DIRS, ...(keyof typeof ASSET_DIRS)[]]).optional(), ...paging }).strict(), annotations }, args => result(() => service.assets(args.projectId, args.kind, args)));
  server.registerTool('game_config_read', { description: 'Read game/config.txt as original text with a revision and parsed configuration summary.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(() => service.gameConfig(args.projectId)));
  server.registerTool('preview_get_url', { description: 'Return the configured official Terre preview URL. Does not open a browser, execute preview commands or prove the game runs.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(() => service.preview(args.projectId)));
  if (options.stateRoot) registerWriteTools(server, config, options, result);
  return server;
}
