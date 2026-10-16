"""Attribute the existing real-UI runner's CDP sample without timing GPU work."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('run', type=Path)
args = parser.parse_args()
profile_path = args.run / 'profile.cpuprofile'
profile = json.loads(profile_path.read_text())
if len(profile.get('samples', [])) != len(profile.get('timeDeltas', [])):
    parser.error('CPU profile samples and time deltas differ in length')
if not profile.get('samples'):
    parser.error('CPU profile contains no samples')
result = json.loads((args.run / 'result.json').read_text())
nodes = {row['id']: row for row in profile['nodes']}
parents = {child: row['id'] for row in profile['nodes'] for child in row.get('children', [])}
weights = collections.Counter()
for node, delta in zip(profile['samples'], profile['timeDeltas']):
    weights[node] += delta

categories = collections.Counter()
contexts = collections.Counter()
symbols = collections.Counter()
totals = collections.Counter()
frame_stages = collections.defaultdict(collections.Counter)
stacks = []
for node, weight in weights.items():
    ids = [node]
    while ids[-1] in parents:
        ids.append(parents[ids[-1]])
    names = [nodes[key]['callFrame']['functionName'] for key in ids]
    text = '\n'.join(names)
    frame = nodes[node]['callFrame']
    # Native paint_gpu begins after JS paintGpu has collected wrappers and may
    # have resolved layout. Keep whole caller stages separate from that narrower
    # denominator so moving resolution out of input does not look like a saving.
    callers = {
        nodes[key]['callFrame']['functionName'] for key in ids
        if nodes[key]['callFrame']['url'].endswith('/browser.bundle.js')
    }
    stage = 'input' if 'pointer' in callers else 'paintGpu' if 'paintGpu' in callers else None
    if stage:
        frame_stages[stage]['totalMs'] += weight / 1000
        if 'UiDocument>::resolve' in text:
            frame_stages[stage]['documentResolveMs'] += weight / 1000
        if 'UiDocument>::scroll_by_user' in text:
            frame_stages[stage]['scrollByUserMs'] += weight / 1000
        if 'collect' in callers:
            frame_stages[stage]['collectMs'] += weight / 1000
    ui_wasm = 'forgeax_ui_blitz' in frame['url']
    in_paint = bool(re.search(r'UiDocument>::paint_gpu|^uidocument_paint_gpu$', text, re.M))
    if ui_wasm:
        totals['allUiWasmSelfUs'] += weight
        symbols[frame['functionName']] += weight
    if not in_paint:
        if ui_wasm:
            totals['uiWasmOutsideConfirmedPaintUs'] += weight
        continue
    totals['confirmedPaintWithJsSerializationUs'] += weight
    if ui_wasm:
        totals['confirmedPaintWasmSelfUs'] += weight
    # Use real call ancestry, not the names of generic type arguments. Layout
    # types also occur inside glyph-run signatures and do not imply layout work.
    if re.search(r'vello_common.*(?:strip::render|strip_generator|flatten::)', text):
        category = 'strip_generation'
        owner = next((name for name in names if 'GpuPainter as anyrender' in name), '')
        method = re.search(r'PaintScene>::([a-z_]+)', owner)
        context = method.group(1) if method else 'unattributed'
        if context in ('fill', 'stroke', 'push_clip_layer'):
            context += ':rect' if '::rect::Rect>' in owner else ':rounded-rect' if '::rounded_rect::RoundedRect>' in owner else ':path'
        contexts[context] += weight
    elif re.search(r'serde_wasm_bindgen|serde.*serialize|portable.*Serialize', text):
        category = 'abi_serialization'
    elif re.search(r'BaseDocument>::resolve|UiDocument>::resolve|BaseDocument>::(?:compute_layout|resolve_layout)', text):
        category = 'document_resolve'
    elif any(re.match(r'<?(?:glifo|skrifa|read_fonts)\[', name) for name in names):
        category = 'glyph_prepare_excluding_strips'
    elif re.search(r'vello_gpu.*(?:portable|schedule|gradient_cache)', text):
        category = 'portable_schedule_pack'
    elif re.search(r'blitz_paint|GpuPainter|paint_scene', text):
        category = 'scene_conversion_excluding_above'
    else:
        category = 'paint_other'
    categories[category] += weight
    stacks.append({'node': node, 'selfUs': weight, 'category': category, 'stack': names})

measured = result['facts']['performance']
cpu_keys = ['inputMs', 'paintGpuMs', 'prepareMs', 'encodeMs', 'submitCpuMs']
combined = sorted(row['inputMs'] + row['paintGpuMs'] for row in measured['receipts'])
if len(combined) != measured['frames'] or not combined:
    parser.error('Completed-frame count differs from per-frame CPU receipts')
summary = {
    'kind': 'real-ui-cpu-attribution',
    'scope': 'Instrumented CPU attribution only; no exclusive GPU-time or uninstrumented FPS claim.',
    'paintAttribution': 'available' if totals['confirmedPaintWithJsSerializationUs'] else 'unavailable',
    'profileSha256': hashlib.sha256(profile_path.read_bytes()).hexdigest(),
    'wasm': result['inputs']['workloadIdentity']['uiWasm'],
    'nativeSourceDigest': result['inputs']['kernel']['sourceDigest'],
    'backend': result['backend'],
    'driver': result['facts'].get('webgl'),
    'profileDurationMs': (profile['endTime'] - profile['startTime']) / 1000,
    'sampleCount': len(profile['samples']),
    'scopeTotalsMs': {key.removesuffix('Us') + 'Ms': value / 1000 for key, value in totals.items()},
    'frameStageSamples': {
        'scope': 'Inclusive JS input/paintGpu ancestry; child costs overlap their total. Includes warmup and the GL observation.',
        'stages': {key: dict(value) for key, value in frame_stages.items()},
    },
    'paintCategories': {
        key: {'ms': value / 1000, 'shareOfConfirmedPaint': value / totals['confirmedPaintWithJsSerializationUs']}
        for key, value in categories.items()
    },
    'stripContextsMs': {key: value / 1000 for key, value in contexts.items()},
    'topUiSelfSymbols': [{'ms': value / 1000, 'symbol': key} for key, value in symbols.most_common(16)],
    'reportedCpuStages': {
        **{key: measured[key] for key in cpu_keys},
        'inputPlusPaintMs': {
            'count': len(combined),
            'median': statistics.median(combined),
            'mean': statistics.mean(combined),
            'p95': combined[math.ceil(len(combined) * .95) - 1],
            'max': max(combined),
            'percentile': 'nearest rank',
        },
    },
    'completedFrames': measured['frames'],
    'changedIntents': measured['movementIntentCount'],
    'cpuPixelComparisons': result['facts']['phases'],
    'limitations': [
        'Profiler spans the unchanged performance method, including its existing warmup and one GL observation.',
        'The three correctness captures and CPU oracle are before profiling; the measured loop has 60 dynamic GPU submissions.',
        'Only confirmed paint_gpu ancestry is assigned to paint stages. Lost ancestors and input work stay outside that denominator.',
        'Whole JS input/paintGpu samples include native resolution outside paint_gpu. Compare their per-frame sum before claiming less CPU work.',
        'The (program) samples are unclassified engine/host time, not exclusive GPU execution or active UI CPU.',
        'Inlining and 1 ms sampling affect small-stage attribution. Compare per-frame paintGpu timing as well as samples.',
    ],
}
(args.run / 'cpu-attribution.json').write_text(json.dumps(summary, indent=2) + '\n')
(args.run / 'paint-sample-stacks.json').write_text(json.dumps(sorted(stacks, key=lambda row: -row['selfUs']), indent=2) + '\n')
print(json.dumps({'run': str(args.run), 'inputPlusPaint': summary['reportedCpuStages']['inputPlusPaintMs'], 'paintGpu': measured['paintGpuMs'], 'categories': summary['paintCategories']}, indent=2))
