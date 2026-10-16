"""Decode the production motion fixture's same-generation RHI Debug readbacks."""
import argparse
import collections
import hashlib
import json
import math
import struct
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path, help='motion-replay directory containing report.json')
parser.add_argument('--producer-head', required=True)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
report = json.loads((args.directory / 'report.json').read_text())
frames = {}
inputs = []
for frame in report['frames']:
    assert not frame.get('failure') and not frame['errors'], frame
    reads = {}
    generations = set()
    for read in frame['reads']:
        assert 'error' not in read, read
        blob = (args.directory / read['file']).read_bytes()
        digest = hashlib.sha256(blob).hexdigest()
        assert digest == read['sha256'] and len(blob) == read['byteLength'], read
        generations.add(read['provenance']['generation'])
        reads[(read['entry'], read['binding'])] = blob
        inputs.append({'file': read['file'], 'bytes': len(blob), 'sha256': digest})
    assert len(generations) == 1, generations
    integration = reads[('integrateScreenProbes', 20)]
    current = reads[('temporalScreenProbes', 21)]
    assert integration == current, 'integration output differs from temporal input'
    frame_words = struct.unpack('<44I', reads[('temporalScreenProbes', 0)])
    width, height = frame_words[:2]
    signals = {}
    for binding in [21, 22, 23]:
        blob = reads[('temporalScreenProbes', binding)]
        assert len(blob) == width * height * 16
        signals[binding] = list(struct.iter_unpack('<4f', blob))
        assert all(math.isfinite(v) for record in signals[binding] for v in record)
    ages = [v[2] for v in struct.iter_unpack('<4I', reads[('temporalScreenProbes', 25)])]
    frames[frame['mode']] = {'signals': signals, 'ages': ages, 'reads': reads, 'width': width, 'height': height,
                             'generation': next(iter(generations)), 'adapterInfo': frame['adapterInfo']}
first, converged = frames['first'], frames['converged']
assert first['width'] == first['height'] == 32, 'decoder geometry belongs to the unchanged 32x32 motion fixture'
width = first['width']
shift = 1 / (math.tan(math.pi / 6) * 2.875)
def reprojectable(index):
    nx = ((index % width) + 0.5) / (width / 2) - 1 + 0.6 * shift
    ny = 1 - (index // width + 0.5) / (width / 2) + 0.3 * shift
    return abs(nx) < 1 and abs(ny) < 1
regions = {}
for name, predicate in [('all', lambda i: True), ('reprojectable', reprojectable), ('disoccluded', lambda i: not reprojectable(i))]:
    indices = [i for i in range(width * width) if predicate(i)]
    def same(i):
        a = first['reads'][('temporalScreenProbes', 21)]
        b = first['reads'][('temporalScreenProbes', 23)]
        return a[i * 16:(i + 1) * 16] == b[i * 16:(i + 1) * 16]
    regions[name] = {
        'pixels': len(indices), 'firstOutputEqualsCurrentPixels': sum(same(i) for i in indices),
        'firstAge1Pixels': sum(first['ages'][i] == 1 for i in indices),
        'currentDvsConvergedOutputMAE': sum(abs(first['signals'][21][i][0] - converged['signals'][23][i][0]) for i in indices) / len(indices),
        'firstOutputDvsConvergedOutputMAE': sum(abs(first['signals'][23][i][0] - converged['signals'][23][i][0]) for i in indices) / len(indices),
    }
output = {
    'head': args.producer_head,
    'qualification': 'SHA-verified production motion per-work readbacks, not full-scene quality or physical-performance acceptance. D is not material-shaded HDR. Masks use the original fixture camera displacement, wall plane and FOV.',
    'integrationOutputEqualsTemporalInput': True,
    'verifiedReads': len(inputs),
    'frames': {mode: {
        'adapterInfo': frame['adapterInfo'], 'generation': frame['generation'],
        'means': {binding: [sum(row[c] for row in values) / len(values) for c in range(4)] for binding, values in frame['signals'].items()},
        'ageHistogram': dict(collections.Counter(frame['ages'])), 'nonfinite': 0,
    } for mode, frame in frames.items()},
    'regions': regions, 'inputs': inputs,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps({'producer': args.producer_head, 'reads': len(inputs), 'regions': regions}))
