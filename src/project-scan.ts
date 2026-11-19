import { analyzeScene, type UnresolvedReference } from './analysis.js';
import { AppError, publicError } from './errors.js';
import { listFiles, readText, validateRelativePath } from './filesystem.js';
import { LIMITS, type FileEntry, type ProjectConfig } from './types.js';

export const PROJECT_SCAN_LIMITS = Object.freeze({
  scenes: 100,
  inventoryEntries: LIMITS.entries,
  timeMs: 5000,
  sceneBytes: 128 * 1024,
  detailBytes: 128 * 1024,
});
const SCENE_DIRECTORY = 'game/scene';

export interface ProjectScanInput {
  startAfter?: string;
  limit?: number;
}

interface Issue {
  category: 'missing' | 'unverified';
  reason: UnresolvedReference['reason'];
  kind: UnresolvedReference['kind'];
  line: number;
  endLine: number;
  target: string | null;
}

interface SceneResult {
  path: string;
  status: 'checked' | 'incomplete';
  reason: string | null;
  issues: Issue[];
}

type StopReason = 'inventory_error' | 'time_limit' | 'scene_limit' | 'report_limit';

function sceneRelative(path: string): string {
  return path.slice(SCENE_DIRECTORY.length + 1);
}

function safeTarget(value: string): string | null {
  if (!value.startsWith('game/')) return null;
  try {
    return validateRelativePath(value);
  } catch {
    return null;
  }
}

function toIssue(reference: UnresolvedReference): Issue {
  const hasLocalTarget = reference.reason === 'missing'
    || reference.reason === 'dynamic'
    || reference.reason === 'check-failed';
  return {
    category: reference.reason === 'missing' ? 'missing' : 'unverified',
    reason: reference.reason,
    kind: reference.kind,
    line: reference.startLine,
    endLine: reference.endLine,
    target: hasLocalTarget ? safeTarget(reference.value) : null,
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export async function scanProject(
  project: ProjectConfig,
  input: ProjectScanInput,
  exists: (relative: string) => Promise<boolean>,
) {
  const start = performance.now();
  const limit = input.limit ?? PROJECT_SCAN_LIMITS.scenes;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROJECT_SCAN_LIMITS.scenes) {
    throw new AppError('INVALID_ARGUMENT', 'Invalid project scan scene limit.');
  }
  const scenes: SceneResult[] = [];
  let totalScenes: number | null = null;
  let scenesBeforeStart = 0;
  let firstRemainingPath: string | null = null;
  let inventoryError: string | null = null;
  let stopReason: StopReason | null = null;
  let detailBytes = 2; // JSON array brackets

  function checkpoint() {
    if (performance.now() - start >= PROJECT_SCAN_LIMITS.timeMs) {
      throw new AppError('SCAN_TIME_LIMIT', 'The project scan time budget elapsed.');
    }
  }

  function report() {
    const checkedScenes = scenes.filter(scene => scene.status === 'checked').length;
    const remainingScenes = totalScenes === null ? null : totalScenes - scenesBeforeStart - scenes.length;
    return {
      projectId: project.id,
      complete: remainingScenes === 0 && scenesBeforeStart === 0 && checkedScenes === totalScenes,
      elapsedMs: Math.round(performance.now() - start),
      limits: { ...PROJECT_SCAN_LIMITS, scenes: limit },
      scope: {
        totalScenes, scenesBeforeStart, checkedScenes,
        incompleteScenes: scenes.length - checkedScenes,
        remainingScenes, firstRemainingPath,
        nextStartAfter: firstRemainingPath === null ? null : scenes.at(-1)?.path ?? null,
      },
      stopReason,
      inventoryError,
      scenes,
    };
  }

  let files: FileEntry[];
  try {
    files = await listFiles(project.root, SCENE_DIRECTORY, ['.txt'], { checkpoint, statOnly: true });
    checkpoint();
  } catch (error) {
    inventoryError = publicError(error).code;
    stopReason = inventoryError === 'SCAN_TIME_LIMIT' ? 'time_limit' : 'inventory_error';
    return report();
  }
  totalScenes = files.length;
  if (input.startAfter !== undefined) {
    const after = input.startAfter;
    const next = files.findIndex(file => sceneRelative(file.path) > after);
    scenesBeforeStart = next === -1 ? files.length : next;
  }

  for (const file of files.slice(scenesBeforeStart, scenesBeforeStart + limit)) {
    const scene: SceneResult = { path: sceneRelative(file.path), status: 'incomplete', reason: null, issues: [] };
    // Reserve the row with its longest reason so a truncated row can always be returned.
    const rowBytes = jsonBytes({ ...scene, reason: 'SCENE_ANALYSIS_TRUNCATED' }) + 1;
    if (detailBytes + rowBytes > PROJECT_SCAN_LIMITS.detailBytes) {
      stopReason = 'report_limit';
      break;
    }

    let references: UnresolvedReference[] = [];
    try {
      checkpoint();
      if (file.size > PROJECT_SCAN_LIMITS.sceneBytes) {
        throw new AppError('FILE_TOO_LARGE', 'The scene exceeds the project scan size limit.');
      }
      const document = await readText(project.root, file.path);
      if (document.bytes > PROJECT_SCAN_LIMITS.sceneBytes) {
        throw new AppError('FILE_TOO_LARGE', 'The scene exceeds the project scan size limit.');
      }
      const analysis = await analyzeScene(document.text, scene.path, exists, {
        checkpoint,
        onResponseTruncated: () => { scene.reason = 'SCENE_ANALYSIS_TRUNCATED'; },
      });
      checkpoint();
      references = analysis.unresolvedReferences;
    } catch (error) {
      const { code } = publicError(error);
      if (code === 'SCAN_TIME_LIMIT') {
        stopReason = 'time_limit';
        break;
      }
      scene.reason = code;
    }

    scenes.push(scene);
    detailBytes += rowBytes;
    for (const reference of references) {
      if (reference.reason === 'none') continue;
      const issue = toIssue(reference);
      const issueBytes = jsonBytes(issue) + 1;
      if (detailBytes + issueBytes > PROJECT_SCAN_LIMITS.detailBytes) {
        scene.reason = 'REPORT_LIMIT';
        stopReason = 'report_limit';
        break;
      }
      scene.issues.push(issue);
      detailBytes += issueBytes;
      if (reference.reason === 'check-failed') scene.reason ??= 'REFERENCE_CHECK_FAILED';
    }
    if (scene.reason === null) scene.status = 'checked';
    if (stopReason !== null) break;
  }

  const firstRemaining = files[scenesBeforeStart + scenes.length];
  if (firstRemaining) {
    firstRemainingPath = sceneRelative(firstRemaining.path);
    stopReason ??= 'scene_limit';
  }
  return report();
}
