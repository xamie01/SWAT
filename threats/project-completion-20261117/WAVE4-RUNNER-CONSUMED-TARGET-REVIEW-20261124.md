# Wave 4 runner consumed-target re-review — 2026-11-24

## Earlier independent verdict: REJECT, source-only

The independent affected reviewer confirmed the direct symlink-to-excluded-evidence repair but identified a remaining manifest namespace collision. No subject-code import, parser, test, hash, compiler or runtime verification was executed. This report transcribes that read-only verdict; it is not coordinator self-acceptance.

## Blocking finding

At the reviewed source, `scripts/build-completion-runner.py:223–225` writes file content under its relative filesystem pathname and mode under that pathname plus `#mode` in the same dictionary. Consumed target traversal can include generated-prefix files that ordinary traversal later excludes.

The source-supported, unexecuted counterexample is:

- `scripts/a-consumer` links to `threats/project-completion-20261117/tmp/payload#mode`.
- `scripts/z-consumer` links to `threats/project-completion-20261117/tmp/payload`.

Sorted traversal first records the first target's content digest, then overwrites it with the second target's integer mode under the same key. Changing only `payload#mode`'s bytes can leave the manifest unchanged. Equality of incomplete/overwritten manifests cannot detect that change. Collision-free separation or explicit fail-closed collision handling is required. Existing eight affected symlink tests do not cover this case.

Python dictionary equality also admits equivalent boolean/integer values. The reviewer disclosed that representation limitation but did not demonstrate an additional byte-drift bypass from it.

## Confirmed bounded improvements

- Noncanonical consumed targets recursively bind canonical bytes, modes, directory/link identities and intermediate aliases despite normal generated exclusions.
- Ordinary direct `build-*` JSON/log exclusions require regular files inside declared evidence directories.
- Workspace confinement, credential checks, strict resolution and directory ancestor-cycle rejection remain in the inspected paths.
- Approval admission preserves full mixed-type manifests and literal test inventory.
- No additional supported WNOWAIT/leader-preserving cleanup source defect was found. This is not actual Linux process-group proof.

## Repair disposition

The exclusive two-file repair is frozen. Existing policy, immutable historical artifacts, lifecycle handling, CPU0/shared lock, guard, fork/heap limits and fresh-emit handling remain preserved. Tests remain UNRUN.

## Latest independent verdict: bounded ACCEPT, source-only

A fresh affected reviewer accepted the repair. Centralized manifest writes track provenance and actual filesystem-path kinds while retaining historical keys/values. Conflicting path/metadata aliases, kinds, types, values or provenance raise before overwrite; identical recapture remains permitted. Both capture orders of the reported `payload#mode` collision refuse.

File/symlink/directory identities, `#mode`, `#canonical`, `#absent` and `runtime:` writes use the guard; canonical consumed targets remain recursively captured despite generated-output exclusions. Recursive type-strict comparisons now distinguish boolean/integer and integer/float substitutions during approval and pre/post input comparison.

The reviewer inspected the 16 added test methods as source only. No tests, imports, parsers, hashes or Linux process-group verification ran. This closes the reported collision findings in the bounded inspected source, not the whole P0 evidence gate. ## Subsequent static-selection finding

Offline import review accepted the inspected28-file TypeScript selection but rejected the combined static selection: the Python test used a cache-capable source loader, while isolated Python ignores `PYTHONDONTWRITEBYTECODE` and `__pycache__` is excluded from binding. Existing cache was observed read-only; no cache was deleted or executed.

Coordinator replaced that loader with an explicit module/filename and compile/exec of bound source bytes only. Two inert regressions cover stale cache preservation, source changes and no new cache creation. This test-only repair is frozen under independent affected re-review; it does not change accepted runner manifest/lifecycle source. All tests remain unrun.

Verification remains prohibited while consumed-source writers are active; full freeze, guarded runner tests and new complete additive bindings are still required.
