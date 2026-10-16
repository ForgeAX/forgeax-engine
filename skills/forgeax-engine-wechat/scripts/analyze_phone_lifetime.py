#!/usr/bin/env python3
"""Analyze existing phone startup reports; no device access or graphics work."""
import argparse
import hashlib
import json
import re
from pathlib import Path

MAX_COUNTER = 2**53 - 1
SAMPLER_STATES = ('sampling', 'stopped', 'unavailable', 'sample-failed', 'cancel-failed')
KINDS = ('create', 'begin', 'finish', 'end', 'submit', 'destroy', 'free')
FREE_BINS = ('explicit', 'finalizer', 'missing', 'other', 'ptrZero', 'ptrNonzero', 'ptrOther')
LANES = ('insideSubmit', 'outsideSubmit', 'unknownSubmitDepth')
GL_FIELDS = {
    'fenceSync': ('calls', 'nonNull', 'null', 'other', 'throws'),
    'deleteSync': ('calls', 'throws'),
    'getSyncParameter': ('calls', 'signaled', 'unsignaled', 'other', 'throws'),
    'clientWaitSync': ('calls', 'alreadySignaled', 'timeoutExpired', 'conditionSatisfied', 'waitFailed', 'other', 'throws'),
}
NOTE_CATEGORIES = {
    'accessor-unavailable': 'coverage-unavailable',
    'method-unavailable': 'coverage-unavailable',
    'property-write-failed': 'coverage-unavailable',
    'owned-method-replaced': 'later-owner-preserved',
    'restore-failed': 'restoration-failed',
}


def obj(value):
    return value if isinstance(value, dict) else {}


def count(value):
    return value if type(value) is int and 0 <= value <= MAX_COUNTER else None


def name(value):
    # No messages, stacks, paths, account values or arbitrary report strings enter output.
    if isinstance(value, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,511}', value) and not re.fullmatch(r'wx[0-9a-f]{16}', value):
        return value
    return None


def counters(value, fields):
    return {key: count(obj(value).get(key)) for key in fields}


def difference(end, start):
    # Saturation or reset does not become a measured delta.
    if end is None or start is None or MAX_COUNTER in (end, start) or end < start:
        return None
    return end - start


def total(values):
    return sum(values) if all(value is not None and value < MAX_COUNTER for value in values) and sum(values) < MAX_COUNTER else None


def memory(value):
    value = obj(value)
    status = value.get('status')
    if status == 'available' and count(value.get('byteLength')) is not None:
        return {'status': 'available', 'capacityBytes': value['byteLength']}
    return {'status': status if status in ('unavailable', 'read-failed', 'invalid-byte-length') else 'missing-or-invalid', 'capacityBytes': None}


def coverage(facts):
    rows = obj(facts).get('failures')
    return {
        **counters(facts, ('installed', 'restored', 'replaced', 'restoreFailed', 'unavailable')),
        'notes': None if not isinstance(rows, list) else [
            {'method': name(obj(row).get('method')),
             'reason': obj(row).get('reason') if isinstance(obj(row).get('reason'), str) and obj(row).get('reason') in NOTE_CATEGORIES else 'unrecognized',
             'category': NOTE_CATEGORIES.get(obj(row).get('reason'), 'unknown') if isinstance(obj(row).get('reason'), str) else 'unknown'}
            for row in rows
        ],
    }


def runtime_throws(collector, origin):
    collector = obj(collector)
    first = obj(collector.get('first'))
    later = count(collector.get('laterThrows'))
    # Absent first + an explicit laterThrows=0 is the collector's no-captured-throw shape.
    known = later is not None and (bool(first) or ('first' not in collector and later == 0))
    at = count(first.get('at'))
    return {
        'capturedCount': (int(bool(first)) + later) if known and later < MAX_COUNTER else None,
        'laterThrows': later,
        'first': None if not first else {
            'afterMs': at - origin if at is not None and origin is not None else None,
            'operation': name(first.get('operation', first.get('method'))),
            'instanceId': count(first.get('instance')), 'contextId': count(first.get('context')),
            'memory': memory(first.get('memory')),
        },
        'factoryStatus': obj(collector.get('factory')).get('status') if obj(collector.get('factory')).get('status') in ('installed', 'restored', 'unavailable', 'replaced', 'restore-failed') else None,
        'skippedInstances': count(collector.get('skippedInstances')),
        'skippedContexts': count(collector.get('skippedContexts')),
    }


