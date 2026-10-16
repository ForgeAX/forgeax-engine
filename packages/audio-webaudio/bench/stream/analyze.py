"""Analyze native captures; retain raw counters separately from process RSS."""
import csv
import json
import wave
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'artifacts/audio-stream'
REPORT = json.loads((OUT / 'performance.json').read_text())
assert len(REPORT['runs']) == 18 and len(REPORT['fullDecodeFalsifier']) == 2
MIB = 1024 * 1024


def percentile(values, p):
    return float(np.percentile(values, p)) if values else None


def cpu_seconds(value):
    minutes, seconds = value.split(':')
    return int(minutes) * 60 + float(seconds)


summary = {'hardware': REPORT['hardware'], 'browser': REPORT['browser'],
           'fixtures': REPORT['fixtures'], 'groups': [], 'runs': [],
           'signals': REPORT['signals'], 'fullDecodeFalsifier': REPORT['fullDecodeFalsifier'],
           'sourceHashes': REPORT['sourceHashes']}
summary['metadataAccounting'] = []
for minutes in [10, 60]:
    run = next(r for r in REPORT['runs'] if r['label'] == f'{minutes}m-main-serial-1-r1')
    idle = [s['audio']['streaming']['pendingBytes'] for s in run['states']
            if s['audio']['streaming']['pendingReads'] == 0]
    summary['metadataAccounting'].append({'minutes': minutes,
        'perPlayerReservedIndexBytes': min(idle),
        'hostRetainedSourceIndexBytes': min(idle),
        'producerPublicationIndexBytes': min(idle),
        'definition': 'Conservative UTF-16 JSON accounting, not native object heap size. Host source cache is separate from streaming counters; producer publication is independently bounded.'})
memory_rows = []
for run in REPORT['runs']:
    label = run['label']
    assert not run['errors'], (label, run['errors'])
    stopped = run['stopped']['streaming']
    assert run['stopped']['activeSourceCount'] == 0 and all(v == 0 for v in stopped.values()), label
    assert not run['controls'] or run['controls']['pauseDrift'] == 0, label
    samples = [row for row in REPORT['memory'] if row['label'].startswith(label + '-')]
    play = [row for row in samples if '-play-' in row['label']]
    assert len(play) == 100, label
    cold, released = samples[0], samples[-1]
    first_cpu = {row['pid']: cpu_seconds(row['cpuTime']) for row in play[0]['processes']}
    last_cpu = {row['pid']: cpu_seconds(row['cpuTime']) for row in play[-1]['processes']}
    cpu_delta = sum(last_cpu[pid] - first_cpu[pid] for pid in first_cpu.keys() & last_cpu.keys())
    seconds = (play[-1]['at'] - play[0]['at']) / 1000
    states = [row['audio']['streaming'] for row in run['states']]
    retained = [s['encodedBytes'] + s['pcmBytes'] + s['pendingBytes'] for s in states]
    assert max(retained) <= 64 * MIB, label
    assert max(s['pendingReads'] for s in states) <= 8, label
    assert max(s['underruns'] for s in states) == 0, label
    row = {'label': label, 'seconds': seconds, 'coldRssMiB': cold['aggregateRssKiB'] / 1024,
           'peakRssMiB': max(s['aggregateRssKiB'] for s in samples) / 1024,
           'releaseRssMiB': released['aggregateRssKiB'] / 1024,
           'playCpuSecondsCommonPids': cpu_delta, 'cpuCoreEquivalents': cpu_delta / seconds,
           'enginePeakMiB': max(retained) / MIB,
           'loadAverageRange': [min(s['loadAverage'][0] for s in samples), max(s['loadAverage'][0] for s in samples)]}
    summary['runs'].append(row)
    for sample in samples:
        memory_rows.append({'label': sample['label'], 'epochMs': sample['at'],
                            'relativeSeconds': (sample['at'] - cold['at']) / 1000,
                            'aggregateRssMiB': sample['aggregateRssKiB'] / 1024,
                            'loadAverage1m': sample['loadAverage'][0]})

