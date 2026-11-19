import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { getProject } from '../config.js';
import { inspectTerre } from '../terre.js';
import type { AppConfig, ProjectConfig } from '../types.js';
import { SessionManager } from './sessions.js';
import { canonicalProjectKey, ProjectLocks } from './locks.js';
import { StateStore } from './store.js';
import { readSource } from '../assets/source.js';
import { validateRelativePath } from '../filesystem.js';
import { assertReferenceableTarget, assertWritePath, snapshotTarget, publishTarget, inspectStaging } from './targets.js';
import { WRITE_LIMITS, type ChangeInput, type PlannedChange, type WritePlan, type BatchRecord, type ApplyResult, type FaultHook, type SourceRevision } from './types.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const operationSchema = z.object({ path: z.string().min(1).max(1024), expectedRevision: revision.nullable(), newRevision: revision, data: z.string().max(2 * WRITE_LIMITS.maxFileBytes) }).strict();
const sourceSchema = z.object({ sourceId: z.string().min(1).max(64), path: z.string().min(1).max(1024), revision, rootKey: revision }).strict();
const planSchema = z.object({ version: z.literal(1), id: uuid, projectId: z.string(), projectKey: revision, ownerId: z.string(), sessionId: uuid, createdAt: z.number().finite(), expiresAt: z.number().finite(), operations: z.array(operationSchema).min(1).max(WRITE_LIMITS.maxFiles), digest: revision, restoresBatchId: uuid.optional(), sources: z.array(sourceSchema).min(1).max(WRITE_LIMITS.maxFiles).optional() }).strict();
const recordSchema = z.object({ path: z.string(), expectedRevision: revision.nullable(), newRevision: revision, backup: z.string().optional(), phase: z.enum(['pending', 'intent', 'applied']) }).strict();
const batchSchema = z.object({ version: z.literal(1), id: uuid, projectId: z.string(), projectKey: revision, ownerId: z.string(), planId: uuid, planDigest: revision, keyHash: revision, status: z.enum(['preparing', 'applying', 'complete', 'failed', 'partial', 'uncertain']), operations: z.array(recordSchema).min(1).max(WRITE_LIMITS.maxFiles), errorCode: z.string().optional(), createdAt: z.number().finite(), restoresBatchId: uuid.optional() }).strict();
const keySchema = z.object({ version: z.literal(1), projectKey: revision, planId: uuid, digest: revision, batchId: uuid }).strict();
function corrupt(): never { throw new AppError('STATE_CORRUPT', 'Stored write state could not be validated. No recovery was applied.'); }
function digest(plan: Omit<WritePlan, 'digest'>) {
  const payload: unknown[] = [plan.version, plan.id, plan.projectId, plan.projectKey, plan.ownerId, plan.sessionId, plan.createdAt, plan.expiresAt, plan.operations.map(op => [op.path, op.expectedRevision, op.newRevision, op.data]), plan.restoresBatchId ?? null];
  if (plan.sources) payload.push(plan.sources.map(source => [source.sourceId, source.path, source.revision, source.rootKey]));
  return hash(JSON.stringify(payload));
}
function checkedId(id: string) { if (!uuid.safeParse(id).success) throw new AppError('INVALID_ARGUMENT', 'Invalid write record identifier.'); return id; }
function identity(path: string) { return process.platform === 'win32' ? path.toLowerCase() : path; }
function checkedOperations(operations: PlannedChange[]) {
  let total = 0;
  const paths = new Set<string>();
  for (const op of operations) {
    assertWritePath(op.path, op.expectedRevision === null);
    if (paths.has(identity(op.path))) throw new AppError('INVALID_ARGUMENT', 'A batch cannot contain duplicate target paths.');
    paths.add(identity(op.path));
    const data = Buffer.from(op.data, 'base64');
    total += data.byteLength;
    if (data.toString('base64') !== op.data || data.byteLength > WRITE_LIMITS.maxFileBytes || total > WRITE_LIMITS.maxBatchBytes || hash(data) !== op.newRevision) corrupt();
  }
}
function summarize(record: BatchRecord, replayed = false): ApplyResult {
  return { batchId: record.id, status: record.status, operations: structuredClone(record.operations), ...(record.errorCode ? { errorCode: record.errorCode } : {}), replayed };
}
export interface CoordinatorOptions {
  sessions?: SessionManager;
  locks?: ProjectLocks;
  now?: () => number;
  capabilityCheck?: (project: ProjectConfig) => Promise<boolean>;
  fault?: FaultHook;
}