def sample_window(rows, report_origin):
    times = [count(obj(row).get('at')) for row in rows]
    valid = bool(times) and all(t is not None for t in times)
    ordered = valid and all(b > a for a, b in zip(times, times[1:]))
    origin = report_origin if report_origin is not None else next((t for t in times if t is not None), None)
    return {
        'clock': 'Date.now', 'origin': 'report.startedAt' if report_origin is not None else 'first-retained-sample',
        'ordered': bool(ordered), 'retainedSamples': len(rows),
        'firstAfterMs': times[0] - origin if times and times[0] is not None and origin is not None else None,
        'lastAfterMs': times[-1] - origin if times and times[-1] is not None and origin is not None else None,
        'durationMs': times[-1] - times[0] if ordered else None,
    }, origin


def wasm_instance(facts, report_origin, after_submit):
    facts = obj(facts)
    lifetime = obj(facts.get('lifetime'))
    raw = lifetime.get('samples')
    rows = raw if isinstance(raw, list) else []
    window, origin = sample_window(rows, report_origin)
    samples = []
    for row in rows:
        row = obj(row)
        at = count(row.get('at'))
        samples.append({'afterMs': at - origin if at is not None and origin is not None else None,
                        'memory': memory(row.get('memory')), 'calls': counters(row.get('calls'), KINDS),
                        'frees': counters(row.get('frees'), FREE_BINS[:4])})
    issues = []
    if rows and not window['ordered']:
        issues.append('sample-clock-missing-duplicate-or-backward')
    if any(s['memory']['capacityBytes'] is None for s in samples):
        issues.append('memory-unavailable-within-retained-series')
    for kind in KINDS:
        values = [s['calls'][kind] for s in samples]
        if any(v == MAX_COUNTER for v in values):
            issues.append('saturated-' + kind + '-counter')
        if any(a is not None and b is not None and b < a for a, b in zip(values, values[1:])):
            issues.append('reset-' + kind + '-counter')
    selected = [s for s in samples if after_submit == 0 or (s['calls']['submit'] is not None and s['calls']['submit'] >= after_submit)]
    if after_submit and any(s['calls']['submit'] is None for s in samples):
        issues.append('submit-window-cannot-admit-missing-counter')
    capacities = [s['memory']['capacityBytes'] for s in selected]
    if any(a is not None and b is not None and b < a for a, b in zip(capacities, capacities[1:])):
        issues.append('memory-capacity-decreased-within-instance')
    usable = len(selected) >= 2 and not issues
    trend = {'status': 'insufficient-evidence', 'afterNativeSubmitCalls': after_submit,
             'selectedSamples': len(selected), 'startCapacityBytes': capacities[0] if capacities else None,
             'endCapacityBytes': capacities[-1] if capacities else None,
             'capacityGrowthBytes': None, 'sampledSubmitCallDelta': None, 'constantSuffix': None}
    if usable:
        growth = capacities[-1] - capacities[0]
        suffix = len(selected) - 1
        while suffix > 0 and capacities[suffix-1] == capacities[-1]:
            suffix -= 1
        trend.update(status='capacity-growth-observed' if growth else 'constant-capacity-observed',
                     capacityGrowthBytes=growth,
                     sampledSubmitCallDelta=difference(selected[-1]['calls']['submit'], selected[0]['calls']['submit']),
                     constantSuffix={'startAfterMs': selected[suffix]['afterMs'],
                                     'durationMs': selected[-1]['afterMs'] - selected[suffix]['afterMs'],
                                     'samples': len(selected)-suffix,
                                     'capacityBytes': capacities[-1],
                                     'nativeSubmitCallDelta': difference(selected[-1]['calls']['submit'], selected[suffix]['calls']['submit'])})
    exports = []
    names = set()
    for row in lifetime.get('exports', []) if isinstance(lifetime.get('exports'), list) else []:
        row = obj(row)
        key = name(row.get('name'))
        if key is None or row.get('kind') not in KINDS:
            issues.append('invalid-export-row')
            continue
        if key in names:
            issues.append('duplicate-export-name')
        names.add(key)
        exports.append({'name': key, 'kind': row['kind'], **counters(row, ('calls', 'throws')),
                        **({'freeArguments': counters(row['freeArguments'], FREE_BINS)} if 'freeArguments' in row else {})})
    return {'instanceId': count(facts.get('id')),
            'projectionAdmitted': facts.get('status') == 'projected' if facts.get('status') in ('projected', 'unavailable') else None,
            'coverage': coverage(facts),
            'initialMemory': memory(facts.get('initialMemory')), 'window': window,
            'droppedSamples': count(lifetime.get('droppedSamples')), 'sampler': lifetime.get('sampler') if lifetime.get('sampler') in SAMPLER_STATES else None,
            'issues': sorted(set(issues)), 'capacity': trend, 'samples': samples, 'exports': exports}


