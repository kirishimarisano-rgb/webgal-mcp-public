import { posix } from 'node:path';
import { probeAssetSource, readSource } from '../assets/source.js';
import { getProject } from '../config.js';
import { AppError, publicError } from '../errors.js';
import { probeRegularFile, readText, validateRelativePath } from '../filesystem.js';
import type { AppConfig } from '../types.js';

export type ModelLocation =
  | { kind: 'project'; projectId: string; modelPath: string }
  | { kind: 'source'; sourceId: string; modelPath: string };

type DependencyKind = 'moc' | 'texture' | 'motion' | 'expression' | 'sound' | 'physics' | 'pose' | 'displayInfo' | 'userData';
const extensions: Record<DependencyKind, readonly string[]> = {
  moc: ['.moc3'],
  texture: ['.png', '.jpg', '.jpeg', '.webp'],
  motion: ['.motion3.json'],
  expression: ['.exp3.json'],
  sound: ['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.webm', '.opus'],
  physics: ['.physics3.json'],
  pose: ['.pose3.json'],
  displayInfo: ['.cdi3.json'],
  userData: ['.userdata3.json'],
};
const singletonFields = {
  Moc: 'moc', Physics: 'physics', Pose: 'pose', DisplayInfo: 'displayInfo', UserData: 'userData',
} as const;
const knownFields = new Set([...Object.keys(singletonFields), 'Textures', 'Motions', 'Expressions']);
const maxEntries = 128;
const maxPathLength = 1024;
const invalidPathCodes = new Set(['PATH_INVALID', 'PATH_OUTSIDE_PROJECT', 'FILE_NOT_REGULAR', 'FILE_NOT_DIRECTORY']);
type Status = 'valid' | 'invalid' | 'unverified';
type Dependency = { kind: DependencyKind; path: string; status: 'present' | 'missing' | 'unverified' | 'invalid' };
type Issue = { code: string; status: Exclude<Status, 'valid'>; field: string; path?: string };

