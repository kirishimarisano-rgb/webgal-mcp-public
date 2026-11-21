import { createHash } from 'node:crypto';

const maxSceneBytes = 1024 * 1024;
const maxRequestBytes = 12 * maxSceneBytes;
const revisionFormat = /^[a-f0-9]{64}$/;
const fragmentFormat = /^F[0-9]{3,}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function requireCondition(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function requireText(value, name) {
  requireCondition(
    typeof value === 'string' && value.isWellFormed() && !value.includes('\0'),
    'INVALID_TEXT',
    name + ' must be valid Unicode text without NUL.',
  );
}

function storyIds(storyText) {
  requireText(storyText, 'storyText');
  const scenes = new Map();
  const fragments = new Map();
  let sceneId;
  let waitingForScene = false;
  let needsContent = false;

  for (const rawLine of storyText.replace(/^\uFEFF/, '').split(/\r\n|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^##\s+[^#]/u.test(line)) {
      requireCondition(!waitingForScene && !needsContent, 'INVALID_ID', 'A scene or fragment is incomplete.');
      waitingForScene = true;
      continue;
    }
    const scene = /^<!--\s*scene:\s*(S[0-9]{3,})\s*-->$/u.exec(line);
    if (waitingForScene) {
      requireCondition(scene && !scenes.has(scene[1]), 'INVALID_ID', 'A scene heading needs a unique scene ID.');
      sceneId = scene[1];
      scenes.set(sceneId, []);
      waitingForScene = false;
      continue;
    }
    const fragment = /^<!--\s*fragment:\s*(F[0-9]{3,})\s*-->$/u.exec(line);
    if (fragment) {
      const id = fragment[1];
      requireCondition(sceneId && !needsContent && !fragments.has(id), 'INVALID_ID', 'A fragment needs a scene, content and a unique ID.');
      scenes.get(sceneId).push(id);
      fragments.set(id, sceneId);
      needsContent = true;
      continue;
    }
    requireCondition(!/^<!--\s*(?:scene|fragment)\b/u.test(line), 'INVALID_ID', 'An ID marker is malformed or out of place.');
    if (sceneId) {
      requireCondition(scenes.get(sceneId).length > 0, 'INVALID_ID', 'Scene content must start with a fragment ID.');
      if (!/^<!--/u.test(line)) needsContent = false;
    }
  }
  requireCondition(
    !waitingForScene && !needsContent && scenes.size > 0 && [...scenes.values()].every(ids => ids.length > 0),
    'INVALID_ID',
    'The story needs at least one scene and content for all fragments.',
  );
  return { scenes, fragments };
}

function encodeScene(text, encoding) {
  const prefix = encoding === 'utf-8-bom' ? '\uFEFF' : '';
  return Buffer.from(prefix + text, 'utf8');
}

function isSafeBoundary(text, offset) {
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  const splitsCharacter = left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
  return !splitsCharacter && !(left === 13 && right === 10);
}

function locateEdit(text, change, sceneId, fragments) {
  const { fragmentId, before, after, left = '', right = '', removed = false } = change ?? {};
  const validId = typeof fragmentId === 'string' && fragmentFormat.test(fragmentId);
  requireCondition(
    validId && (
      removed === true
        ? !fragments.has(fragmentId) && after === ''
        : removed === false && fragments.get(fragmentId) === sceneId
    ),
    'INVALID_ID',
    'The fragment is missing, belongs to another scene, or is not an explicitly removed ID.',
  );
  for (const [name, value] of Object.entries({ before, after, left, right })) requireText(value, name);
  requireCondition(before !== after, 'EMPTY_EDIT', 'The replacement must change the target.');

  const anchor = left + before + right;
  requireCondition(anchor.length > 0, 'AMBIGUOUS_TARGET', 'An insertion needs surrounding saved context.');
  const position = text.indexOf(anchor);
  requireCondition(position !== -1, 'TARGET_CHANGED', 'The exact original and its context are absent for ' + fragmentId + '.');
  requireCondition(text.indexOf(anchor, position + 1) === -1, 'AMBIGUOUS_TARGET', 'The saved context matches more than once for ' + fragmentId + '.');

  const start = position + left.length;
  const end = start + before.length;
  requireCondition(
    isSafeBoundary(text, start) && isSafeBoundary(text, end),
    'INVALID_RANGE',
    'A patch cannot split a Unicode character or a CRLF sequence.',
  );
  return { start, end, text: after };
}

function patch(input, { scenes, fragments }) {
  const { scene, sceneId, changes } = input;
  requireCondition(scenes.has(sceneId), 'INVALID_ID', 'The scene ID is absent from the reviewed story.');
  requireCondition(
    scene?.source === 'disk' && typeof scene.path === 'string' &&
      /^(?:[^\\/:]+\/)*[^\\/:]+\.txt$/u.test(scene.path) &&
      !scene.path.split('/').some(part => part === '.' || part === '..') &&
      typeof scene.revision === 'string' && revisionFormat.test(scene.revision) &&
      ['utf-8', 'utf-8-bom'].includes(scene.encoding),
    'INVALID_SNAPSHOT',
    'Supply the original scene_read result for a saved UTF-8 scene.',
  );
  requireText(scene.text, 'scene.text');
  const bytes = encodeScene(scene.text, scene.encoding);
  requireCondition(
    bytes.length <= maxSceneBytes && bytes.length === scene.bytes && sha256(bytes) === scene.revision,
    'INVALID_SNAPSHOT',
    'Saved scene text, encoding, byte count and revision disagree.',
  );
  requireCondition(Array.isArray(changes) && changes.length >= 1 && changes.length <= 256, 'INVALID_RANGE', 'Supply 1 to 256 fragment changes.');

  const edits = changes.map(change => locateEdit(scene.text, change, sceneId, fragments));
  edits.sort((first, second) => first.start - second.start);
  const parts = [];
  let cursor = 0;
  let lastStart = -1;
  for (const edit of edits) {
    requireCondition(edit.start >= cursor && edit.start !== lastStart, 'INVALID_RANGE', 'Edit ranges overlap or share a start.');
    parts.push(scene.text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
    lastStart = edit.start;
  }
  parts.push(scene.text.slice(cursor));

  const candidate = parts.join('');
  const after = encodeScene(candidate, scene.encoding);
  const afterRevision = sha256(after);
  requireCondition(after.length <= maxSceneBytes, 'INVALID_RANGE', 'The patched scene exceeds the scene size limit.');
  requireCondition(afterRevision !== scene.revision, 'EMPTY_EDIT', 'The combined patch does not change the saved scene.');
  return {
    operation: { type: 'edit_scene', path: scene.path, expectedRevision: scene.revision, edits },
    afterRevision,
  };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireCondition(size <= maxRequestBytes, 'INVALID_INPUT', 'The JSON request exceeds the helper input limit.');
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  requireCondition(input?.mode === 'validate-story' || input?.mode === 'patch', 'INVALID_INPUT', 'Select validate-story or patch mode.');
  const ids = storyIds(input.storyText);
  const result = input.mode === 'patch'
    ? patch(input, ids)
    : { scenes: Object.fromEntries(ids.scenes) };
  process.stdout.write(JSON.stringify(result) + '\n');
}

try {
  await main();
} catch (error) {
  const result = error?.code
    ? { code: error.code, message: error.message }
    : { code: 'INVALID_INPUT', message: 'Provide a valid UTF-8 JSON request.' };
  process.stderr.write(JSON.stringify(result) + '\n');
  process.exitCode = 1;
}