def gl_counts(row):
    row = obj(row)
    lanes = {lane: {method: counters(obj(row.get(lane)).get(method), fields) for method, fields in GL_FIELDS.items()} for lane in LANES}
    totals = {method: {field: total([lanes[lane][method][field] for lane in LANES]) for field in fields} for method, fields in GL_FIELDS.items()}
    created, deleted = totals['fenceSync']['calls'], totals['deleteSync']['calls']
    return {'lanes': lanes, 'totals': totals,
            'fenceSyncCallsMinusDeleteSyncCalls': created - deleted if created is not None and deleted is not None else None}


def gl_context(facts, report_origin):
    facts = obj(facts)
    lifetime = obj(facts.get('lifetime'))
    raw = lifetime.get('samples')
    rows = raw if isinstance(raw, list) else []
    window, origin = sample_window(rows, report_origin)
    samples = []
    for row in rows:
        at = count(obj(row).get('at'))
        samples.append({'afterMs': at - origin if at is not None and origin is not None else None, **gl_counts(row)})
    final = gl_counts(lifetime)
    differences = [row['fenceSyncCallsMinusDeleteSyncCalls'] for row in samples]
    issues = []
    if rows and not window['ordered']:
        issues.append('sample-clock-missing-duplicate-or-backward')
    for lane in LANES:
        for method, fields in GL_FIELDS.items():
            for field in fields:
                values = [row['lanes'][lane][method][field] for row in samples] + [final['lanes'][lane][method][field]]
                if any(v is None or v == MAX_COUNTER for v in values):
                    issues.append('missing-or-saturated-counters')
                if any(a is not None and b is not None and b < a for a, b in zip(values, values[1:])):
                    issues.append('counter-reset-or-terminal-precedes-last-sample')
    valid_tail = bool(samples) and not issues
    return {'contextId': count(facts.get('id')), 'coverage': coverage(facts), 'window': window,
            'droppedSamples': count(lifetime.get('droppedSamples')), 'sampler': lifetime.get('sampler') if lifetime.get('sampler') in SAMPLER_STATES else None,
            'issues': sorted(set(issues)), 'terminal': final, 'samples': samples,
            'retainedCallDifferenceRange': [min(differences), max(differences)] if valid_tail else None}


def analyze(report, report_sha256, after_submit=0):
    report = obj(report)
    origin = count(report.get('startedAt'))
    ended = count(report.get('finishedAt'))
    wasm, gl = obj(report.get('nativeWasmErrors')), obj(report.get('nativeGlErrors'))
    source = obj(report.get('source'))
    hashes = {key: value for key in ('manifestSha256', 'entrySha256') if isinstance(value := source.get(key), str) and re.fullmatch('[0-9a-f]{64}', value)}
    scene = obj(report.get('sceneFrames'))
    trim = obj(report.get('lifetimeSerialization'))
    instances = wasm.get('instances')
    contexts = gl.get('contexts')
    return {
        'source': {'reportSha256': report_sha256, **hashes},
        'elapsedMs': ended - origin if origin is not None and ended is not None and ended >= origin else None,
        'sceneFrames': {**counters(scene, ('minimum', 'observed', 'generation', 'deviceGeneration', 'completedStart', 'completedEnd', 'presentedStart', 'presentedEnd')),
                        'passed': scene.get('passed') if type(scene.get('passed')) is bool else None},
        'runtimeThrows': {'wasm': runtime_throws(wasm, origin), 'gl': runtime_throws(gl, origin)},
        'rustPanics': {'retainedRecords': len(obj(report.get('rustPanics'))['records']) if isinstance(obj(report.get('rustPanics')).get('records'), list) else None,
                       'droppedRecords': count(obj(report.get('rustPanics')).get('dropped'))},
        'lifetimeSerialization': {**counters(trim, ('maxBytes', 'droppedSamples')),
                                  'status': trim.get('status') if trim.get('status') in ('within-limit', 'trimmed', 'over-limit', 'serialization-failed') else None},
        'wasmInstances': None if not isinstance(instances, list) else [wasm_instance(row, origin, after_submit) for row in instances],
        'glContexts': None if not isinstance(contexts, list) else [gl_context(row, origin) for row in contexts],
    }