export interface ModelReport {
  status: Status;
  modelPath: string;
  version: number | null;
  revision: string | null;
  dependencies: Dependency[];
  motions: { name: string; files: string[] }[];
  expressions: { name: string; file: string }[];
  issues: Issue[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExtension(path: string, suffixes: readonly string[]) {
  return suffixes.some(suffix => path.toLowerCase().endsWith(suffix));
}

export function modelRelativePath(path: string) {
  if (!path || path.length > maxPathLength || !validateRelativePath(path) || path.split('/').some(segment => segment.startsWith('.'))) {
    throw new AppError('PATH_INVALID', 'The Live2D file path is invalid.');
  }
  return path;
}

export function modelFilePath(path: string) {
  if (!modelRelativePath(path).toLowerCase().endsWith('.model3.json')) {
    throw new AppError('INVALID_ARGUMENT', 'Choose a .model3.json model entry.');
  }
  return path;
}

export function additionalModelAssetPath(path: string) {
  const valid = modelRelativePath(path);
  if (!Object.values(extensions).some(suffixes => hasExtension(valid, suffixes))) {
    throw new AppError('INVALID_ARGUMENT', 'Additional files must be supported model, image, or audio assets.');
  }
  return valid;
}

export async function inspectLive2dModel(config: AppConfig, location: ModelLocation, checkpoint?: () => void): Promise<ModelReport> {
  const modelPath = modelFilePath(location.modelPath);
  const report: ModelReport = { status: 'valid', modelPath, version: null, revision: null, dependencies: [], motions: [], expressions: [], issues: [] };
  const addIssue = (code: string, status: Issue['status'], field: string, path?: string) => {
    if (report.issues.length < maxEntries) report.issues.push({ code, status, field, ...(path === undefined ? {} : { path }) });
    if (status === 'invalid' || report.status === 'valid') report.status = status;
  };
  const root = location.kind === 'project' ? getProject(config, location.projectId).root : undefined;
  const fromModel = (file: string) => modelRelativePath(posix.join(posix.dirname(modelPath), file));
  let text: string;
  checkpoint?.();
  try {
    if (location.kind === 'project') {
      const document = await readText(root!, `game/figure/${modelPath}`);
      text = document.text;
      report.revision = document.revision;
    } else {
      const source = await readSource(config, location.sourceId, modelPath);
      report.revision = source.revision;
      text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
    }
  } catch (error) {
    const code = error instanceof TypeError ? 'UNSUPPORTED_FORMAT' : publicError(error).code;
    if (code === 'SOURCE_NOT_AUTHORIZED') throw error;
    addIssue(code === 'FILE_NOT_FOUND' ? 'MODEL_MISSING' : code,
      code === 'FILE_NOT_FOUND' || code === 'UNSUPPORTED_FORMAT' || invalidPathCodes.has(code) ? 'invalid' : 'unverified', 'model');
    return report;
  }
  checkpoint?.();
  let document: unknown;
  try { document = JSON.parse(text); }
  catch { addIssue('MODEL_JSON_INVALID', 'invalid', 'model'); return report; }
  if (!object(document)) {
    addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'model');
    return report;
  }
  report.version = typeof document.Version === 'number' && Number.isInteger(document.Version) ? document.Version : null;
  if (report.version !== 3) {
    addIssue(report.version === null ? 'MODEL_STRUCTURE_INVALID' : 'MODEL_VERSION_UNVERIFIED',
      report.version === null ? 'invalid' : 'unverified', 'Version');
    return report;
  }
  const refs = document.FileReferences;
  if (!object(refs)) {
    addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'FileReferences');
    return report;
  }
  if (Object.keys(refs).some(key => !knownFields.has(key))) addIssue('UNKNOWN_DEPENDENCY_FIELD', 'unverified', 'FileReferences');
  const entries = new Map<string, Dependency>();
  const addDependency = (value: unknown, kind: DependencyKind, field: string): string | undefined => {
    if (typeof value !== 'string' || !value) {
      addIssue('MODEL_STRUCTURE_INVALID', 'invalid', field);
      return;
    }
    let path: string;
    try {
      path = modelRelativePath(value);
      fromModel(path);
    } catch {
      addIssue('DEPENDENCY_PATH_INVALID', 'invalid', field);
      return;
    }
    if (!hasExtension(path, extensions[kind])) {
      addIssue('DEPENDENCY_TYPE_UNVERIFIED', 'unverified', field, path);
      return;
    }
    if (!entries.has(path)) {
      if (entries.size >= maxEntries) {
        addIssue('MODEL_INSPECTION_LIMIT', 'unverified', 'FileReferences');
        return;
      }
      entries.set(path, { kind, path, status: 'unverified' });
    }
    return path;
  };
  const array = (value: unknown, field: string): unknown[] => {
    if (!Array.isArray(value)) {
      addIssue('MODEL_STRUCTURE_INVALID', 'invalid', field);
      return [];
    }
    if (value.length > maxEntries) addIssue('MODEL_INSPECTION_LIMIT', 'unverified', field);
    return value.slice(0, maxEntries);
  };
  const validName = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  for (const [field, kind] of Object.entries(singletonFields)) {
    if (field === 'Moc' || Object.hasOwn(refs, field)) addDependency(refs[field], kind, field);
  }
  const textures = array(refs.Textures, 'Textures');
  if (!textures.length) addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Textures');
  for (const texture of textures) addDependency(texture, 'texture', 'Textures');
  const expressionNames = new Set<string>();
  for (const expression of Object.hasOwn(refs, 'Expressions') ? array(refs.Expressions, 'Expressions') : []) {
    if (!object(expression) || !validName(expression.Name) || expressionNames.has(expression.Name)) {
      addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Expressions');
      continue;
    }
    expressionNames.add(expression.Name);
    const file = addDependency(expression.File, 'expression', 'Expressions.File');
    if (file !== undefined) report.expressions.push({ name: expression.Name, file });
  }
  if (Object.hasOwn(refs, 'Motions')) {
    if (!object(refs.Motions)) {
      addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Motions');
    } else {
      const groups = Object.entries(refs.Motions);
      if (groups.length > maxEntries) addIssue('MODEL_INSPECTION_LIMIT', 'unverified', 'Motions');
      let motionCount = 0;
      for (const [name, entries] of groups.slice(0, maxEntries)) {
        if (!validName(name)) {
          addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Motions');
          continue;
        }
        const files = [];
        for (const entry of array(entries, 'Motions')) {
          if (++motionCount > maxEntries) {
            addIssue('MODEL_INSPECTION_LIMIT', 'unverified', 'Motions');
            break;
          }
          if (!object(entry)) {
            addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Motions');
            continue;
          }
          const file = addDependency(entry.File, 'motion', 'Motions.File');
          if (file !== undefined) files.push(file);
          if (Object.hasOwn(entry, 'Sound')) addDependency(entry.Sound, 'sound', 'Motions.Sound');
        }
        if (files.length) report.motions.push({ name, files });
      }
    }
  }
  report.dependencies = [...entries.values()];
  for (const entry of report.dependencies) {
    checkpoint?.();
    const relative = fromModel(entry.path);
    try {
      if (location.kind === 'project') await probeRegularFile(root!, `game/figure/${relative}`);
      else await probeAssetSource(config, location.sourceId, relative);
      entry.status = 'present';
    } catch (error) {
      const code = publicError(error).code;
      entry.status = code === 'FILE_NOT_FOUND' ? 'missing' : invalidPathCodes.has(code) ? 'invalid' : 'unverified';
      addIssue(entry.status === 'missing' ? 'DEPENDENCY_MISSING' : code,
        entry.status === 'unverified' ? 'unverified' : 'invalid', entry.kind, entry.path);
    }
  }
  checkpoint?.();
  return report;
}