for group in dict.fromkeys(run['label'].rsplit('-r', 1)[0] for run in REPORT['runs']):
    runs = [r for r in REPORT['runs'] if r['label'].rsplit('-r', 1)[0] == group]
    cold = [r['start']['firstOutputMs'] for r in runs]
    hot = [h['firstOutputMs'] for r in runs for h in r['hot']]
    seeks = [s['latencyMs'] for r in runs if r['controls'] for s in r['controls']['seeks']]
    measured = [r for r in summary['runs'] if r['label'].rsplit('-r', 1)[0] == group]
    summary['groups'].append({'group': group, 'rounds': len(runs),
        'coldOutputMsP50': percentile(cold, 50), 'coldOutputMsRange': [min(cold), max(cold)],
        'hotOutputMsP50': percentile(hot, 50), 'hotOutputMsP95': percentile(hot, 95),
        'seekMsP50': percentile(seeks, 50), 'seekMsP95': percentile(seeks, 95), 'seekCount': len(seeks),
        'enginePeakMiB': max(r['enginePeakMiB'] for r in measured),
        'rssPeakMiBRange': [min(r['peakRssMiB'] for r in measured), max(r['peakRssMiB'] for r in measured)],
        'cpuCoreEquivalentsRange': [min(r['cpuCoreEquivalents'] for r in measured), max(r['cpuCoreEquivalents'] for r in measured)]})

signals = {r['variant']: r for r in REPORT['signals']}
assert signals['pre']['builds'] == signals['post']['builds'] == 1
assert signals['pre']['hz440'] > signals['post']['hz440'] > signals['no-send']['hz440']
assert signals['pre']['hz8000'] < signals['no-effect']['hz8000'] * 0.4
assert abs(signals['dry']['rms'] - signals['no-effect']['rms']) < 1e-7
assert abs(signals['no-send']['rms'] - 0.0625) < 1e-6

fig, axes = plt.subplots(1, 3, figsize=(15, 4))
for name in signals:
    with wave.open(str(OUT / f'bus-{name}.wav')) as wav:
        rate = wav.getframerate()
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(float) / 32768
    axes[0].plot(np.arange(480) / rate * 1000, data[9600:10080], label=name, linewidth=1)
axes[0].set(xlabel='Time (ms)', ylabel='Native output amplitude', title='8 voices / one shared bus effect')
positions = np.arange(2)
for index, name in enumerate(signals):
    values = [signals[name]['hz440'], signals[name]['hz8000']]
    axes[1].bar(positions + (index - 2) * 0.15, 20 * np.log10(values), width=0.14, label=name)
axes[1].set_xticks(positions, ['440 Hz', '8 kHz'])
axes[1].set(ylabel='Tone magnitude (dBFS)', ylim=(-30, 0), title='Measured tone amplitudes')
axes[1].legend(fontsize=8)
axes[2].bar(list(signals), [signals[n]['rms'] for n in signals])
axes[2].set(ylabel='Native output RMS', title='Send / effect falsifiers')
axes[0].legend(fontsize=8)
fig.tight_layout(); fig.savefig(OUT / 'bus-output.png', dpi=170); plt.close(fig)

fig, axes = plt.subplots(1, len(signals), figsize=(15, 3), sharey=True)
for ax, name in zip(axes, signals):
    with wave.open(str(OUT / f'bus-{name}.wav')) as wav:
        rate = wav.getframerate()
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(float) / 32768
    segment = data[9600:38400]
    window = np.hanning(len(segment))
    spectrum = np.abs(np.fft.rfft(segment * window)) * 2 / window.sum()
    ax.plot(np.fft.rfftfreq(len(segment), 1 / rate), 20 * np.log10(np.maximum(spectrum, 1e-8)))
    ax.set(xlabel='Frequency (Hz)', xlim=(100, 10000), ylim=(-110, 0), title=name)
    ax.set_xscale('log'); ax.grid(alpha=0.2)
axes[0].set_ylabel('Native captured spectrum (dBFS)')
fig.tight_layout(); fig.savefig(OUT / 'bus-spectrum.png', dpi=170); plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(12, 4))
for minutes in [10, 60]:
    label = f'{minutes}m-main-serial-1-r1'
    rows = [r for r in memory_rows if r['label'].startswith(label + '-')]
    axes[0].plot([r['relativeSeconds'] for r in rows], [r['aggregateRssMiB'] for r in rows], label=f'{minutes}m streamed, one source')
    baseline = [r for r in REPORT['memory'] if r['label'].startswith(f'full-{minutes}-')]
    axes[1].plot([(r['at'] - baseline[0]['at']) / 1000 for r in baseline], [r['aggregateRssKiB'] / 1024 for r in baseline], marker='.', label=f'{minutes}m whole decode')
