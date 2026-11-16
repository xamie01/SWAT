# Package25 bounded artifact recovery

bounded source/mock remediation complete; native/full runtime acceptance unavailable; not full PF-SEC-10 closure

## Actual acceptance

- Final actual-helper stdlib run: 22 passed, 0 failed/errors/skipped; 90 counted unittest assertion calls plus separately uncounted inert Mock assertions; exit0.
- Source-only checks: 8 passed, 0 failed; six files syntax-compiled, not imported; exit0.
- Historical red-b: 2 passed/13 failed methods, 22 failure assertions, exit1; inspected, not recreated.

## Exact recovery changes

- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/config.py:11-13,121-155,200-217 — Require subroots beneath PROJECT_ROOT; reject symlink ancestors and group/world-writable or foreign-user package subtree; match imported address prefixes to declared chain.
  - SHA256 917fe27c79c425aede7f4dfab029db123d8e7a8adee071e87b3448ef5836128c
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/storage.py:102 — Fingerprint canonical address, not raw alias; inherited public validation and path checks preserved.
  - SHA256 0a89c2d9655d65161a952b9f4a6719bebb1fca6c906276565137726e020d72a0
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/choice/package25_artifacts.py:30-39,145-158,167-168 — Oversized integer rejected as ValueError; strict integer scalar dump metadata; optional named/Column_i feature order checked; all linear-leaf markers refused.
  - SHA256 d9c0926802926412163200c73636133c3f037e462450102f3eb96c432e8ed155
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:68-89,197-308,310-342 — Private temporary fixtures independent of ambient umask; seven additional actual-helper methods; counted unittest assertions and executed method reporting.
  - SHA256 42d8c5faa2fdfb3b1e214969447347cb7adedb14c68dfdc18e430e502e15d7be

## Executed evidence

| Label | Exit | Actual method/assertion outcome |
|---|---:|---|
| package25-ml-pytest-availability-20261113a | 3 | {} |
| package25-ml-boundary-red-20261114b | 1 | {"errorAssertions": 0, "failed": 13, "failureAssertions": 22, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 2, "skipped": 0, "total": 15} |
| package25-artifact-recovery-20261114-inherited-boundary | 1 | {"errorAssertions": 1, "failed": 1, "failureAssertions": 0, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 14, "skipped": 0, "total": 15} |
| package25-artifact-recovery-20261114-root-red | 1 | {"errorAssertions": 0, "failed": 1, "failureAssertions": 1, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 15, "skipped": 0, "total": 16} |
| package25-artifact-recovery-20261114-root-green | 0 | {"errorAssertions": 0, "failed": 0, "failureAssertions": 0, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 16, "skipped": 0, "total": 16} |
| package25-artifact-recovery-20261114-address-red | 1 | {"errorAssertions": 0, "failed": 1, "failureAssertions": 1, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 16, "skipped": 0, "total": 17} |
| package25-artifact-recovery-20261114-address-green | 0 | {"errorAssertions": 0, "failed": 0, "failureAssertions": 0, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 17, "skipped": 0, "total": 17} |
| package25-artifact-recovery-20261114-export-red | 1 | {"errorAssertions": 0, "failed": 1, "failureAssertions": 2, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 17, "skipped": 0, "total": 18} |
| package25-artifact-recovery-20261114-export-red-b | 1 | {"errorAssertions": 0, "failed": 1, "failureAssertions": 5, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 17, "skipped": 0, "total": 18} |
| package25-artifact-recovery-20261114-export-green | 0 | {"errorAssertions": 0, "failed": 0, "failureAssertions": 0, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 18, "skipped": 0, "total": 18} |
| package25-artifact-recovery-20261114-semantics-red | 1 | {"errorAssertions": 1, "failed": 1, "failureAssertions": 0, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 21, "skipped": 0, "total": 22} |
| package25-artifact-recovery-20261114-boundary-final-green | 0 | {"errorAssertions": 0, "failed": 0, "failureAssertions": 0, "name": "/home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py", "passed": 22, "skipped": 0, "total": 22} |
| package25-artifact-recovery-20261114-source-final-green | 0 | {"failed": 0, "passed": 8, "skipped": 0} |

## Import/fixture safety

