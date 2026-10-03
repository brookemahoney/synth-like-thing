/**
 * Module graph helpers. No dependencies, no build step.
 *
 * Used by scripts/check-invariants.mjs and scripts/ownership.mjs. Both need the
 * same two facts: which files the page actually loads, and which modules are
 * reachable from them by following static imports.
 */

import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const WEB_ROOT = path.join(REPO_ROOT, 'web');

/** Every .js file under web/, sorted, as repo-relative paths. */
export function webModules(root = WEB_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(path.relative(REPO_ROOT, full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * The entry points the HTML actually loads, read from index.html rather than
 * hardcoded here — so adding a <script> tag is enough to make a module a root.
 */
export function entryPoints(htmlPath = path.join(WEB_ROOT, 'index.html'), root = WEB_ROOT) {
  if (!fs.existsSync(htmlPath)) return [];
  const html = fs.readFileSync(htmlPath, 'utf8');
  const specs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]);
  return specs
    .map((spec) => path.relative(REPO_ROOT, path.resolve(path.dirname(htmlPath), spec)))
    .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));
}

/** Static import specifiers in a module: `import ... from 'x'` and bare `import 'x'`. */
function staticImports(source) {
  const specs = new Set();
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g)) specs.add(m[1]);
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) specs.add(m[1]);
  return [...specs];
}

/**
 * Modules reachable from the entry points by static import.
 *
 * Dynamic `import()` inside a function body is deliberately NOT followed: a
 * module reachable only via a runtime import is exactly the bug this catches
 * (a singleton that never loads in the shipped page while a probe that imports
 * it by hand still passes).
 */
export function reachableModules({ root = WEB_ROOT, entries = entryPoints(undefined, root) } = {}) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    seen.add(rel);
    for (const spec of staticImports(fs.readFileSync(abs, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = path.relative(REPO_ROOT, path.resolve(path.dirname(abs), spec));
      if (target.startsWith('..')) continue;
      visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  return seen;
}

/** Repo-relative path for anything under web/ that a task might claim. */
export function inWeb(p) {
  const rel = path.posix.normalize(p.replaceAll(path.sep, '/'));
  return rel.startsWith('web/') || rel === 'web';
}