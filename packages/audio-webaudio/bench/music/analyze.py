"""Plot retained native PCM and raw measurements without rerunning the backend."""
import argparse
import hashlib
import json
import struct
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def pcm(path):
    data = path.read_bytes()
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    offset, fmt, payload = 12, None, None
    while offset + 8 <= len(data):
        kind, size = struct.unpack_from("<4sI", data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", chunk)
        if kind == b"data":
            payload = chunk
        offset += 8 + size + (size % 2)
    assert fmt is not None and payload is not None and fmt[1] == 1
    assert (fmt[0], fmt[5]) in [(1, 16), (3, 32)]
    values = np.frombuffer(payload, dtype="<i2" if fmt[0] == 1 else "<f4")
    return fmt[2], values.astype(float) / (32768 if fmt[0] == 1 else 1)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("run", type=Path)
args = parser.parse_args()
root = args.run.resolve()
output = root / "analysis"
output.mkdir(exist_ok=True)
inputs = {}
metrics = {}


def read(name):
    path = root / name
    data = path.read_bytes()
    inputs[name] = hashlib.sha256(data).hexdigest()
    return json.loads(data)


def save(fig, name):
    fig.savefig(output / name, dpi=160, bbox_inches="tight")
    plt.close(fig)


audible = [root / f"listening-{label}.wav" for label in ["A-full", "B-disabled-melody"]]
if all(path.exists() for path in audible):
    fig, axes = plt.subplots(2, 2, figsize=(13, 7), constrained_layout=True)
    for index, path in enumerate(audible):
        rate, values = pcm(path)
        inputs[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        label = "A: four layers" if index == 0 else "B: melody disabled"
        time = np.arange(len(values)) / rate
        axes[index, 0].plot(time[::48], values[::48], linewidth=0.6)
        axes[index, 0].set(xlabel="Native audio seconds", ylabel="Amplitude", title=label, ylim=(-0.55, 0.55))
        for boundary in [2.02, 4.02, 6.02]:
            axes[index, 0].axvline(boundary, color="gray", linestyle="--", linewidth=0.6)
        _, _, _, spectrum = axes[index, 1].specgram(values, NFFT=2048, Fs=rate, noverlap=1536, scale="linear")
        spectrum.set_data(10 * np.log10(np.maximum(spectrum.get_array(), 1e-10)))
        spectrum.set_clim(-100, -20)
        fig.colorbar(spectrum, ax=axes[index, 1], label="PSD dB/Hz (display floor −100)")
        axes[index, 1].set(xlabel="Native audio seconds", ylabel="Hz", title=f"{label}: native PCM spectrum", ylim=(0, 2000))
        metrics[label] = {"frames": len(values), "rate": rate, "rms": float(np.sqrt(np.mean(values ** 2))), "peak": float(np.max(np.abs(values)))}
    save(fig, "native-listening-waveform-spectrum.png")

signals = [root / f"signal-{count}.json" for count in [1, 4, 16]]
if all(path.exists() for path in signals):
    fig, axes = plt.subplots(3, 2, figsize=(13, 9), constrained_layout=True)
    for index, path in enumerate(signals):
        row = read(path.name)
        raw = row["raw"]
        x = [item["expectedSample"] / 48000 for item in raw]
        error = [item["actualSample"] - item["expectedSample"] for item in raw]
        amplitude = [item["actualAmplitude"] - item["expectedAmplitude"] for item in raw]
        axes[index, 0].scatter(x, error, s=5, color=f"C{index}")
        axes[index, 1].scatter(x, amplitude, s=5, color=f"C{index}")
        for boundary in [-1, 1]:
            axes[index, 0].axhline(boundary, color="red", linestyle="--", linewidth=0.7)
        for boundary in [-1e-6, 1e-6]:
            axes[index, 1].axhline(boundary, color="red", linestyle="--", linewidth=0.7)
        axes[index, 0].set(xlabel="Expected native audio seconds", ylabel="Actual − expected samples", ylim=(-1.5, 1.5), title=f'{row["count"]} stems: {len(raw)} native impulse observations')
        axes[index, 1].set(xlabel="Expected native audio seconds", ylabel="Amplitude error", ylim=(-1.5e-6, 1.5e-6), title="Native envelopes against independently decoded input")
        metrics[path.stem] = {"samples": len(raw), "maximumSampleError": max(map(abs, error)), "maximumAmplitudeError": max(map(abs, amplitude)), "recordedPass": row["pass"]}
    save(fig, "native-onset-and-envelope-errors.png")

costs = sorted(root.glob("performance-*.json"))
if costs:
    fig, axes = plt.subplots(1, 3, figsize=(14, 5), constrained_layout=True)
    rows = [read(path.name) for path in costs]
    labels = [f'{row["stems"]}/{row["pending"]}/r{row["round"]}' for row in rows]
    x = np.arange(len(rows))
    for axis, kind in zip(axes[:2], ["schedule", "cancel"]):
        quantiles = [np.quantile(row[kind]["raw"], [0.5, 0.95], method="lower") for row in rows]
        axis.plot(x, [value[0] for value in quantiles], label="p50")
        axis.plot(x, [value[1] for value in quantiles], label="p95")
        axis.axhline(2, color="red", linestyle="--", label="Frozen 2ms budget")
        axis.set(title=kind, ylabel="Native Host CPU ms")
        axis.legend()
    axes[2].plot(x, [row["coldMs"] for row in rows])
    axes[2].axhline(1000, color="red", linestyle="--")
    axes[2].set(title="Fresh Catalog/Host cache preload", ylabel="ms")
    for axis in axes:
        axis.set_xticks(x, labels, rotation=90, fontsize=5)
        axis.set_xlabel("stems / pending / interleaved round")
    metrics["performance"] = {"rows": len(rows), "allRecordedBudgetsPassed": all(row["pass"] for row in rows), "scope": "Raw diagnostics; clean performance additionally requires the run's quiet-admission receipt"}
    save(fig, "native-control-costs.png")

receipt = {"inputSha256": inputs, "metrics": metrics, "versions": {"numpy": np.__version__, "matplotlib": matplotlib.__version__}, "figures": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in output.glob("*.png")}, "scope": "Analysis of retained native samples; no new runtime, audition or clean-performance claim"}
(output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"output": str(output), "figures": list(receipt["figures"])}))
