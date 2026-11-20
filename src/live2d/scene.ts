import type { AppConfig, ProjectConfig } from '../types.js';
import { inspectLive2dModel, modelFilePath, type ModelReport } from './model.js';

type Selector = string | number | boolean | undefined;
export interface Live2dSceneIssue {
  code: string;
  category: 'missing' | 'invalid' | 'unverified';
  line: number;
  endLine: number;
  modelPath: string | null;
  dependencyPath?: string;
  selector?: 'motion' | 'expression';
  name?: string;
}

export type Live2dSceneCheck = (cue: {
  rawPath: string;
  dynamicPath: boolean;
  line: number;
  endLine: number;
  motion: Selector;
  expression: Selector;
}) => Promise<Live2dSceneIssue[]>;

export function createLive2dSceneCheck(project: ProjectConfig, checkpoint?: () => void): Live2dSceneCheck {
  const config: AppConfig = { version: 1, projects: [project], sources: [] };
  const cache = new Map<string, Promise<ModelReport>>();
  const modelLimit = 32;
  return async cue => {
    const base = { line: cue.line, endLine: cue.endLine };
    if (cue.dynamicPath || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(cue.rawPath)) {
      return [{ ...base, modelPath: null, category: 'unverified', code: 'MODEL_REFERENCE_UNVERIFIED' }];
    }
    let modelPath: string;
    try { modelPath = modelFilePath(cue.rawPath); }
    catch { return [{ ...base, modelPath: null, category: 'invalid', code: 'MODEL_PATH_INVALID' }]; }
    const reference = { ...base, modelPath };
    let pending = cache.get(modelPath);
    if (!pending) {
      if (cache.size >= modelLimit) return [{ ...reference, category: 'unverified', code: 'MODEL_INSPECTION_LIMIT' }];
      pending = inspectLive2dModel(config, { kind: 'project', projectId: project.id, modelPath }, checkpoint);
      cache.set(modelPath, pending);
    }
    const model = await pending;
    const issues: Live2dSceneIssue[] = model.issues.map(issue => ({
      ...reference,
      code: issue.code,
      category: issue.code === 'MODEL_MISSING' || issue.code === 'DEPENDENCY_MISSING' ? 'missing' : issue.status,
      ...(issue.path ? { dependencyPath: issue.path } : {}),
    }));
    for (const selector of ['motion', 'expression'] as const) {
      const value = cue[selector];
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string' || /[{}]/.test(value) || model.status === 'unverified' || model.version !== 3
        || model.issues.some(issue => issue.code === 'MODEL_STRUCTURE_INVALID')) {
        issues.push({ ...reference, selector, category: 'unverified', code: 'LIVE2D_SELECTOR_UNVERIFIED' });
        continue;
      }
      const names = selector === 'motion' ? model.motions : model.expressions;
      if (!names.some(item => item.name === value)) {
        issues.push({
          ...reference, selector, category: 'invalid',
          code: selector === 'motion' ? 'UNKNOWN_MOTION_GROUP' : 'UNKNOWN_EXPRESSION',
          ...(/^[\p{L}\p{N}_. -]{1,100}$/u.test(value) ? { name: value } : {}),
        });
      }
    }
    return issues;
  };
}
