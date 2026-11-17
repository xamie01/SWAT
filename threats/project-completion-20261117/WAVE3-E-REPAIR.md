# Wave 3 E repair submission

Status: source repairs independently rechecked in WAVE3-E-RECHECK.md. Offline verification is recorded separately; PostgreSQL, custody provider and atomic remote signer behavior are not qualified here.

Original E-R1 through E-R7 mechanisms were inspected rather than rewritten: finite permission/proceeds policy; complete signed domain/network/owner/delegate/nonce/deadline scope; persistent tombstones and monotonic lifecycle/fresh admissions; issued session deadline pinning; restricted custody writer ownership/catalog; tenant-scoped retained APIs; migration-runner-owned transactions.

Coordinator repairs:
- Fixed the custody-store test proposal path to resolve inside this repository.
- Supplied an independently trusted domain in the custody-binding substitution test.
- Removed blanket kind exclusions from the active public metadata finder. The finder never returns ciphertext or binding and does not confer execution authority. Added coverage for all three excluded kinds.
- Bounded E verification exposed a historical fixture address containing 42 rather than 40 hexadecimal digits; corrected only the fixture. Production address validation remains unchanged.

Independent review of the initial repairs: WAVE3-E-RECHECK.md. Final fixture changes and package integration are covered by the coordinator final recheck. No secrets were used, generated or published. Public metadata and wrap-only enrollment remain separate from execution unwrap capability. Schema081 remains source-only.