/** Internal host API only. No P2 mutation is registered as an MCP tool. */
export class WriteCoordinator {
  readonly sessions: SessionManager;
  readonly locks: ProjectLocks;
  readonly store: StateStore;
  private readonly now: () => number;
  private readonly capabilityCheck: (project: ProjectConfig) => Promise<boolean>;
  private readonly fault: FaultHook;
  private constructor(private readonly config: AppConfig, store: StateStore, options: CoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.sessions = options.sessions ?? new SessionManager(this.now);
    this.locks = options.locks ?? new ProjectLocks();
    this.store = store;
    this.fault = options.fault ?? (() => {});
    this.capabilityCheck = options.capabilityCheck ?? (async project => {
      const state = await inspectTerre(project);
      return state.reachable && state.mappingVerified && state.capabilities.apiTest === 'available' && state.capabilities.openApi === 'available' && state.capabilities.readGameAssets === 'available';
    });
  }
  static async create(config: AppConfig, stateRoot: string, options: CoordinatorOptions = {}) {
    const ownedConfig = structuredClone(config);
    const locks = options.locks ?? new ProjectLocks();
    await locks.validateIsolation(ownedConfig);
    return new WriteCoordinator(ownedConfig, await StateStore.create(stateRoot, ownedConfig), { ...options, locks });
  }
  async plan(ownerId: string, sessionId: string, projectId: string, changes: ChangeInput[], restoresBatchId?: string, sources?: SourceRevision[]): Promise<WritePlan> {
    const project = getProject(this.config, projectId);
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > WRITE_LIMITS.maxFiles) throw new AppError('INVALID_ARGUMENT', 'Invalid batch size.');
    if (changes.reduce((total, change) => total + (change.bytes?.byteLength ?? 0), 0) > WRITE_LIMITS.maxBatchBytes) throw new AppError('LIMIT_EXCEEDED', 'The batch exceeds the configured byte limit.');
    const operations = changes.map(change => {
      if (!(change.bytes instanceof Uint8Array) || change.bytes.byteLength > WRITE_LIMITS.maxFileBytes || !revision.nullable().safeParse(change.expectedRevision).success) throw new AppError('INVALID_ARGUMENT', 'Invalid change payload or base revision.');
      const bytes = Buffer.from(change.bytes);
      return { path: assertWritePath(change.path, change.expectedRevision === null), expectedRevision: change.expectedRevision, newRevision: hash(bytes), data: bytes.toString('base64') };
    });
    checkedOperations(operations);
    if (!restoresBatchId) operations.forEach(op => assertReferenceableTarget(op.path));
    const session = this.sessions.require(sessionId, ownerId, projectId, operations.map(op => op.path));
    const projectKey = await canonicalProjectKey(project.root);
    await this.preflight(project, operations);
    const checkedSources = sources?.length ? z.array(sourceSchema).min(1).max(WRITE_LIMITS.maxFiles).parse(sources) : undefined;
    await this.validateSources(checkedSources);
    const unsigned: Omit<WritePlan, 'digest'> = { version: 1, id: randomUUID(), projectId, projectKey, ownerId, sessionId, createdAt: this.now(), expiresAt: session.expiresAt, operations, ...(restoresBatchId ? { restoresBatchId: checkedId(restoresBatchId) } : {}), ...(checkedSources ? { sources: checkedSources } : {}) };
    const plan: WritePlan = { ...unsigned, digest: digest(unsigned) };
    await this.store.createJson(`plans/${plan.id}.json`, plan);
    return structuredClone(plan);
  }
  private async readPlan(id: string): Promise<WritePlan> {
    const parsed = planSchema.safeParse(await this.store.readJson(`plans/${checkedId(id)}.json`));
    if (!parsed.success) corrupt();
    const plan = parsed.data;
    if (plan.id !== id || digest(plan) !== plan.digest) corrupt();
    checkedOperations(plan.operations);
    for (const source of plan.sources ?? []) validateRelativePath(source.path);
    return plan;
  }
  private async validateSources(sources?: SourceRevision[]) {
    for (const source of sources ?? []) {
      let current;
      try { current = await readSource(this.config, source.sourceId, source.path); }
      catch { throw new AppError('SOURCE_CHANGED', 'An asset source is unavailable or no longer authorized. Recreate the plan.'); }
      if (current.revision !== source.revision || current.rootKey !== source.rootKey) throw new AppError('SOURCE_CHANGED', 'An asset source changed after planning. Recreate the plan.');
    }
  }
  private async readBatch(id: string, projectId: string): Promise<BatchRecord> {
    const parsed = batchSchema.safeParse(await this.store.readJson(`batches/${checkedId(id)}/journal.json`));
    if (!parsed.success || parsed.data.id !== id || parsed.data.projectId !== projectId) corrupt();
    const record = parsed.data;
    const project = getProject(this.config, projectId);
    if (record.projectKey !== await canonicalProjectKey(project.root)) corrupt();
    const plan = await this.readPlan(record.planId);
    if (record.planDigest !== plan.digest || plan.projectId !== record.projectId || plan.projectKey !== record.projectKey || record.ownerId !== plan.ownerId || record.restoresBatchId !== plan.restoresBatchId || record.operations.length !== plan.operations.length) corrupt();
    record.operations.forEach((op, index) => {
      const expected = plan.operations[index];
      if (op.path !== expected.path || op.expectedRevision !== expected.expectedRevision || op.newRevision !== expected.newRevision || (op.backup !== undefined && op.backup !== `batches/${record.id}/backups/${index}.bin`)) corrupt();
      if (op.expectedRevision === null && op.backup !== undefined) corrupt();
      if (record.status === 'complete' && (op.phase !== 'applied' || (op.expectedRevision !== null && !op.backup))) corrupt();
    });
    return record;
  }
  private async preflight(project: ProjectConfig, operations: PlannedChange[]) {
    const snapshots = [];
    for (const op of operations) {
      const snapshot = await snapshotTarget(project.root, op.path);
      if (snapshot.revision !== op.expectedRevision) throw new AppError(op.expectedRevision === null ? 'TARGET_EXISTS' : 'REVISION_CONFLICT', 'A target no longer matches the reviewed base revision.');
      snapshots.push(snapshot);
    }
    return snapshots;
  }
  async apply(ownerId: string, sessionId: string, planId: string, idempotencyKey: string): Promise<ApplyResult> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) throw new AppError('INVALID_ARGUMENT', 'Invalid idempotency key.');
    const plan = await this.readPlan(planId);
    const project = getProject(this.config, plan.projectId);
    const paths = plan.operations.map(op => op.path);
    this.sessions.require(sessionId, ownerId, plan.projectId, paths);
    if (plan.ownerId !== ownerId) throw new AppError('SESSION_MISMATCH', 'The plan belongs to another client.');
    await this.locks.validateIsolation(this.config);
    const action = async (): Promise<ApplyResult> => {
      this.sessions.require(sessionId, ownerId, plan.projectId, paths);
      if (await canonicalProjectKey(project.root) !== plan.projectKey) throw new AppError('PROJECT_NOT_AUTHORIZED', 'The project identity changed.');
      const keyHash = hash(idempotencyKey);
      const keyPath = `keys/${plan.projectKey}/${keyHash}.json`;
      let stored: unknown;
      try { stored = await this.store.readJson(keyPath); }
      catch (error) { if (!(error instanceof AppError) || error.code !== 'STATE_NOT_FOUND') throw error; }
      if (stored !== undefined) {
        const key = keySchema.safeParse(stored);
        if (!key.success) corrupt();
        if (key.data.projectKey !== plan.projectKey || key.data.planId !== plan.id || key.data.digest !== plan.digest) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key belongs to a different write plan.');
        const previous = await this.readBatch(key.data.batchId, plan.projectId);
        if (previous.keyHash !== keyHash || previous.planId !== plan.id || previous.planDigest !== plan.digest) corrupt();
        const result = summarize(previous, true);
        if (previous.status === 'preparing' || previous.status === 'applying') return { ...result, status: 'uncertain', errorCode: 'RECOVERY_REQUIRED' };
        return result;
      }
      if (plan.sessionId !== sessionId || plan.expiresAt <= this.now()) throw new AppError('SESSION_EXPIRED', 'Create a fresh plan after a new handoff.');
      if (!plan.restoresBatchId) plan.operations.forEach(op => assertReferenceableTarget(op.path));
      await this.fault('after-lock');
      if (await this.capabilityCheck(project) !== true) throw new AppError('UNSUPPORTED_CAPABILITY', 'Current Terre capabilities and project mapping could not be verified.');
      let snapshots;
      try { await this.validateSources(plan.sources); snapshots = await this.preflight(project, plan.operations); }
      catch (error) { this.sessions.pause(sessionId); throw error; }
      await this.fault('after-preflight');
      const record: BatchRecord = { version: 1, id: randomUUID(), projectId: plan.projectId, projectKey: plan.projectKey, ownerId, planId, planDigest: plan.digest, keyHash, status: 'preparing', operations: plan.operations.map(op => ({ path: op.path, expectedRevision: op.expectedRevision, newRevision: op.newRevision, phase: 'pending' })), createdAt: this.now(), ...(plan.restoresBatchId ? { restoresBatchId: plan.restoresBatchId } : {}) };
      const journalPath = `batches/${record.id}/journal.json`;
      await this.store.createJson(journalPath, record);
      let backingUp = false;
      try {
        await this.store.createJson(keyPath, { version: 1, projectKey: plan.projectKey, planId, digest: plan.digest, batchId: record.id });
        backingUp = true;
        for (let index = 0; index < snapshots.length; index++) {
          const bytes = snapshots[index].bytes;
          if (bytes !== null) {
            await this.fault('before-backup', index);
            record.operations[index].backup = await this.store.writeBackup(record.id, index, bytes);
            await this.store.replaceJson(journalPath, record);
          }
        }
        backingUp = false;
        await this.fault('after-backups');
        await this.validateSources(plan.sources);
        await this.preflight(project, plan.operations);
        record.status = 'applying';
        await this.store.replaceJson(journalPath, record);
        for (let index = 0; index < plan.operations.length; index++) {
          this.sessions.require(sessionId, ownerId, plan.projectId, paths);
          const op = plan.operations[index];
          const current = await snapshotTarget(project.root, op.path);
          if (current.revision !== op.expectedRevision) throw new AppError('REVISION_CONFLICT', 'A target changed during the batch. Inspect the recorded outcome.');
          record.operations[index].phase = 'intent';
          await this.store.replaceJson(journalPath, record);
          await this.fault('before-write', index);
          this.sessions.require(sessionId, ownerId, plan.projectId, paths);
          await publishTarget(project.root, op.path, op.expectedRevision, Buffer.from(op.data, 'base64'), record.id, index, () => { this.sessions.require(sessionId, ownerId, plan.projectId, paths); });
          await this.fault('after-write', index);
          record.operations[index].phase = 'applied';
          await this.store.replaceJson(journalPath, record);
          await this.fault('after-record', index);
        }
        await this.fault('before-complete');
        record.status = 'complete';
        await this.store.replaceJson(journalPath, record);
        return summarize(record);
      } catch (error) {
        this.sessions.pause(sessionId);
        record.status = record.operations.some(op => op.phase === 'intent') ? 'uncertain' : record.operations.some(op => op.phase === 'applied') ? 'partial' : 'failed';
        record.errorCode = backingUp ? 'BACKUP_FAILED' : error instanceof AppError ? error.code : 'WRITE_FAILED';
        try { await this.store.replaceJson(journalPath, record); }
        catch { record.status = 'uncertain'; record.errorCode = 'OUTCOME_UNKNOWN'; }
        return summarize(record);
      }
    };
    let observed: ApplyResult | undefined;
    try {
      return await this.locks.withLock(project.root, async () => { observed = await action(); return observed; });
    } catch (error) {
      if (observed && error instanceof AppError && error.code === 'LOCK_RELEASE_FAILED') {
        this.sessions.pause(sessionId);
        return { ...observed, warnings: ['LOCK_RELEASE_FAILED'] };
      }
      throw error;
    }
  }
  async inspect(projectId: string, batchId: string) {
    const record = await this.readBatch(batchId, projectId);
    const project = getProject(this.config, projectId);
    const operations = [];
    for (let index = 0; index < record.operations.length; index++) {
      const op = record.operations[index];
      let currentRevision: string | null | undefined;
      try { currentRevision = (await snapshotTarget(project.root, op.path)).revision; } catch { currentRevision = undefined; }
      let backupVerified = false;
      if (op.backup) {
        try { backupVerified = hash(await this.store.readBackup(op.backup)) === op.expectedRevision; } catch { /* incomplete/corrupt backup remains unavailable */ }
      }
      const diskState = currentRevision === undefined ? 'unreadable' : currentRevision === null ? 'missing' : currentRevision === op.newRevision ? 'planned' : currentRevision === op.expectedRevision ? 'original' : 'changed';
      let stagingPresent: boolean | null = null;
      try { stagingPresent = await inspectStaging(project.root, op.path, record.id, index); } catch { /* unknown is not absence */ }
      operations.push({ path: op.path, phase: op.phase, currentRevision: currentRevision ?? null, diskState, backupVerified, stagingPresent, canRestore: op.expectedRevision !== null && diskState === 'planned' && backupVerified, ...(op.expectedRevision === null ? { limitation: 'Created files are never automatically deleted.' } : {}) });
    }
    return { batchId: record.id, status: record.status, errorCode: record.errorCode ?? null, snapshotOnly: true, operations };
  }
  async pending(projectId: string, options: { planId?: string; includeCompleted?: boolean } = {}) {
    if (options.planId) checkedId(options.planId);
    const key = await canonicalProjectKey(getProject(this.config, projectId).root);
    const batches = [];
    let unreadableRecords = 0;
    for (const id of await this.store.listBatchIds()) {
      try {
        const raw = batchSchema.parse(await this.store.readJson(`batches/${checkedId(id)}/journal.json`));
        if (raw.projectId === projectId && raw.projectKey === key && (!options.planId || raw.planId === options.planId) && (options.includeCompleted || options.planId || raw.status !== 'complete')) batches.push(await this.inspect(projectId, id));
      } catch { unreadableRecords++; }
    }
    return { batches, unreadableRecords };
  }
  async restore(ownerId: string, sessionId: string, projectId: string, batchId: string, selected: { path: string; expectedRevision: string }[], idempotencyKey: string) {
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > WRITE_LIMITS.maxFiles) throw new AppError('INVALID_ARGUMENT', 'Select the files to restore.');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) throw new AppError('INVALID_ARGUMENT', 'Invalid idempotency key.');
    const project = getProject(this.config, projectId);
    const projectKey = await canonicalProjectKey(project.root);
    let stored: unknown;
    try { stored = await this.store.readJson(`keys/${projectKey}/${hash(idempotencyKey)}.json`); }
    catch (error) { if (!(error instanceof AppError) || error.code !== 'STATE_NOT_FOUND') throw error; }
    if (stored !== undefined) {
      const key = keySchema.safeParse(stored);
      if (!key.success) corrupt();
      const previous = await this.readPlan(key.data.planId);
      if (key.data.projectKey !== projectKey || key.data.digest !== previous.digest || previous.projectId !== projectId || previous.restoresBatchId !== batchId || previous.operations.length !== selected.length || previous.operations.some((op, i) => op.path !== selected[i]?.path || op.expectedRevision !== selected[i]?.expectedRevision)) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key belongs to a different recovery plan.');
      return this.apply(ownerId, sessionId, previous.id, idempotencyKey);
    }
    const report = await this.inspect(projectId, batchId);
    const record = await this.readBatch(batchId, projectId);
    const changes: ChangeInput[] = [];
    for (const selection of selected) {
      const observed = report.operations.find(op => op.path === selection.path);
      const original = record.operations.find(op => op.path === selection.path);
      if (!observed?.canRestore || observed.currentRevision !== selection.expectedRevision || !original?.backup) throw new AppError('RECOVERY_CONFLICT', 'A selected file no longer matches this batch. Nothing was restored.');
      const bytes = await this.store.readBackup(original.backup);
      if (hash(bytes) !== original.expectedRevision) throw new AppError('RECOVERY_CONFLICT', 'The selected backup no longer matches its original version.');
      changes.push({ path: selection.path, expectedRevision: selection.expectedRevision, bytes });
    }
    const plan = await this.plan(ownerId, sessionId, projectId, changes, batchId);
    return this.apply(ownerId, sessionId, plan.id, idempotencyKey);
  }
}
