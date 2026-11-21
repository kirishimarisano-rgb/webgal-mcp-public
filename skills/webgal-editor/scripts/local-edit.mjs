import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function bytes(text, encoding) {
  return Buffer.from((encoding === 'utf-8-bom' ? '\uFEFF' : '') + text);
}

const hash = data => createHash('sha256').update(data).digest('hex');
const validText = text => typeof text === 'string' && text.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);

function linesOf(text) {
  const lines = [];
  let start = 0;
  for (const end of text.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ start, text: text.slice(start, end.index), eol: end[0] });
    start = end.index + end[0].length;
  }
  lines.push({ start, text: text.slice(start), eol: '' });
  return lines;
}

// Match complete physical lines, including the internal line endings.
function occurrences(text, lines, block) {
  const positions = new Map(lines.map((line, i) => [line.start, i]));
  const matches = [];
  for (let pos = text.indexOf(block); pos !== -1; pos = text.indexOf(block, pos + 1)) {
    const end = pos + block.length;
    if (positions.has(pos) && (end === text.length || /^[\r\n]$/.test(text[end]))
      && !(text[end - 1] === '\r' && text[end] === '\n')) matches.push(positions.get(pos));
  }
  return matches;
}

function context(lines, index, count) {
  return { left: lines[index - 1]?.text ?? null, right: lines[index + count]?.text ?? null };
}

function makeEdit(scene, start, before, after) {
  check(validText(after) && before !== after && after.length > 0, 'Supply a changed, nonempty local block.');
  const candidate = scene.text.slice(0, start) + after + scene.text.slice(start + before.length);
  const result = bytes(candidate, scene.encoding);
  check(result.length <= 1024 * 1024, 'Edited scene exceeds the MCP text limit.');
  return {
    operation: { type: 'edit_scene', path: scene.path, expectedRevision: scene.revision,
      edits: [{ start, end: start + before.length, text: after }] },
    afterRevision: hash(result),
  };
}

function run({ mode, scene, projectId, needle, firstLine, lastLine = firstLine, before, after, receipt }) {
  check(projectId && scene?.source === 'disk' && typeof scene.path === 'string'
    && validText(scene.text) && ['utf-8', 'utf-8-bom'].includes(scene.encoding), 'Use an original scene_read snapshot.');
  const raw = bytes(scene.text, scene.encoding);
  check(raw.length === scene.bytes && hash(raw) === scene.revision, 'Saved bytes disagree with scene_read.');
  const lines = linesOf(scene.text);
  if (mode === 'find') {
    check(typeof needle === 'string' && needle.length > 0, 'Supply a nonempty literal.');
    return lines.flatMap((line, i) => line.text.includes(needle)
      ? [{ line: i + 1, text: line.text, ...context(lines, i, 1) }] : []);
  }
  if (mode === 'draft') {
    check(Number.isInteger(firstLine) && Number.isInteger(lastLine)
      && firstLine >= 1 && lastLine >= firstLine && lastLine <= lines.length, 'Invalid saved line range.');
    const start = lines[firstLine - 1].start;
    const last = lines[lastLine - 1];
    check(before && before === scene.text.slice(start, last.start + last.text.length),
      'The selected lines differ from the reviewed text.');
    const plan = makeEdit(scene, start, before, after);
    const postText = scene.text.slice(0, start) + after + scene.text.slice(start + before.length);
    const postLines = linesOf(postText);
    const count = linesOf(after).length;
    const anchors = context(postLines, firstLine - 1, count);
    const hits = occurrences(postText, postLines, after).map(i => context(postLines, i, count));
    return { ...plan, receipt: { projectId, path: scene.path, beforeRevision: scene.revision,
      afterRevision: plan.afterRevision, start, before, after, ...anchors,
      uniqueLeft: postLines.filter(line => line.text === anchors.left).length === 1,
      uniqueRight: postLines.filter(line => line.text === anchors.right).length === 1,
      uniquePair: hits.filter(hit => hit.left === anchors.left && hit.right === anchors.right).length === 1 } };
  }
  check(mode === 'undo' && receipt?.projectId === projectId && receipt.path === scene.path,
    'Select the receipt belonging to this project and scene.');
  check(validText(receipt.after) && receipt.after.length && validText(receipt.before) && receipt.before.length,
    'The receipt lacks an exact before/after block.');
  let start = receipt.start;
  if (scene.revision !== receipt.afterRevision) {
    const count = linesOf(receipt.after).length;
    const hits = occurrences(scene.text, lines, receipt.after);
    const leftCount = lines.filter(line => line.text === receipt.left).length;
    const rightCount = lines.filter(line => line.text === receipt.right).length;
    const anchored = hits.filter(index => {
      const { left, right } = context(lines, index, count);
      const leftMatches = left === receipt.left;
      const rightMatches = right === receipt.right;
      return (receipt.uniquePair && leftMatches && rightMatches)
        || (receipt.uniqueLeft && left && leftMatches && leftCount === 1 && !rightCount && receipt.right !== null)
        || (receipt.uniqueRight && right && rightMatches && rightCount === 1 && !leftCount && receipt.left !== null);
    });
    check(anchored.length === 1, 'Conflict: applied text or its identifying context changed or is ambiguous.');
    start = lines[anchored[0]].start;
  }
  check(Number.isSafeInteger(start) && start >= 0
    && scene.text.slice(start, start + receipt.after.length) === receipt.after, 'Conflict: applied text changed.');
  // A reverse edit gets its own receipt and follows the same plan/approval protocol.
  const index = lines.findIndex(line => line.start === start);
  return run({ mode: 'draft', scene, projectId, firstLine: index + 1,
    lastLine: index + linesOf(receipt.after).length, before: receipt.after, after: receipt.before });
}

try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(run(request)) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
