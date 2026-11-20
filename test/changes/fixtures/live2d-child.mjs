import { readFile } from 'node:fs/promises';
import { WriteCoordinator } from '../../../dist/changes/coordinator.js';
import { ProjectLocks } from '../../../dist/changes/locks.js';
import { planLive2dImport } from '../../../dist/live2d/import.js';

const { config, state, lockRoot, input, fault, index } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const host = await WriteCoordinator.create(config, state, {
  locks: new ProjectLocks(lockRoot),
  capabilityCheck: async () => true,
  fault(point, step) {
    if (point === fault && step === index) process.exit(73);
  },
});
const owner = 'crashed-model-importer';
const persist = (id, files, bundle) => host.plan(owner, id, input.projectId, files, undefined, undefined, bundle);
const draft = await planLive2dImport(config, input, persist);
const session = host.sessions.begin(owner, input.projectId, {
  source: 'user-message',
  statement: 'I saved and closed the temporary editor.',
}, draft.paths);
const plan = await planLive2dImport(config, { ...input, sessionId: session.id, expectedBundleRevision: draft.bundleRevision }, persist);
await new Promise(resolve => process.stdout.write(plan.planId + '\n', resolve));
await host.apply(owner, session.id, plan.planId, 'crash');
