# Bounded deployment source verification — 2026-11-14

Fixed baseline `8905505595802c21053118b5fab3fd53a8a1654c`; observed HEAD `08c822d470554ef1f05e701b1abbed7dcb3dbc54`. This checkpoint verifies actual dirty/untracked deployment sources, not the full 425-path committed diff or deployed runtime.

## Executed evidence

`package27-deploy-static-neighbors-20261114p.json` and matching log: exit0, 20 static source assertions passed, zero failed/skipped, plus 3 distinct stdlib neighboring test methods passed. Exactly 14 explicit public source files from `package27-deploy-manifest.json` were read. The earlier 19-assertion green remains historical evidence; the new assertion checks the pending publish-step credential gate. These are not Vitest test/file counts and are not summed with other checkpoints.

The reviewed verifier performs source reads, SHA256, Python AST parsing/compilation without execution, static substring assertions, and inert stdlib unittest. Invocation used `/usr/bin/python3 -I -S`, CPU0, shared `/tmp/swat-package11-checks.lock`, historical runner and unique label; elapsed3.346seconds. The Node preload does not sandbox Python; safety derives from inspection of the complete verifier and its explicit source inputs. No installer, acquisition/publish helper, systemd unit, cron job, CI pipeline, network, real credential, native model or subprocess from deployment code was executed. Generic runner guard metadata is not Python OS-sandbox proof.

## Source containment, not completed deployment

Both CI deployment stages use the inherited mutable placeholder image; the publish stage is disabled with `evaluate: 'false'`, and both tool locks remain `approval: pending`. Genuine independently reviewed image/tool/output/wheel inventories are absent. Their source validators refuse approval or image mismatch. No invented digest or approval was added, and no source deployment setting was changed in this continuation.

Systemd/cron/path and credential-free acquisition checks are static only. Actual CI parser behavior, secret injection, filesystem permissions, binaries, process isolation, tool provenance, publishing behavior and service/runtime operation remain unverified. Python AST compilation is not deployment execution or full package acceptance.

## Independent review and corrected cron defect

Both original bounded reviewers hit the provider token-rate limit. The narrower original Standards retry also failed; there is **no broad deployment Standards verdict**. The narrower original Spec retry returned one supported Medium provisioning contradiction: the old `deploy/crontab.example:7–8` header applied root:swat0640 to the password file as well as service metadata. Unix libpq rejects group/other-readable password files, so that recipe would fail if password authentication were required. This did not establish deployed authentication behavior.

Coordinator corrected only the cron template header: nonsecret pg_service.conf remains root:swat0640; pgpass is separately swat:swat0600, explaining the libpq constraint. No real file permissions, secrets, cron or services were changed. New source regression `package27-cron-permissions-20261114.test.py` retained actual red1passed/2failed/3methods exit1 (`package27-cron-permissions-red-20261114q.json`), then green3passed/0failed/3methods exit0 (`package27-cron-permissions-green-20261114r.json`). Post-correction neighbors `package27-deploy-static-neighbors-20261114s.json`:20static assertions and3 separate neighboring methods passed,14public inputs,exit0. Results are separate checkpoints, not aggregated as Vitest tests.

The original Spec reviewer's corrected-source retry failed at provider rate limit. Fresh narrow Standards reviewer `agent_16f9f786-5681-4bea-8237-48607af849e3` returned0documentedviolations/0actionablesmells. Fresh narrow Spec reviewer `agent_759b1faf-1936-4f8e-b2dc-2ec9e56906eb` confirmed the sole Medium finding resolved,0supportedresiduals/scopecreep0. Both read only the corrected cron/template regression and applicable guidance; no tests were independently executed. This resolves the supported **cron source recipe** defect, not broader Standards, infrastructure, libpq runtime or package27 acceptance. Completed reviewers returned.

Corrected cron SHA256: `92d1e4953104f00e4fb823d0f20d982287cd902bdaa2d6f94a03046d38a40908`. Package27 remains in-progress.
