#!/usr/bin/env python3
"""Authenticate explicit shader reviews against a captured diagnostic and build.

This is an offline audit, not a WGSL validator or an automatic permission grant.
New sources require a separate complete-source review manifest. Existing runtime
interface, bounds and encode gates remain authoritative.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(pathlib.Path(path).read_text())


def body(source, name):
    found = re.search(r'\bfn\s+' + re.escape(name) + r'\s*\(', source)
    if found is None:
        raise ValueError('missing function: ' + name)
    start = source.index('{', found.end())
    end, depth = start + 1, 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


def source_checks(source):
    vertex = body(source, 'standardVertexPosition')
    scene = body(source, 'sceneIndexVertex')
    main = body(source, 'vs_main_impl')
    fragment = body(source, 'fs_gbuffer')
    return {
        'identityVertexPosition': bool(re.fullmatch(r'\{\s*return\s+\w+\.pos;\s*\}', vertex)),
        'sceneIndexUsesCurrentVisibleAndTransform': all(x in scene for x in ['visibleItems[', 'sceneIndexDraw', 'vs_main_impl']),
        'standardWorldAndClipPosition': all(x in main for x in ['standardVertexPosition', 'localToWorld * vec4', 'out_1.clip =', 'worldViewProj']),
        'fixedStandardGBuffer': all(x in fragment for x in ['evaluateStandardSurface', 'alphaTestSurface', 'encodeStandardGBuffer', 'packSceneTemporalV1WithValidity']),
        'noFragmentDepth': not re.search(r'\bfrag_depth\b', source),
        'noWritableStorage': not re.search(r'var\s*<\s*storage\s*,\s*read_write\s*>', source),
        'noStorageTexture': not re.search(r'\btexture_storage_\w+', source),
        'noAtomicOrTextureStore': not re.search(r'\b(?:atomic\w*|textureStore)\b', source),
        'noComputeEntry': '@compute' not in source,
    }


FUNCTIONS = ['standardVertexPosition', 'vs_scene_index', 'sceneIndexVertex', 'vs_main_impl', 'fs_gbuffer', 'alphaTestSurface']


def brief_match(match):
    row = dict(match)
    row['equivalentAssetCount'] = len(row['equivalentAssetGuids'])
    row['equivalentAssetGuids'] = row['equivalentAssetGuids'][:8]
    row['selections'] = [{
        'pass': x['pass'], 'address': x['address'], 'entry': x['entry'],
        'context': x['context'],
        'abi': {k: x['abi'].get(k) for k in ['directEntry', 'sceneIndexEntry', 'receiptIdentity', 'generation']},
    } for x in row['selections']]
    return row


def main():
    parser = argparse.ArgumentParser()
    for name in ['capture', 'build', 'prior-review', 'new-review', 'output', 'report']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    capture, build = load(args.capture), load(args.build)
    assert capture['engineCommit'] == build['enginePin']
    assert capture['gameCommit'] == build['gameHead']
    assert capture['indexSha256'] == build['indexSha256']
    root = pathlib.Path(build['dist'])
    assert digest((root / 'index.html').read_bytes()) == build['indexSha256']
    manifest = load(build['buildReport'])['value']['artifacts']
    artifacts = {row['path']: row for row in manifest}
    inspection = capture['gbufferBatchOrder']['profileResult']['value']['renderScene']['gpuDriven']['gbufferBatchOrderDiagnostic']
    classes = inspection['classes']
    selected = sorted({row['sourceDigest'] for row in classes})
    prior = load(args.prior_review)
    prior_rows = {row['sha256']: row for row in prior['sourceRows'] if row.get('auditAdmitted')}
    reviewed = {row['sourceDigest']: row for row in load(args.new_review)['sources']}
    out = pathlib.Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    matches = {key: [] for key in selected}
    matched_packs = []
    # Match exact material and selected specialization, never an arbitrary GUID alias.
    for path, artifact in artifacts.items():
        if not path.endswith('.pack.json'):
            continue
        pack_path = root / path
        raw = pack_path.read_bytes()
        # The complete program source artifacts are separately authenticated below.
        if not any(key.split(':')[1].encode() in raw for key in selected):
            continue
        assert digest(raw) == artifact['sha256'] and len(raw) == artifact['bytes']
        pack = json.loads(raw)
        local = []
        for asset in pack.get('assets', []):
            cooked = asset.get('payload', {}).get('cooked', {})
            for program in cooked.get('programs', []):
                key = program['artifact']['digest']
                if key not in matches:
                    continue
                observations = [c for c in classes if c['sourceDigest'] == key and c['specializationKey'] == program['specializationKey']]
                if not observations:
                    continue
                selected_rows = [s for s in program['selections'] if s.get('address') == 'scene-index' and s.get('entry') == 'vs_scene_index']
                if not selected_rows:
                    continue
                logical = asset['artifacts'][program['artifact']['path']]
                source_path = str(pathlib.PurePosixPath(path).parent / logical['path'])
                for observed in observations:
                    assert observed['material'] == cooked['specializationKey'] or any(p['specializationKey'] == observed['material'] for p in cooked['programs'])
                match = {'pack': path, 'assetGuid': asset['guid'], 'materialIdentity': cooked['specializationKey'], 'specializationKey': program['specializationKey'], 'sourceArtifact': source_path, 'logicalArtifact': logical, 'selections': selected_rows}
                prior_match = next((m for m in matches[key] if (m['pack'], m['specializationKey'], m['materialIdentity']) == (path, program['specializationKey'], cooked['specializationKey'])), None)
                if prior_match is None:
                    match['equivalentAssetGuids'] = [asset['guid']]
                    matches[key].append(match)
                else:
                    prior_match['equivalentAssetGuids'].append(asset['guid'])
                local.append(key)
        if local:
            frozen = out / pathlib.Path(path).name
            shutil.copyfile(pack_path, frozen)
            matched_packs.append({'path': str(frozen), 'sha256': artifact['sha256'], 'bytes': len(raw)})
    rows, admitted = [], []
    for key in selected:
        assert matches[key], 'missing exact specialization/pack source: ' + key
        source_path = matches[key][0]['sourceArtifact']
        data = (root / source_path).read_bytes()
        artifact = artifacts[source_path]
        assert digest(data) == key.split(':')[1] == artifact['sha256']
        assert len(data) == artifact['bytes']
        for match in matches[key]:
            logical = match['logicalArtifact']
            assert logical['integrity']['digest'] == key
            assert logical['byteLength'] == len(data) and logical['contentEncoding'] == 'identity'
        source = data.decode('utf8')
        checks = source_checks(source)
        assert all(checks.values()), (key, checks)
        function_hashes = {name: digest(body(source, name).encode()) for name in FUNCTIONS}
        if key in prior_rows:
            old_data = pathlib.Path(prior_rows[key]['path']).read_bytes()
            assert digest(old_data) == digest(data)
            review = 'prior-complete-source-review-byte-identical'
        else:
            assert key in reviewed, 'new complete-source review required: ' + key
            assert reviewed[key]['functionBodySha256'] == function_hashes
            assert reviewed[key]['sourceBytes'] == len(data)
            review = 'explicit-new-complete-source-review'
        frozen = out / (key.split(':')[1] + '.wgsl')
        frozen.write_bytes(data)
        interface_eligible = any(not c['rejections'] for c in classes if c['sourceDigest'] == key)
        if interface_eligible:
            admitted.append(key)
        rows.append({'sourceDigest': key, 'sourcePath': str(frozen), 'sourceBytes': len(data), 'checks': checks, 'review': review, 'functionBodySha256': function_hashes, 'currentInterfaceEligible': interface_eligible, 'equivalentPackMatchCount': len(matches[key]), 'packMatches': [brief_match(matches[key][0])]})
    counterfactual = []
    for batch in inspection['batches']:
        index = batch.get('classIndex')
        key = classes[index]['sourceDigest'] if index is not None else None
        reasons = [r for r in batch['rejections'] if r != 'program-digest' or key not in admitted]
        if not reasons:
            counterfactual.append(batch['batchId'])
    result = {
        'schemaVersion': 1, 'kind': 'authenticated-current-gbuffer-program-source-review',
        'decision': 'Explicit opt-in diagnostic allowlist only. No runtime or performance acceptance.',
        'runtime': {k: capture[k] for k in ['gameCommit', 'engineCommit', 'indexSha256']},
        'sourceDomain': 'sha256 of complete UTF8 batch.artifact.program.source, without entry prefix, preprocessing or normalization',
        'inputs': {str(p): digest(pathlib.Path(p).read_bytes()) for p in [args.capture, args.build, build['buildReport'], args.prior_review, args.new_review]},
        'originalInspection': {k: inspection[k] for k in ['preparation', 'denominator', 'eligibleBatches', 'movedBatches', 'rejections']},
        'actualClassCount': len(classes), 'actualSourceCount': len(rows),
        'priorReviewedCount': sum(r['review'].startswith('prior') for r in rows),
        'newReviewedCount': sum(r['review'].startswith('explicit') for r in rows),
        'programDigests': admitted, 'programs': rows, 'frozenPacks': matched_packs,
        'counterfactual': {'eligibleBatchIds': counterfactual, 'eligibleBatches': len(counterfactual), 'kind': 'offline removal of program-digest rejection only; not runtime admission/movement/GPU execution'},
        'scope': ['Only captured complete sources with exact build artifact, pack specialization, independent source review and current interface admission are allowed.', 'The depthWrite=false source remains excluded even though its complete source is readonly.', 'Current bounds/displacement, pass filter, skin/surface, pipeline state and early-six-MRT gates remain unchanged.', 'Ordering can change equal-depth winners. No product, early-Z scheduling, pixel or performance claim is made.'],
    }
    pathlib.Path(args.report).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'sources': len(rows), 'admittedSources': len(admitted), 'newReviewed': result['newReviewedCount'], 'counterfactualBatches': len(counterfactual)}))


if __name__ == '__main__':
    main()
