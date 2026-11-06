# Coverage ledger

`done` means the bounded module review and report are complete, not that every file was audited. `In-depth relevant path` includes selected regions whose effect and callers were traced; exact full/partial ranges and search-only reads are in module appendices. LOC counts are inventory sizes, not audited LOC.

| Module | Files | LOC | In-depth relevant path | Skim/search | Not reviewed | Status |
|---|---:|---:|---:|---:|---:|---|
| [01-api](security-review/01-api.md) | 21 | 6567 | 11 | 2 | 8 | done |
| [02-database](security-review/02-database.md) | 186 | 37719 | 53 | 16 | 117 | done |
| [03-crypto-authority](security-review/03-crypto-authority.md) | 12 | 3490 | 5 | 3 | 4 | done |
| [04-on-chain-programs](security-review/04-on-chain-programs.md) | 8 | 1193 | 6 | 0 | 2 | done |
| [05-indexer-parsers](security-review/05-indexer-parsers.md) | 36 | 10595 | 14 | 2 | 20 | done |
| [06-signals-scorer](security-review/06-signals-scorer.md) | 35 | 9355 | 10 | 8 | 17 | done |
| [07-trade-executor](security-review/07-trade-executor.md) | 152 | 46475 | 22 | 14 | 116 | done |
| [08-secondary-services](security-review/08-secondary-services.md) | 135 | 21349 | 24 | 2 | 109 | done |
| [09-agent-mcp](security-review/09-agent-mcp.md) | 4 | 561 | 3 | 0 | 1 | done |
| [10-web-app](security-review/10-web-app.md) | 67 | 21044 | 17 | 19 | 31 | done |
| [11-infrastructure-supply-chain](security-review/11-infrastructure-supply-chain.md) | 32 | 3268 | 20 | 7 | 5 | done |
| [12-test-assurance](security-review/12-test-assurance.md) | 21 | 5517 | 6 | 0 | 15 | done |
| **Total** | **709** | **167133** | **191** | **73** | **445** | **bounded review complete** |

## Coverage and exclusions

- The concrete per-file statuses and evidence-report ownership are in [source-inventory.json](evidence/source-inventory.json). Unlisted sections of partial files remain unreviewed.
- Both local programs, standalone PDA UI, Python secondary service and cross-cutting test assurance were included. No Solidity source was discovered; this is not an audit of external EVM contracts.
- The static phase ran no application tests/builds/services or live requests. Subsequent single-core execution, public data/advisory calls and isolated database-role checks are recorded separately in [runtime verification](04-runtime-verification.md); the static file-depth counts above are unchanged. No current real `.env`/credentials were read. Remote deployment, funding, firewall, key distribution and external audits remain unverified.
- Historical coverage is bounded to all locally reachable commits; binary payloads, unreachable/reflog-only objects, external submodules/LFS payloads and encoded/obfuscated secrets are excluded as recorded in module 11.
- Static Critical/High revalidation and neighboring caller compatibility appear in each report; local test descriptions are not passing tests.
- Source-integrity, table/reference checks, and final severity inventory are recorded in [artifact-validation.json](evidence/artifact-validation.json).
