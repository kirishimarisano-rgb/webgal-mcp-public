import { readFile } from 'node:fs/promises';
import { BusinessWriteService } from '../../../dist/changes/business.js';
import { WriteCoordinator } from '../../../dist/changes/coordinator.js';
import { ProjectLocks } from '../../../dist/changes/locks.js';

const inputPath = process.argv[2];

if (!inputPath) {
  process.stderr.write('usage: large-assets-child.mjs <input.json>\n');
  process.exit(2);
}

const input = JSON.parse(await readFile(inputPath, 'utf8'));
const config = {
  version: 1,
  projects: [input.project],
  sources: input.sources
};

const coordinator = await WriteCoordinator.create(config, input.stateRoot, {
  locks: new ProjectLocks(input.lockRoot),
  capabilityCheck: async () => true,
  fault: (point, index) => {
    if (String(point) === input.faultPoint
      && (index === undefined || index === 0)) {
      process.exit(input.exitCode);
    }
  }
});

const service = new BusinessWriteService(
  config,
  coordinator,
  input.ownerId
);
const session = coordinator.sessions.begin(
  input.ownerId,
  input.project.id,
  input.attestation,
  [input.target]
);

try {
  const review = await service.plan(
    input.project.id,
    session.id,
    [{
      type: 'import_asset',
      kind: input.kind,
      path: input.target.replace(/^game\/(?:background|bgm)\//, ''),
      sourceId: input.sourceId,
      sourcePath: input.sourcePath,
      expectedSourceRevision: input.expectedSourceRevision
    }]
  );
  const result = await service.apply(
    session.id,
    review.planId,
    input.idempotencyKey
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