def markdown(result):
    lines = ['# Phone lifetime observations', '',
             'Offline analysis of existing reports. Counts are call attempts; capacity is WASM linear-memory extent, not live allocation, JS heap, process RSS or GPU memory.', '',
             'Reports, WASM instances and GL contexts stay separate. Submit calls are not completed frames. No automatic leak-free, performance or whole-device pass is inferred.', '']
    for index, report in enumerate(result['reports'], 1):
        lines += [f'## Report {index}', '', f"SHA-256: `{report['source']['reportSha256']}`.", '',
                  f"Scene-presented observations: {report['sceneFrames']['observed']}; recorded target result: {report['sceneFrames']['passed']}.", '',
                  f"Captured throw counts: WASM {report['runtimeThrows']['wasm']['capturedCount']}, GL {report['runtimeThrows']['gl']['capturedCount']}. Unknown values remain null; coverage notes below are separate.", '',
                  f"Collector factory status: WASM {report['runtimeThrows']['wasm']['factoryStatus']}, GL {report['runtimeThrows']['gl']['factoryStatus']}. Missing owners/history are unavailable, not a zero result.", '']
        for row in report['wasmInstances'] or []:
            trend = row['capacity']
            lines += [f"### WASM instance {row['instanceId']}", '',
                      f"{trend['status']}; selected growth: {trend['capacityGrowthBytes']} B; {trend['selectedSamples']} samples at/after native submit call {trend['afterNativeSubmitCalls']}.", '',
                      f"Retained window: {row['window']['firstAfterMs']}–{row['window']['lastAfterMs']} ms ({row['window']['origin']}); dropped samples: {row['droppedSamples']}.", '',
                      f"Constant suffix: `{json.dumps(trend['constantSuffix'])}`. A short final plateau does not cancel earlier growth.", '',
                      f"Evidence issues: `{json.dumps(row['issues'])}`. Coverage notes: `{json.dumps(row['coverage']['notes'])}`.", '']
        for row in report['glContexts'] or []:
            lines += [f"### GL context {row['contextId']}", '',
                      f"Terminal fenceSync calls minus deleteSync calls: {row['terminal']['fenceSyncCallsMinusDeleteSyncCalls']}; retained range: {row['retainedCallDifferenceRange']}.", '',
                      f"Retained window: {row['window']['firstAfterMs']}–{row['window']['lastAfterMs']} ms ({row['window']['origin']}); dropped samples: {row['droppedSamples']}.", '',
                      'These are observed call differences, not identified live fences or proof of retirement. The report may end with the game still running; no queue drain is assumed.', '',
                      f"Evidence issues: `{json.dumps(row['issues'])}`. Coverage notes: `{json.dumps(row['coverage']['notes'])}`.", '']
    lines += ['Messages, stacks, raw pointers, account values and source paths are omitted. Publication hashes link the result to separately verified build provenance; this tool does not inspect executing byte identity.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', action='append', type=Path, required=True, help='Raw startup report.json; repeat for independent before/after reports.')
    parser.add_argument('--out', type=Path, required=True, help='New output directory; writes summary.json and summary.md.')
    parser.add_argument('--after-submit', type=int, default=0, help='Select capacity samples at/after this cumulative native submit-call count; default keeps the full retained window.')
    args = parser.parse_args()
    if not 0 <= args.after_submit < MAX_COUNTER:
        parser.error('--after-submit must be a nonnegative unsaturated counter')
    reports = []
    for index, path in enumerate(args.report, 1):
        try:
            payload = path.read_bytes()
            source = json.loads(payload)
            if not isinstance(source, dict):
                raise ValueError('report is not an object')
            reports.append(analyze(source, hashlib.sha256(payload).hexdigest(), args.after_submit))
        except (OSError, ValueError) as error:
            parser.exit(2, f'Report {index} could not be read as a JSON object ({type(error).__name__}).\n')
    result = {'schemaVersion': 'phone-lifetime-analysis/1', 'reports': reports}
    try:
        args.out.mkdir(parents=True, exist_ok=False)
        (args.out / 'summary.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
        (args.out / 'summary.md').write_text(markdown(result))
    except OSError as error:
        parser.exit(2, f'Cannot create a new output directory ({type(error).__name__}).\n')
    print(json.dumps({'reports': len(reports), 'files': ['summary.json', 'summary.md']}))


if __name__ == '__main__':
    main()