Fake pattern_ml/choice packages with empty __path__; yaml,dotenv,duckdb,polars inert mocks; schema inert module; FEATURE_COLUMNS extracted by AST literal_eval only. Config module top level does not read env files; _load_env mocked before settings calls; dotenv mock raises if called. No CLI/rank/providers/package initialization or native import executed. Test file itself only stdlib imports. Source checker reads/parses/compiles six selected files but never imports or executes them.

Private disposable temp directory under runner TMPDIR; JSON and opaque text/bytes only, inert frame and booster.dump_model mocks; no serialized pickle/joblib/native artifact created or loaded.

Historical runner emits outboundNetworkAndCredentialReadsGuarded=true for every language. This is not a Python sandbox guarantee; safety here relies on reviewed finite import/fixture graph and isolated stdlib invocation.

## Red qualifications

- Historical red-b inspected unchanged: exit1, 15 methods, 2 passed/13 failed, 22 failureAssertions/0 errors. Historical source-stage hashes not recorded; do not equate it with current dirty source.
- Recovery inherited check exit1: 14 passed/1 error, scoring neighbor rejected fixture permissions. Fixed fixture to explicit mode0600/private umask, did not weaken file policy.
- Root-red method16: 15 passed/1 failed, one actual failure on external subroot. Follow-on writable-root assertion not reached until green.
- Address-red method17: 16 passed/1 failed, one actual canonical alias fingerprint assertion. Prefix cases not reached until green.
- Export-red: 17 passed/1 failed, two failures then aborted method; export-red-b: 17 passed/1 failed, five actual rejection subcase failures.
- Semantics-red: 21 passed/1 error, actual oversized integer OverflowError; positive missing-policy/bounds/split roundtrip methods20-22 already passed, no invented red.
- Final-green: 22 passed/0 failed/0 errors/0 skipped, 90 unittest assertion invocations (50 assertRaises,12 assertEqual,1 assertTrue,21 assertIsNotNone,6 assertFalse); inert Mock assertions additional and not included. Source checks separately 8 passed/0 failed, six files compiled without execution.

## Remaining source/native/runtime gaps

- Required pytest/numpy/polars/duckdb/lightgbm/typer unavailable in historical probe exit3; no new installs or native availability claims. Existing pytest security fixtures only source-compiled, never accepted as executed tests.
- JSON supports bounded scalar numeric <= trees only (8MiB,1024 trees,50000 nodes,depth64), finite values, declared ordered features and None/NaN/Zero policies. No categorical/linear/averaged/multiclass/native deserialization fallback. No native LightGBM parity or exact float32 boundary/zero-threshold equivalence proven.
- Same-user ownership/permissions and declared producer are local operator checks, not signatures, external producer authentication, model quality, financial safety or approval. Concurrent same-user/root ancestor replacement and file mutation races remain; native Parquet/DuckDB path I/O is not descriptor-anchored. Shared ancestors outside package subtree must be trusted operationally.
- New permission rejection is deliberately fail-closed: ambient group-writable package/storage paths require operator correction; no filesystem permission changes to real paths performed.
- Pricing cache remaining unchecked leaf: /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/prices.py:35-44,101-103. Inherited temporary prices.py.tmp file preserved and never promoted.
- Archival/report remaining unchecked run_id/source/destination/leaf paths: /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/report.py:48-69,93,139,180,188-237; legacy model.pkl archive listing is copy-only, not deserialization. This bounded recovery does not certify all ML filesystem seams.
- Raw fingerprint remains existing height/time summary, not a hash of entire frame; only canonical identity bug corrected, no broad storage redesign.

## Selected files and fingerprints

- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py — SHA256 42d8c5faa2fdfb3b1e214969447347cb7adedb14c68dfdc18e430e502e15d7be
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_source_checks.py — SHA256 f9580c889248a7a0a4155ad57e1644c756a2c05a401d3f9359266a2fe9d278b9
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/config.py — SHA256 917fe27c79c425aede7f4dfab029db123d8e7a8adee071e87b3448ef5836128c
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/storage.py — SHA256 0a89c2d9655d65161a952b9f4a6719bebb1fca6c906276565137726e020d72a0
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/choice/package25_artifacts.py — SHA256 d9c0926802926412163200c73636133c3f037e462450102f3eb96c432e8ed155
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/choice/schema.py — SHA256 21d716b3af4bea3ea04fcf538c6e4a1c33779e3c3c46d38a74287686feea371c
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/cli.py — SHA256 1a7f58657f9323855fdabb3a58e8bc84ed311ab03ea78648009e9881114775f9
- /home/xahmie/Documents/SWAT/pattern-ml/tests/conftest.py — SHA256 53214aca7b87e457c975ee74dd9e24c711e839ace1692cc137e4cc0b6189ed92
- /home/xahmie/Documents/SWAT/pattern-ml/tests/test_package25_ml_security.py — SHA256 f8273effa45c6b6165276ecaa30f555be455aec5ced410d473e4f9e74eaf77b3
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/choice/rank.py — SHA256 2b3c300bae30a3b76a7a8d7184aca74c1a75992dcac41156668f4b689bd61b56
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/index/normalize.py — SHA256 793b5749f9bdc0cfcee14d927d97947753b68c946ab15f2e7c78b7f3344970d7
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/prices.py — SHA256 f90c13c2d24d8fd772c7b02080c33d974c7f73ab5808e6be93e50cc6129d4a08
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/report.py — SHA256 453a3875ffc3e847cdc4da15ff857e76008cf982c9d2cbc6be773d733a33db53
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/__init__.py — SHA256 c73279d7e209aeafd7d1c8314e9e39ec111b2f8e0b74569ec55c81c1b8dbb594
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/choice/__init__.py — SHA256 24fa7e94412105b2ae2c4921cd489c2890a7ab72cedb262c9593f264b2befd8c
- /home/xahmie/Documents/SWAT/pattern-ml/scripts/setup-server.sh — SHA256 42933a8fc842a364e57d489712cf3afa511ee7611ad12218f6c46b85855ee9af
- /home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/prices.py.tmp.12222.de7a35e086f0 — SHA256 b2cef19cb198a63f71fc176199e6617229c4f8561589887d94533405d48b4994
- /home/xahmie/Documents/SWAT/threats/sequential-fixes/run-check.py — SHA256 bc0995bd7a3d8020e0fc1ccec8a064efc60692efb643a8c9de3114a1034ea689
- /home/xahmie/Documents/SWAT/threats/sequential-fixes/offline-guard.cjs — SHA256 966b8ec41414001f3828feba2f12cfc38cf66cc310c1ef3b20820def54a7cebf
- /home/xahmie/Documents/SWAT/threats/sequential-fixes/package12-29-integration-contracts.md — SHA256 efdcb600ef9312f8362d81c26e8e39d6a18826fbe86874a998b1079ca031c596
- /home/xahmie/Documents/SWAT/threats/post-fix-8905505/secondary-contract-review.md — SHA256 707a21e778f8cd921bae29b8fec212139cea986bfedfd3d6e4ba0478422b9be1

## Method references

- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:91-94 test_01_solana_invalid_components
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:96-99 test_02_canonical_neighbors
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:101-103 test_03_evm_nonhex
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:105-108 test_04_storage_config_escape
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:110-113 test_05_storage_config_symlink
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:115-121 test_06_raw_boundary_before_nonempty_frame_write
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:123-131 test_07_raw_symlink_partition
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:133-138 test_08_raw_allowed_neighbor
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:140-146 test_09_raw_list_symlink
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:148-150 test_10_database_escape
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:152-155 test_11_inert_scoring_neighbor
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:157-161 test_12_schema_and_provenance_rejection
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:163-169 test_13_legacy_never_deserialized
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:171-184 test_14_artifact_symlink_read_write
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:186-194 test_15_mocked_training_export_neighbor
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:197-206 test_16_storage_subroot_cannot_override_project_trust
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:209-222 test_17_raw_canonical_identity_and_prefix_chain
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:225-244 test_18_export_rejects_out_of_subset_metadata_and_linear_leaves
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:247-250 test_19_json_numbers_reject_oversized_integer_as_value_error
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:252-264 test_20_numeric_missing_policies_and_multitree_order
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:266-290 test_21_json_file_and_complexity_bounds
- /home/xahmie/Documents/SWAT/pattern-ml/tests/package25_ml_boundary_unittest.py:292-307 test_22_mocked_numeric_training_dump_roundtrip

Mandatory historical runner unchanged; CPU0/shared flock/240s child deadline/512MB setting; no broad or native runs. Only runner-owned command append, no direct ledger edits. No out-of-ownership wiring required.

Full structured evidence: /home/xahmie/Documents/SWAT/threats/sequential-fixes/package25-artifact-recovery-20261114.report.json
