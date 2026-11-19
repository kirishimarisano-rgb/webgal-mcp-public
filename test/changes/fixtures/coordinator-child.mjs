import { readFile } from 'node:fs/promises';
import { WriteCoordinator } from '../../../dist/changes/coordinator.js';
import { ProjectLocks } from '../../../dist/changes/locks.js';

const inputPath = process.argv[2];

if (!inputPath) {
  process.stderr.write('usage: coordinator-child.mjs <input.json>\n');
  process.exit(2);
}

const input = JSON.parse(await readFile(inputPath, 'utf8'));
const config = {
  version: 1,
  projects: [input.project],
  sources: []
};

const coordinator = await WriteCoordinator.create(config, input.stateRoot, {
  locks: new ProjectLocks(input.lockRoot),
  capabilityCheck: async () => true,
  fault: (point, index) => {
    if (point === 'after-write' && index === 0) {
      process.exit(77);
    }
  }
});

const session = coordinator.sessions.begin(
  input.ownerId,
  input.project.id,
  input.attestation,
  input.changes.map((change) => change.path)
);

try {
  const plan = await coordinator.plan(
    input.ownerId,
    session.id,
    input.project.id,
    input.changes.map((change) => ({
      path: change.path,
      expectedRevision: change.expectedRevision,
      bytes: Buffer.from(change.bytesBase64, 'base64')
    }))
  );
  const result = await coordinator.apply(
    input.ownerId,
    session.id,
    plan.id,
    input.idempotencyKey
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
