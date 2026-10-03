#!/usr/bin/env node
/**
 * Repository invariants. Zero dependencies, no build step: `node scripts/check-invariants.mjs`.
 *
 * Every check here is deterministic and maps to a constraint the project has
 * actually been bitten by. They run in `npm test` and in the pre-commit hook,
 * so a violation fails before it reaches a commit rather than being noticed by
 * hand several phases later.
 *
 * Adding a check: state the invariant, say what it protects, and keep it
 * mechanical. A check that needs judgement belongs in CONTRIBUTING.md instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, WEB_ROOT, webModules, entryPoints, reachableModules } from './lib/modules.mjs';

const failures = [];
const notes = [];
const fail = (check, detail) => failures.push({ check, detail });
const note = (text) => notes.push(text);

/* ------------------------------------------------------------------ *
 * 1. Strikethroo task frontmatter
 * ------------------------------------------------------------------ */

const TASK_STATUSES = new Set(['pending', 'in-progress', 'completed', 'failed', 'needs-clarification']);

function strikethrooTaskFiles() {
  const base = path.join(REPO_ROOT, '.ai', 'strikethroo');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const group of ['plans', 'archive']) {
    const groupDir = path.join(base, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const plan of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!plan.isDirectory()) continue;
      const tasksDir = path.join(groupDir, plan.name, 'tasks');
      if (!fs.existsSync(tasksDir)) continue;
      for (const file of fs.readdirSync(tasksDir)) {
        if (file.endsWith('.md')) out.push({ plan: plan.name, file: path.join(tasksDir, file) });
      }
    }
  }
  return out;
}

