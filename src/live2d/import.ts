import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { describeAssetSource } from '../assets/source.js';
import { checkedModelDirectories } from '../changes/coordinator.js';
import { assertCreateTargetAbsent, checkedModelDirectory } from '../changes/targets.js';
import { LARGE_ASSET_LIMITS, WRITE_LIMITS, type ModelBundle, type StreamedAssetSource, type WritePlan } from '../changes/types.js';
import { getProject } from '../config.js';
import { AppError, publicError } from '../errors.js';
import type { AppConfig } from '../types.js';
import { additionalModelAssetPath, inspectLive2dModel, modelFilePath, modelRelativePath } from './model.js';

interface ImportRequest {
  projectId: string;
  sourceId: string;
  modelPath: string;
  targetDirectory: string;
  extraPaths?: string[];
  sessionId?: string;
  expectedBundleRevision?: string;
}

type BundleFile = { path: string; expectedRevision: null; source: StreamedAssetSource };
type Persist = (sessionId: string, files: BundleFile[], model: ModelBundle) => Promise<WritePlan>;

export async function planLive2dImport(config: AppConfig, input: ImportRequest, persist: Persist) {
  const project = getProject(config, input.projectId);
  const directory = checkedModelDirectory(`game/figure/${input.targetDirectory}`);
  const manifest = modelFilePath(input.modelPath);
  const filename = posix.basename(manifest);
  const modelTargetPath = modelRelativePath(`${directory}/${filename}`);
  const model = { directory, modelPath: modelTargetPath };
  if (input.sessionId !== undefined && input.expectedBundleRevision === undefined) {
    throw new AppError('INVALID_ARGUMENT', 'Review a draft and provide its bundleRevision before making a committable plan.');
  }
  const report = await inspectLive2dModel(config, { kind: 'source', sourceId: input.sourceId, modelPath: manifest });
  const blockingIssues: { code: string; path?: string }[] = report.issues.map(({ code, path }) => ({ code, ...(path ? { path } : {}) }));
  const extras = [];
  for (const path of input.extraPaths ?? []) {
    try { extras.push(additionalModelAssetPath(path)); }
    catch (error) { blockingIssues.push({ code: publicError(error).code }); }
  }
  const paths = [...new Set([...report.dependencies.map(dep => dep.path), ...extras])].sort();
  paths.push(filename); // Publish the entry only after the other files have been verified on disk.
  if (paths.length > WRITE_LIMITS.maxFiles) blockingIssues.push({ code: 'LIMIT_EXCEEDED' });
  const files: BundleFile[] = [];
  let totalBytes = 0;
  let bundleRevision: string | null = null;
  if (!blockingIssues.length) {
    for (const relative of paths) {
      let path: string | undefined;
      try {
        path = modelRelativePath(`${directory}/${relative}`);
        const sourcePath = modelRelativePath(posix.join(posix.dirname(manifest), relative));
        const source = await describeAssetSource(config, input.sourceId, sourcePath);
        totalBytes += source.bytes;
        if (totalBytes > LARGE_ASSET_LIMITS.maxBatchBytes) {
          blockingIssues.push({ code: 'LIMIT_EXCEEDED', path });
          break;
        }
        files.push({ path, expectedRevision: null, source: { sourceId: input.sourceId, path: sourcePath, ...source } });
      } catch (error) {
        blockingIssues.push({ code: publicError(error).code, ...(path ? { path } : {}) });
      }
    }
    if (!blockingIssues.length) {
      try {
        if (files.at(-1)?.source.revision !== report.revision) {
          throw new AppError('SOURCE_CHANGED', 'The model entry changed while preparing this draft.');
        }
        checkedModelDirectories(model, files);
        bundleRevision = createHash('sha256').update(JSON.stringify([input.projectId, model, files])).digest('hex');
      } catch (error) { blockingIssues.push({ code: publicError(error).code }); }
    }
  }
  if (input.sessionId !== undefined && bundleRevision !== input.expectedBundleRevision) {
    throw new AppError('SOURCE_CHANGED', 'The reviewed model package no longer matches. Generate and review a new draft.');
  }
  try { await assertCreateTargetAbsent(project.root, directory); }
  catch (error) { blockingIssues.push({ code: publicError(error).code, path: directory }); }
  const plan = input.sessionId !== undefined && !blockingIssues.length
    ? await persist(input.sessionId, files, model)
    : null;
  return {
    projectId: input.projectId,
    modelTargetPath,
    paths: files.map(file => file.path),
    files: files.map(({ path, source }) => ({ path, bytes: source.bytes, revision: source.revision })),
    totalBytes,
    blockingIssues,
    bundleRevision: blockingIssues.length ? null : bundleRevision,
    committable: plan !== null,
    planId: plan?.id ?? null,
    ...(plan ? { expiresAt: plan.expiresAt } : {}),
  };
}
