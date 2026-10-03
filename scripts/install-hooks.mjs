#!/usr/bin/env node
/**
 * Install the pre-commit guardrail: `npm run hooks:install`.
 *
 * A committed copy lives in scripts/git-hooks/ and is copied into .git/hooks,
 * so the hook is reviewable in a diff rather than being a local-only file that
 * silently drifts from what CI runs.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const source = path.join(REPO_ROOT, 'scripts', 'git-hooks', 'pre-commit');
const hooksDir = path.join(REPO_ROOT, '.git', 'hooks');
const target = path.join(hooksDir, 'pre-commit');

if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
  console.error('not a git repository');
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`missing ${path.relative(REPO_ROOT, source)}`);
  process.exit(1);
}

fs.mkdirSync(hooksDir, { recursive: true });

// Preserve an existing hook before overwriting, never after.
const backup = `${target}.strikethroo-backup`;
const hadPrevious = fs.existsSync(target);
if (hadPrevious) {
  fs.rmSync(backup, { force: true });
  fs.renameSync(target, backup);
}

fs.copyFileSync(source, target);
fs.chmodSync(target, 0o755);

console.log(`installed .git/hooks/pre-commit -> scripts/git-hooks/pre-commit`);
if (hadPrevious) console.log(`previous hook kept at ${path.relative(REPO_ROOT, backup)}`);
console.log('bypass once with: git commit --no-verify');