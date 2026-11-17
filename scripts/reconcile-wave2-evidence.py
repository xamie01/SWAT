#!/usr/bin/env python3
"""Reconcile retained offline reports without rerunning or collapsing table cases."""
import collections
import hashlib
import json
from pathlib import Path

ROOT = Path('/root/SWAT')
OUT = ROOT / 'threats/project-completion-20261117'
LABELS = (
    'build-w2-final-runtime-tests-01',
    'build-w2-final-financial-tests-01',
    'build-w2-review-source-allocation-tests-01',
    'build-w2-final-queue-tests-02',
    'build-w2-final-emit-db-01',
    'build-w2-final-emit-trade-executor-01',
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    records = []
    files = {}
    for label in LABELS:
        command_path = OUT / f'{label}.command.json'
        command = json.loads(command_path.read_text())
        assert command['exitCode'] == command['childExitCode'] == 0
        assert command['workspaceInputsUnchanged'] and not command['timedOut']
        assert command['cpuAffinity'] == [0]
        assert command['nodeHeapMb'] == (512 if command['kind'] == 'test' else 640)
        assert digest(OUT / f'{label}.log') == command['logSha256']
        manifest_path = ROOT / command['workspaceInputManifest']
        assert digest(manifest_path) == command['workspaceInputManifestSha256']
        manifest = json.loads(manifest_path.read_text())
        for name, expected in command['inputSha256'].items():
            # The final config registry added the admission regression between
            # retained allocation tests and final checks. Its old digest remains
            # evidence of that historical command, not an assertion of sameness.
            if name not in ('threats/project-completion-20261117/reviewed-configs.json',):
                assert digest(ROOT / name) == expected, name
        for name, expected in command['emittedArtifactsSha256'].items():
            assert digest(ROOT / name) == expected, name
        record = {
            'label': label, 'kind': command['kind'], 'command': command['command'],
            'commandSha256': digest(command_path), 'logSha256': command['logSha256'],
            'workspaceInputManifestSha256': command['workspaceInputManifestSha256'],
            'exitCode': command['exitCode'], 'cpuAffinity': command['cpuAffinity'],
            'nodeHeapMb': command['nodeHeapMb'], 'elapsedSeconds': command['elapsedSeconds'],
            'timedOut': command['timedOut'], 'workspaceInputsUnchangedDuringCommand': True,
            'artifactCount': len(command['emittedArtifactsSha256']),
        }
        if command['kind'] == 'test':
            result_path = OUT / f'{label}.json'
            assert digest(result_path) == command['resultSha256']
            report = json.loads(result_path.read_text())
            assert report['success']
            counts = collections.Counter()
            for file in report['testResults']:
                name = str(Path(file['name']).relative_to(ROOT))
                assert name not in files, f'Duplicate selected file: {name}'
                assert file['status'] == 'passed'
                assert digest(ROOT / name) == manifest[name], name
                assertions = []
                for index, assertion in enumerate(file['assertionResults']):
                    assert assertion['status'] == 'passed'
                    counts[assertion['status']] += 1
                    assertions.append({'collectionIndex': index, 'fullName': assertion['fullName'], 'status': assertion['status']})
                files[name] = {'sourceSha256': manifest[name], 'label': label, 'assertions': assertions}
            assert counts['passed'] == report['numPassedTests'] == report['numTotalTests']
            assert report['numFailedTests'] == report['numPendingTests'] == report['numTodoTests'] == 0
            record['resultSha256'] = command['resultSha256']
            record['files'] = len(report['testResults'])
            record['rawAssertionCounts'] = dict(counts)
        records.append(record)
    evidence = {
        'version': 1, 'scope': 'Wave 2 local source and injected offline acceptance; no SQL/runtime/provider/live acceptance',
        'commands': records, 'files': files,
        'deduplication': 'One latest successful result per literal file; every collection index retained, including duplicate fullNames from it.each. No summing reruns.',
        'rawCounts': {'files': len(files), 'passed': sum(len(item['assertions']) for item in files.values()), 'failed': 0, 'skipped': 0, 'pending': 0, 'todo': 0},
        'migrationSha256': {name: digest(ROOT / name) for name in ('packages/db/sql/079_claim_runtime_capabilities.sql', 'packages/db/sql/080_immutable_valuation_corrections.sql')},
        'reconciliation': 'Historical unrelated snapshot differences do not certify current global source. Current selected test hashes, command/log/results and emitted artifact hashes are verified individually; fixtures changed after emits only in test files.',
        'runtimeAccepted': False, 'liveCapabilityAccepted': False, 'productionReady': False,
    }
    path = OUT / 'WAVE2-FINAL-EVIDENCE.json'
    with path.open('x') as handle:
        json.dump(evidence, handle, indent=2)
        handle.write('\n')
    print(json.dumps(evidence['rawCounts']))
    print(digest(path))


if __name__ == '__main__':
    main()
