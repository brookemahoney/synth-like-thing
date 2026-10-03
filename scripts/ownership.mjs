#!/usr/bin/env node
/**
 * Parallel-dispatch ownership report. Zero dependencies.
 *
 *   node scripts/ownership.mjs [plan-id]
 *
 * Every phase in a blueprint's Execution Blueprint runs its tasks in parallel,
 * so two tasks in one phase must not write the same file. That constraint is
 * invisible until the tasks land, and it has bitten this project repeatedly:
 * two tasks each edited a test file neither owned, and two tasks both needed
 * the same audio module, which forced a seam to be invented mid-flight.
 *
 * This script reads the blueprint, reads each task's own claims on the tree,
 * and reports every file more than one task in the same phase claims. It
 * cannot know what a task will actually touch — it reports the hazard so the
 * partition is decided once, up front, instead of discovered after the fact.
 *
 * Claims come from backticked paths in a task's Technical Requirements,
 * Input Dependencies, Output Artifacts and Implementation Notes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, inWeb, webModules, reachableModules } from './lib/modules.mjs';

const STRIKETHROO = path.join(REPO_ROOT, '.ai', 'strikethroo');

function findPlan(idArg) {
  for (const group of ['plans', 'archive']) {
    const groupDir = path.join(STRIKETHROO, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const plan of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!plan.isDirectory()) continue;
      const file = path.join(groupDir, plan.name, `plan-${plan.name}.md`);
      if (!fs.existsSync(file)) continue;
      const id = fs.readFileSync(file, 'utf8').match(/^id:\s*(\d+)$/m)?.[1];
      if (idArg === undefined || String(id) === String(idArg)) return { group, dir: path.join(groupDir, plan.name), file, id };
    }
  }
  return null;
}

/** Phases from the Execution Blueprint, as task ids in dispatch order. */
function parsePhases(planSource) {
  const blueprint = planSource.split(/^## Execution Blueprint\s*$/m)[1];
  if (!blueprint) return [];
  const phases = [];
  const chunks = blueprint.split(/^### (?=.*Phase \d)/m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.match(/Phase (\d+):\s*(.+)/);
    if (!header) continue;
    const ids = [...chunk.matchAll(/-\s*(?:✔️\s*)?Task (\d+)/g)].map((m) => Number(m[1]));
    phases.push({ number: Number(header[1]), title: header[2].trim(), tasks: [...new Set(ids)] });
  }
  return phases;
}

/**
 * What a task says it will write.
 *
 * Authoritative: an `owns:` list in the task's YAML frontmatter — a glob, a
 * directory or a file. Everything else is best-effort, because a task that
 * only implies its output in prose cannot be checked.
 *
 * The `owns:` list exists because this project's ownership constraints lived
 * only in dispatch prompts: unenforced, invisible after the fact, and lost
 * every time a phase ran. Declaring them where the task lives makes the
 * partition reviewable in the same place as the work it governs.
 */
function declaredOwnership(source) {
  const frontmatter = source.split(/^---$/m)[1];
  if (!frontmatter) return [];
  const block = frontmatter.match(/^owns:[ \t]*(?:\n((?:[ \t]*-[ \t]+.*\n?)+))?/m);
  if (!block) return [];
  const inline = block[0].match(/owns:\s*\[([^\]]*)\]/);
  const raw = inline ? inline[1].split(',') : (block[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return raw.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** Best-effort paths mentioned in the task body, used only when `owns:` is absent. */
function mentionedPaths(source) {
  const body = source.split(/^---$/m)[2] ?? source;
  const claims = new Set();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const candidate = m[1].trim().replace(/[.,;:]$/, '').replace(/\/?\*\*$/, '');
    if (!inWeb(candidate) && !/^(tests|scripts)\//.test(candidate)) continue;
    if (/\s/.test(candidate)) continue;
    if (candidate.split('/').length < 2) continue;
    claims.add(candidate);
  }
  return [...claims];
}

function ownershipOf(source) {
  const declared = declaredOwnership(source);
  return { declared, claims: declared.length > 0 ? declared : mentionedPaths(source), authoritative: declared.length > 0 };
}

/** Does claim `a` overlap claim `b`? A directory or glob covers everything beneath it. */
function overlaps(a, b) {
  const norm = (p) => p.replace(/\/$/, '').replace(/\/\*\*$/, '');
  const na = norm(a);
  const nb = norm(b);
  return na === nb || nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`);
}

const plan = findPlan(process.argv[2]);
if (!plan) {
  console.error(process.argv[2] ? `no plan with id ${process.argv[2]}` : 'no plan found under .ai/strikethroo/{plans,archive}');
  process.exit(1);
}

const planSource = fs.readFileSync(plan.file, 'utf8');
const phases = parsePhases(planSource);
if (phases.length === 0) {
  console.error(`plan ${plan.id} has no Execution Blueprint yet — nothing to schedule`);
  process.exit(1);
}

const taskFile = (id) => {
  const tasksDir = path.join(plan.dir, 'tasks');
  if (!fs.existsSync(tasksDir)) return null;
  const prefix = String(id).padStart(2, '0');
  const hit = fs.readdirSync(tasksDir).find((f) => f.startsWith(`${prefix}--`));
  return hit ? path.join(tasksDir, hit) : null;
};

let hazards = 0;
let unspecified = 0;
let unwired = 0;

// Which task, in the whole plan, owns the entry-point file? A phase whose tasks
// each add a module nobody imports needs someone to add a <script> tag, and if
// no task in the plan owns index.html then nobody is going to.
const ALL_TASK_FILES = [];
for (const group of ['plans', 'archive']) {
  const groupDir = path.join(REPO_ROOT, '.ai', 'strikethroo', group);
  if (!fs.existsSync(groupDir)) continue;
  for (const planDir of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!planDir.isDirectory()) continue;
    const tasksDir = path.join(groupDir, planDir.name, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const file of fs.readdirSync(tasksDir)) {
      if (file.endsWith('.md')) ALL_TASK_FILES.push(path.join(tasksDir, file));
    }
  }
}
const ENTRY_OWNERS = [];
for (const f of ALL_TASK_FILES) {
  const source = fs.readFileSync(f, 'utf8');
  if (!declaredOwnership(source).some((c) => c === 'web/index.html')) continue;
  const id = source.match(/^id:\s*(\d+)$/m)?.[1];
  const owner = phases.find((p) => p.tasks.includes(Number(id)));
  ENTRY_OWNERS.push({ id: Number(id), phase: owner ? owner.number : null });
}

for (const phase of phases) {
  console.log(`\nPhase ${phase.number}: ${phase.title}`);

  const perTask = [];
  for (const id of phase.tasks) {
    const file = taskFile(id);
    if (!file) {
      console.log(`  Task ${id}: no task file — cannot check ownership`);
      unspecified += 1;
      continue;
    }
    const rel = path.relative(REPO_ROOT, file);
    const source = fs.readFileSync(file, 'utf8');
    const title = source.match(/^# (.+)$/m)?.[1] ?? '(untitled)';
    perTask.push({ id, rel, title, ...ownershipOf(source) });
  }

  for (const task of perTask) {
    const claims = task.claims;
    const flag = task.authoritative ? 'owns ' : 'implies';
    const list = claims.length === 0 ? '(nothing — add an owns: list to the frontmatter)' : claims.join(', ');
    console.log(`  Task ${String(task.id).padStart(3, '0')}  ${task.title}`);
    console.log(`           ${flag} ${list}`);
    if (!task.authoritative) unspecified += 1;
  }

  // The hazard: two tasks in one parallel phase claiming the same file or
  // directory. Anything they both claim is a coin toss on who writes last.
  const reported = new Set();
  for (let i = 0; i < perTask.length; i += 1) {
    for (let j = i + 1; j < perTask.length; j += 1) {
      const a = perTask[i];
      const b = perTask[j];
      for (const claimA of a.claims) {
        const clash = b.claims.find((claimB) => overlaps(claimA, claimB));
        if (!clash) continue;
        const key = [claimA, clash].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        console.log(
          `  COLLISION  ${claimA}  <->  ${clash}   (task ${String(a.id).padStart(3, '0')} and task ${String(b.id).padStart(3, '0')} run in parallel)`,
        );
        hazards += 1;
      }
    }
  }

  // A task can own a brand-new module that nothing in the page imports. That
  // module is on disk, in the repo, and absent from the delivered page — and if
  // no task in this phase owns the entry-point file, there is nobody whose job
  // it is to add the <script> tag. This is the collision check's blind spot:
  // nothing conflicts, because the file that is missing is one no task in the
  // phase ever claimed.
  const reachable = reachableModules();
  const onDisk = new Set(webModules());
  for (const task of perTask) {
    for (const claim of task.claims) {
      const target = claim.replace(/\/?\*+$/, '');
      if (claim.includes('*') || !inWeb(target) || !onDisk.has(target)) continue;
      if (reachable.has(target)) continue;
      console.log(`  UNWIRED     ${target}  (task ${String(task.id).padStart(3, '0')} owns it, but no entry point imports it)`);
      console.log('              the page will not load it, and check-invariants will fail on it');
      const inPhase = ENTRY_OWNERS.filter((o) => o.phase === phase.number);
      if (inPhase.length === 0) {
        const where = ENTRY_OWNERS.length === 0
          ? 'NO task in this plan owns web/index.html'
          : `web/index.html is owned by task ${ENTRY_OWNERS.map((o) => o.id).join(', ')}, in phase${ENTRY_OWNERS.length === 1 ? '' : 's'} ${ENTRY_OWNERS.map((o) => o.phase).join(', ')}`;
        console.log(`              ${where}, and not by phase ${phase.number}`);
        console.log('              -> give one task in THIS phase web/index.html in owns:, or the <script> tag will not be added');
      }
      hazards += 1;
      unwired += 1;
    }
  }

  if (perTask.length === 1) continue;

  // A task that both protects a path and claims it is self-contradictory.
  for (const task of perTask) {
    const source = fs.readFileSync(task.rel, 'utf8');
    const readonly = source.match(/^readonly:[ \t]*(?:\n((?:[ \t]*-[ \t]+.*\n?)+))?/m);
    if (!readonly) continue;
    const protectedPaths = (readonly[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
    for (const file of protectedPaths) {
      if (task.claims.some((c) => overlaps(c, file))) {
        console.log(`  CONTRADICTION  task ${task.id} lists ${file} as readonly and also claims it`);
        hazards += 1;
      }
    }
  }
}

console.log('');
if (hazards === 0 && unspecified === 0) {
  console.log('ownership: every parallel phase has a single owner per file, and every owned module is wired');
  process.exit(0);
}
console.error(
  `ownership: ${hazards} blocking issue(s), ${unspecified} task(s) without an authoritative owns: list` +
    `${unwired ? `, ${unwired} owned module(s) not reachable from the page` : ''} — partition before dispatching`,
);
process.exit(1);