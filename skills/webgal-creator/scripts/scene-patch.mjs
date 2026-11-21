import { createHash } from 'node:crypto';

const maxSceneBytes = 1024 * 1024;
const maxRequestBytes = 12 * maxSceneBytes;
const revisionFormat = /^[a-f0-9]{64}$/;
const fragmentFormat = /^F[0-9]{3,}$/;
const idMarker = /^<!--\s*(?:scene|fragment)\s*:/u;
const fenceMarker = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
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

function requireSceneText(value, name) {
  requireText(value, name);
  // Match the control characters rejected by the server's scene editor.
  requireCondition(!/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    'INVALID_TEXT', name + ' contains a control character unsupported in WebGAL scenes.');
}

function withoutComments(line, comment) {
  let visible = '';
  let offset = 0;
  while (offset < line.length) {
    const delimiter = comment.open ? '-->' : '<!--';
    const next = line.indexOf(delimiter, offset);
    if (next === -1) return comment.open ? visible : visible + line.slice(offset);
    if (!comment.open) visible += line.slice(offset, next);
    comment.open = !comment.open;
    offset = next + delimiter.length;
  }
  return visible;
}

function* storyLines(storyText) {
  const comment = { open: false };
  let fence;
  for (const raw of storyText.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    const marker = fenceMarker.exec(raw);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      else if (line) yield ''; // Fenced code is visible but cannot introduce structure.
      continue;
    }
    if (!comment.open && marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    if (!comment.open && idMarker.test(line) && line.includes('-->')) {
      yield line;
      continue;
    }
    const canStartStructure = !comment.open && !line.startsWith('<!--');
    const visible = withoutComments(raw, comment).trim();
    if (visible) yield canStartStructure ? visible : '';
  }
}

function storyIds(storyText) {
  requireText(storyText, 'storyText');
  const scenes = new Map();
  const fragments = new Map();
  let sceneId;
  let waitingForScene = false;
  let needsContent = false;

  for (const line of storyLines(storyText)) {
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
    requireCondition(!idMarker.test(line), 'INVALID_ID', 'An ID marker is malformed or out of place.');
    if (sceneId) {
      requireCondition(scenes.get(sceneId).length > 0, 'INVALID_ID', 'Scene content must start with a fragment ID.');
      needsContent = false;
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

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function synchronizedScene(scriptMap, sceneId, scene) {
  requireCondition(scriptMap?.schemaVersion === 1 && isRecord(scriptMap.scenes), 'INVALID_BASELINE',
    'Supply the existing version 1 script-map.json for the selected project.');
  const mapped = scriptMap.scenes[sceneId];
  requireCondition(mapped?.path === scene.path && typeof mapped.verifiedRevision === 'string' && revisionFormat.test(mapped.verifiedRevision), 'INVALID_BASELINE',
    'The saved scene path or revision baseline does not match the script map for ' + sceneId + '.');

  const fragments = new Map();
  for (const [owner, entry] of Object.entries(scriptMap.scenes)) {
    requireCondition(isRecord(entry?.fragments) && (owner === sceneId || entry.path !== scene.path), 'INVALID_BASELINE',
      'The script map must identify one owner for the target path and contain a fragment map for each scene.');
    for (const [id, fragment] of Object.entries(entry.fragments)) {
      requireCondition(!fragments.has(id), 'INVALID_BASELINE', 'More than one scene maps fragment ' + id + '.');
      fragments.set(id, { owner, fragment });
    }
  }
  return { fragments, drifted: mapped.verifiedRevision !== scene.revision };
}

function locateEdit(text, change, sceneId, fragments, baseline) {
  const { fragmentId, before, after, removed = false } = change ?? {};
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
  const previous = baseline.fragments.get(fragmentId);
  requireCondition(previous ? previous.owner === sceneId && isRecord(previous.fragment) : !removed && before === '',
    'INVALID_BASELINE', 'Only a fragment synchronized to this scene may replace or remove saved text.');
  const original = previous?.fragment;
  const { left = original?.left ?? '', right = original?.right ?? '' } = change;
  for (const [name, value] of Object.entries({ before, after, left, right })) requireSceneText(value, name);
  if (original) {
    requireCondition(before === original.webgal, 'TARGET_CHANGED', 'The before text disagrees with the synchronized fragment.');
    requireCondition(typeof original.left === 'string' && typeof original.right === 'string' &&
      original.left.endsWith(left) && original.right.startsWith(right), 'TARGET_CHANGED',
      'Anchors must match the synchronized fragment or narrow its recorded context.');
    requireCondition(!baseline.drifted || left || right, 'AMBIGUOUS_TARGET', 'A changed scene needs recorded context to identify the fragment.');
  }
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
  requireSceneText(scene.text, 'scene.text');
  const bytes = encodeScene(scene.text, scene.encoding);
  requireCondition(
    bytes.length <= maxSceneBytes && bytes.length === scene.bytes && sha256(bytes) === scene.revision,
    'INVALID_SNAPSHOT',
    'Saved scene text, encoding, byte count and revision disagree.',
  );
  requireCondition(Array.isArray(changes) && changes.length >= 1 && changes.length <= 256, 'INVALID_RANGE', 'Supply 1 to 256 fragment changes.');

  const baseline = synchronizedScene(input.scriptMap, sceneId, scene);
  const edits = changes.map(change => locateEdit(scene.text, change, sceneId, fragments, baseline));
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