function checkTaskFrontmatter() {
  const seenIds = new Map();
  for (const { plan, file } of strikethrooTaskFiles()) {
    const rel = path.relative(REPO_ROOT, file);
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = source.split(/^---$/m)[1];
    if (frontmatter === undefined) {
      fail('task-frontmatter', `${rel}: no YAML frontmatter`);
      continue;
    }
    const field = (name) => frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');

    // Status must be one of the six words the harness documents. Subagents have
    // written "done" and "complete", which no transition table accepts.
    const status = field('status');
    if (!status) fail('task-status', `${rel}: no status field`);
    else if (!TASK_STATUSES.has(status)) {
      fail('task-status', `${rel}: status "${status}" is not one of ${[...TASK_STATUSES].join(', ')}`);
    }

    const score = field('complexity_score');
    if (score !== undefined) {
      if (!/^\d+$/.test(score) || Number(score) < 1 || Number(score) > 10) {
        fail('task-complexity', `${rel}: complexity_score "${score}" is not an integer 1-10`);
      }
    }

    // The filename carries the id; a mismatch makes task references ambiguous.
    const id = field('id');
    const prefix = path.basename(file).match(/^(\d+)--/)?.[1];
    if (id !== undefined && prefix !== undefined) {
      if (String(Number(id)).padStart(2, '0') !== prefix) {
        fail('task-id', `${rel}: frontmatter id ${id} disagrees with filename prefix ${prefix}`);
      }
      const key = `${plan}#${id}`;
      if (seenIds.has(key)) fail('task-id', `${rel}: duplicate task id ${key}, also in ${seenIds.get(key)}`);
      else seenIds.set(key, rel);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. The shipped module graph
 * ------------------------------------------------------------------ */

function checkModuleGraph() {
  const entries = entryPoints();
  if (entries.length === 0) {
    fail('module-graph', 'web/index.html loads no <script src>: the page would ship no JavaScript');
    return;
  }
  // Every module under web/ must be reachable from the HTML's entry points.
  // A singleton that is only ever reached by a probe's dynamic import() is
  // absent from the delivered page while still passing every check that
  // imports it by hand.
  const reachable = reachableModules();
  const orphans = webModules().filter((m) => !reachable.has(m));
  if (orphans.length > 0) {
    fail('module-graph', `unreachable from index.html (add a static import, or an <script> tag): ${orphans.join(', ')}`);
  }
  note(`module graph: ${entries.length} entry point(s), ${reachable.size} module(s) reachable`);
}

/* ------------------------------------------------------------------ *
 * 3. Plan constraints on the docroot
 * ------------------------------------------------------------------ */

function checkSingleTimer() {
  // The single-clock rule: the sequencer, the arpeggiator and the synced LFOs
  // all subscribe to one lookahead scheduler. A second setInterval is how a
  // sequencer drifts, so it is an error, not a style choice.
  const offenders = webModules().filter((m) => /\bsetInterval\s*\(/.test(fs.readFileSync(path.join(REPO_ROOT, m), 'utf8')));
  if (offenders.length > 1) {
    fail('single-timer', `setInterval appears in ${offenders.length} modules: ${offenders.join(', ')}. Exactly one scheduler is allowed.`);
  } else if (offenders.length === 0) {
    fail('single-timer', 'no module contains setInterval: the instrument has no clock at all');
  } else {
    note(`single timer: ${offenders[0]}`);
  }
}

function checkNoThirdParty() {
  // Everything is served first-party so the page works with the network offline.
  const allowed = /w3\.org|DEVOPTS|xlink/;
  const offenders = [];
  for (const rel of webModules()) {
    for (const m of fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').matchAll(/\bhttps?:\/\/[^\s'"`)]+/g)) {
      if (!allowed.test(m[0])) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  const html = path.join(WEB_ROOT, 'index.html');
  if (fs.existsSync(html)) {
    for (const m of fs.readFileSync(html, 'utf8').matchAll(/\bhttps?:\/\/[^\s'"`)]+/g)) {
      if (!allowed.test(m[0])) offenders.push(`web/index.html: ${m[0]}`);
    }
  }
  for (const rel of fs.existsSync(path.join(WEB_ROOT, 'styles')) ? fs.readdirSync(path.join(WEB_ROOT, 'styles')) : []) {
    if (!rel.endsWith('.css')) continue;
    for (const m of fs.readFileSync(path.join(WEB_ROOT, 'styles', rel), 'utf8').matchAll(/@import\s+url\(?["']?(https?:\/\/[^\s)'"]+)/g)) {
      offenders.push(`web/styles/${rel}: @import ${m[1]}`);
    }
  }
  if (offenders.length > 0) fail('no-third-party', `off-site references: ${offenders.join('; ')}`);
}

function checkNoBinaryMedia() {
  // The 808 kit, the factory wavetables and the impulse response are all
  // generated at runtime. Shipping an asset here is a silent scope change.
  const binary = /\.(png|jpe?g|gif|webp|avif|svg|ico|wav|mp3|ogg|flac|m4a|aac|woff2?|ttf|otf|eot)$/i;
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (binary.test(entry.name)) found.push(path.relative(REPO_ROOT, full));
    }
  };
  if (fs.existsSync(WEB_ROOT)) walk(WEB_ROOT);
  if (found.length > 0) fail('no-binary-media', `assets in the docroot (all sound and texture must be generated): ${found.join(', ')}`);
}

function checkWebIsDependencyFree() {
  // The site has no build step and no package manager. Repo-root tooling is
  // fine; anything inside web/ would imply the site needs installing.
  const forbidden = ['package.json', 'package-lock.json', 'node_modules', 'vite.config.js', 'webpack.config.js', 'tsconfig.json'];
  const found = forbidden.filter((name) => fs.existsSync(path.join(WEB_ROOT, name)));
  if (found.length > 0) fail('web-dependency-free', `build tooling inside web/: ${found.join(', ')}`);
}

function checkNoAudioWorklet() {
  const offenders = webModules().filter((m) => /audioWorklet|AudioWorkletNode/.test(fs.readFileSync(path.join(REPO_ROOT, m), 'utf8')));
  if (offenders.length > 0) fail('no-audioworklet', `AudioWorklet referenced in ${offenders.join(', ')}: out of scope, native nodes only`);
}

/* ------------------------------------------------------------------ *
 * 6. A report, never a gate: exports nothing but comments refer to
 * ------------------------------------------------------------------ */

/**
 * An export whose only mentions anywhere else in the repository are inside
 * comments is either dead weight or public API nothing in-repo calls. Both are
 * worth a human's five seconds; neither is a build failure, because a
 * self-initialising module legitimately exports its lifecycle entry points for
 * an outside caller.
 *
 * This exists because it found one: masterBus had become a unity-gain
 * pass-through once task 8 moved `global.volume` downstream, so nothing wrote
 * its gain any more — and whether to remove it is a judgement about a
 * deliberate architectural seam, which is precisely not this script's call.
 */
function reportCommentOnlyExports() {
  const sources = new Map();
  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (/\.(js|mjs)$/.test(entry.name)) sources.set(full, fs.readFileSync(full, 'utf8'));
    }
  };
  collect(WEB_ROOT);
  collect(path.join(REPO_ROOT, 'tests'));

  // Count a name once in code and once in the full text, so "mentioned only in a
  // comment" means the code count is zero while the raw count is not.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const corpus = [...sources].map(([file, raw]) => ({ file, raw, code: stripComments(raw) }));

  const flagged = [];
  for (const [file, raw] of sources) {
    if (!file.startsWith(WEB_ROOT)) continue;
    for (const match of raw.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      const word = new RegExp(`\\b${name}\\b`, 'g');
      let inCode = 0;
      let inText = 0;
      for (const entry of corpus) {
        if (entry.file === file) continue;
        inCode += (entry.code.match(word) ?? []).length;
        inText += (entry.raw.match(word) ?? []).length;
      }
      if (inCode === 0 && inText > 0) flagged.push(`${path.relative(REPO_ROOT, file)} :: ${name} (${inText} comment mention${inText === 1 ? '' : 's'})`);
    }
  }
  if (flagged.length > 0) {
    note(`exported but only ever named in comments — dead weight or out-of-repo API, your call:`);
    for (const line of flagged) note(`    ${line}`);
  }
}

/* ------------------------------------------------------------------ */

checkTaskFrontmatter();
checkModuleGraph();
checkSingleTimer();
checkNoThirdParty();
checkNoBinaryMedia();
checkWebIsDependencyFree();
checkNoAudioWorklet();
reportCommentOnlyExports();

for (const line of notes) console.log(`  note  ${line}`);
if (failures.length === 0) {
  console.log('invariants: all checks passed');
  process.exit(0);
}
for (const { check, detail } of failures) console.error(`  FAIL  ${check}: ${detail}`);
console.error(`invariants: ${failures.length} failed`);
process.exit(1);