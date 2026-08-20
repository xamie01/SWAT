#!/usr/bin/env node
/**
 * Fails the build if a secret-shaped value is exposed to the browser (D12).
 *
 * Anything named `NEXT_PUBLIC_*` is inlined into the client bundle by Next.js at
 * build time. It is shipped to every visitor, so a secret placed there is
 * published, not configured — and unlike a leaked server secret it cannot be
 * contained by rotating access, only by rotating the secret itself.
 *
 * The audit already found this exact shape: `NEXT_PUBLIC_API_KEY` puts the
 * shared API key in the bundle. Existing occurrences are grandfathered in
 * `ALLOWED` below and removed by checklist S6-3; the point of this script is
 * that no *new* ones can appear while that work is pending.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage', '.git']);
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Names that make a browser-exposed variable a secret rather than config. */
const SECRET_PATTERN = /NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL)[A-Z0-9_]*/g;

/**
 * Known violations awaiting removal by S6-3 (Stage 6 frontend rebuild).
 * Do not add to this list — remove the usage instead.
 */
const ALLOWED = new Set(['NEXT_PUBLIC_API_KEY']);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir), []));
const violations = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(SECRET_PATTERN)) {
      const name = match[0];
      if (ALLOWED.has(name)) continue;
      violations.push(`${relative(ROOT, file)}:${index + 1}  ${name}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Browser-exposed secrets found (D12):\n');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    '\nNEXT_PUBLIC_* is inlined into the client bundle and shipped to every visitor.'
  );
  console.error('Move the value server-side, or rename it if it is genuinely not a secret.');
  process.exit(1);
}

console.log(
  `checked ${files.length} files; no new browser-exposed secrets`
    + (ALLOWED.size > 0 ? ` (${ALLOWED.size} grandfathered, tracked by S6-3)` : '')
);
