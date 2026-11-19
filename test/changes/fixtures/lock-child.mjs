import { ProjectLocks } from '../../../dist/changes/locks.js';

const [mode, root, lockRoot, startAtText, holdMsText] = process.argv.slice(2);

if (!mode || !root || !lockRoot) {
  process.stderr.write('usage: lock-child.mjs <hold|contend> <root> <lockRoot> [startAt] [holdMs]\n');
  process.exit(2);
}

const locks = new ProjectLocks(lockRoot);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(timestamp) {
  const remaining = timestamp - Date.now();
  if (remaining > 0) {
    await sleep(remaining);
  }
}

async function holdForever() {
  await new Promise(() => {
    setInterval(() => undefined, 1000);
  });
}

if (mode === 'hold') {
  await locks.withLock(root, async () => {
    process.stdout.write(`acquired:${process.pid}\n`);
    await holdForever();
  });
} else if (mode === 'contend') {
  const startAt = Number(startAtText);
  const holdMs = Number(holdMsText);
  await waitUntil(startAt);
  try {
    await locks.withLock(root, async () => {
      process.stdout.write(`acquired:${process.pid}\n`);
      await sleep(holdMs);
    });
  } catch (error) {
    process.stdout.write(`locked:${error?.code ?? 'UNKNOWN'}\n`);
  }
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}