axes[0].set(title='Streamed playback (cold / play / release)', xlabel='Elapsed seconds', ylabel='Summed Chrome process RSS (MiB)')
axes[1].set(title='Negative baseline: full fetch + decodeAudioData', xlabel='Elapsed seconds', ylabel='Summed Chrome process RSS (MiB)')
for ax in axes: ax.legend(fontsize=8); ax.grid(alpha=0.2)
fig.tight_layout(); fig.savefig(OUT / 'native-memory.png', dpi=170); plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(12, 4))
names = [r['group'] for r in summary['groups']]
x = np.arange(len(names))
axes[0].bar(x - 0.16, [r['coldOutputMsP50'] for r in summary['groups']], width=0.32, label='Cold p50 (3 runs)')
axes[0].bar(x + 0.16, [r['hotOutputMsP50'] for r in summary['groups']], width=0.32, label='Hot p50 (9 runs)')
axes[1].bar(x - 0.16, [r['seekMsP50'] or 0 for r in summary['groups']], width=0.32, label='Seek p50')
axes[1].bar(x + 0.16, [r['seekMsP95'] or 0 for r in summary['groups']], width=0.32, label='Seek p95 (24 seeks/group)')
for ax in axes:
    ax.set_xticks(x, names, rotation=25, ha='right', fontsize=8)
    ax.set_ylabel('Milliseconds'); ax.legend(fontsize=8); ax.grid(axis='y', alpha=0.2)
axes[0].set_title('First native nonzero output (not all voices ready)')
axes[1].set_title('Seek accepted and native segment scheduled')
fig.tight_layout(); fig.savefig(OUT / 'latencies.png', dpi=170); plt.close(fig)

growth = json.loads((OUT / 'bus-growth.json').read_text())
assert len(growth['runs']) == 9
growth_summary = []
fig, axes = plt.subplots(1, 3, figsize=(14, 4))
for voices, destinations in [(1, 1), (8, 4), (32, 16)]:
    runs = [r for r in growth['runs'] if r['voices'] == voices]
    updates = [v for r in runs for v in r['updatesMs']]
    assert len(updates) == 90
    for run in runs:
        assert run['buildsAfterFirstPlay'] == destinations
        assert run['buildsAfterUpdates'] == destinations * 31
        assert abs(run['outputRms'] - signals['pre']['rms']) < 1e-5
    samples = [s for s in growth['memory'] if any(s['label'].startswith(r['label'] + '-') for r in runs)]
    row = {'voices': voices, 'sharedChains': destinations, 'buses': runs[0]['buses'],
           'sends': runs[0]['sends'], 'updates': len(updates),
           'updateMsP50': percentile(updates, 50), 'updateMsP95': percentile(updates, 95),
           'peakChromeRssMiB': max(s['aggregateRssKiB'] for s in samples) / 1024,
           'outputRmsRange': [min(r['outputRms'] for r in runs), max(r['outputRms'] for r in runs)]}
    growth_summary.append(row)
    sample = [s for s in growth['memory'] if s['label'].startswith(runs[0]['label'] + '-')]
    axes[2].plot([(s['at'] - sample[0]['at']) / 1000 for s in sample],
                 [s['aggregateRssKiB'] / 1024 for s in sample], label=f'{voices} voices / {destinations} FX')
names = [f"{r['voices']} voices\n{r['buses']} buses / {r['sends']} sends" for r in growth_summary]
x = np.arange(3)
axes[0].bar(x - .16, [r['updateMsP50'] for r in growth_summary], .32, label='p50')
axes[0].bar(x + .16, [r['updateMsP95'] for r in growth_summary], .32, label='p95')
axes[0].set_xticks(x, names, fontsize=8); axes[0].set(ylabel='Milliseconds', title='Atomic native graph replacement (90/group)')
axes[0].legend()
axes[1].bar(x, [r['sharedChains'] for r in growth_summary]); axes[1].set_xticks(x, names, fontsize=8)
axes[1].set(ylabel='Native effect chains', title='One effect chain per declared destination')
axes[2].set(xlabel='Seconds (cold / updates / release)', ylabel='Summed Chrome process RSS (MiB)', title='Native graph growth, first round')
axes[2].legend(fontsize=8)
fig.tight_layout(); fig.savefig(OUT / 'bus-growth.png', dpi=170); plt.close(fig)
summary['busGrowth'] = growth_summary
with (OUT / 'bus-growth-summary.csv').open('w') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(growth_summary[0]))
    writer.writeheader(); writer.writerows(growth_summary)

with (OUT / 'memory.csv').open('w') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(memory_rows[0]))
    writer.writeheader(); writer.writerows(memory_rows)
with (OUT / 'summary.csv').open('w') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(summary['groups'][0]))
    writer.writeheader(); writer.writerows(summary['groups'])
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary['groups'], indent=2))
