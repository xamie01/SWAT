#!/usr/bin/env node
/**
 * Fails when the code reads an environment variable that `.env.example` does not
 * document (checklist S4-M39).
 *
 * **The defect this exists to prevent, stated concretely.** The code reads 26
 * `ROBINHOOD_*` variables; `.env.example` documented three. One of the three was
 * `ROBINHOOD_QUOTER_V2`, which nothing reads, while the code reads
 * `ROBINHOOD_QUOTER`, which was absent -- so the documented value could never
 * take effect, and the value itself was an *Ethereum mainnet* address on a chain
 * where it is not a quoter. An operator following the file could not produce a
 * working config, and the failure surfaced as a revert rather than as
 * "you are missing a variable".
 *
 * Two directions, because each catches a different mistake:
 *
 *   - **undocumented** -- the code reads it, the file does not mention it. An
 *     operator cannot know to set it.
 *   - **orphaned** -- the file defines it, no code reads it. Usually a rename
 *     that updated one side, which is exactly the `_V2` case above. Reported as
 *     a warning rather than a failure, since a deliberately-retired variable may
 *     linger for one release.
 *
 * A variable with a code-side default is still reported as undocumented: a
 * default makes it optional, not invisible, and an operator tuning behaviour
 * needs to know the knob exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage', '.git']);
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/;

/**
 * Prefixes this check governs.
 *
 * Deliberately an allowlist rather than every `process.env` read in the
 * workspace. A repo-wide sweep would drown in `NODE_ENV`, `CI`, and test-only
 * variables and would be switched off within a week; a narrow gate that stays on
 * is worth more. Add a prefix when its family earns the same scrutiny.
 */
const GOVERNED_PREFIXES = ['ROBINHOOD_'];

/**
 * Read by the code but intentionally absent from `.env.example`.
 *
 * Each entry needs a reason. An empty exemption list is the goal.
 */
const EXEMPT = new Map([
  [
    'ROBINHOOD_LIVE_NOT_READY',
    'test-only override that forces the live-readiness clamp; documenting it in .env.example would advertise a way to skip a safety gate'
  ]
]);

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
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

function governed(name) {
  return GOVERNED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const files = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir), []));

// Matches `process.env.NAME`, `process.env['NAME']` and `values.NAME` / `values['NAME']`
// -- this codebase threads an injected `values` record through its config parsers
// so they are testable without mutating the real environment, so a scan that only
// looked for `process.env` would miss every variable that matters here.
const READ_PATTERN = /(?:process\.env|values)(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;
// Also catch `required(values, 'NAME')` / `address(values, 'NAME')` helper calls.
const HELPER_PATTERN = /\b(?:required|address|positiveInteger|optional)\s*\(\s*values\s*,\s*['"]([A-Z][A-Z0-9_]*)['"]/g;

const readBy = new Map();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of [READ_PATTERN, HELPER_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (!name || !governed(name)) continue;
      if (!readBy.has(name)) readBy.set(name, new Set());
      readBy.get(name).add(relative(ROOT, file));
    }
  }
}

const namesFile = process.argv[2] === '--names-file' && process.argv.length === 4 ? process.argv[3] : null;
if (process.argv.length > 2 && !namesFile) throw new Error('Expected --names-file <assignment-name-inventory>');
const nameInventory = namesFile ? JSON.parse(readFileSync(namesFile, 'utf8')) : null;
if (nameInventory && (!Array.isArray(nameInventory.assignmentNames)
    || nameInventory.assignmentNames.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)))) {
  throw new Error('Expected assignment names only, without values');
}
const exampleText = namesFile ? null : readFileSync(join(ROOT, '.env.example'), 'utf8');

/**
 * "Documented" means an assignment line, NOT a prose mention.
 *
 * The first draft of this script counted any occurrence of the name, on the
 * reasoning that a comment is how the file explains a variable it cannot give a
 * default for. **That was wrong, and its own mutation test proved it:**
 * re-introducing the original bug -- renaming the assignment back to
 * `ROBINHOOD_QUOTER_V2` while a comment still mentioned `ROBINHOOD_QUOTER` --
 * PASSED, because the prose satisfied the check. A gate that its own
 * documentation can defeat is not a gate.
 *
 * So an assignment is required. `NAME=` with an empty value counts: that is the
 * honest way to say "required, value not yet known", and it is what an operator
 * copying this file needs to see. A commented-out `# NAME=` does not count --
 * copying the file would leave it unset.
 */
const assigned = new Set(
  (namesFile ? nameInventory.assignmentNames
    : [...exampleText.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1])).filter(governed)
);
const documented = assigned;

const undocumented = [...readBy.keys()]
  .filter((name) => !documented.has(name) && !EXEMPT.has(name))
  .sort();
const orphaned = [...assigned].filter((name) => !readBy.has(name)).sort();

if (orphaned.length > 0) {
  console.warn('Defined in .env.example but read by no code (likely a rename that updated one side):\n');
  for (const name of orphaned) console.warn(`  ${name}`);
  console.warn('');
}

if (undocumented.length > 0) {
  console.error('Read by the code but undocumented in .env.example:\n');
  for (const name of undocumented) {
    console.error(`  ${name}`);
    for (const file of [...readBy.get(name)].sort()) console.error(`      ${file}`);
  }
  console.error(
    '\nAn operator following .env.example cannot produce a working config while these are missing,'
    + '\nand the failure surfaces as a revert rather than as a missing-variable error.'
    + '\nDocument each one -- with an explicit "unknown, see <item>" marker where the value is not yet known.'
  );
  process.exit(1);
}

const exempt = EXEMPT.size > 0 ? ` (${EXEMPT.size} exempt)` : '';
console.log(
  `checked ${files.length} files; all ${readBy.size} governed env vars documented${exempt}`
  + (orphaned.length > 0 ? `; ${orphaned.length} orphaned (warning only)` : '')
);
