import { publishTarget } from '../../../dist/changes/targets.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Dedicated temporary target and tiny original test content only.
const [root, content] = process.argv.slice(2);
const input = createInterface({ input: process.stdin });
input.once('line', async () => {
  input.close();
  try {
    await publishTarget(root, 'game/scene/race.txt', null, Buffer.from(content), randomUUID(), 0);
    process.stdout.write(JSON.stringify({ status: 'created', content }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'refused', code: error.code }) + '\n');
  }
});
process.stdout.write('ready\n');
