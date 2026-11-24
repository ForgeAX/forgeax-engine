import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNativeSponzaCapture,
  nativeSponzaCaptureBudgetsFromOptions,
} from "../native-sponza-capture.mjs";

test("maps bounded capture budget flags to RHI Debug byte limits", () => {
  const values = new Map([
    ["capture-rhi-byte-budget-mib", "1024"],
    ["capture-rhi-max-resource-mib", "128"],
  ]);
  const budgets = nativeSponzaCaptureBudgetsFromOptions(
    (name, fallback) => values.get(name) ?? fallback,
  );

  assert.deepEqual(budgets, {
    totalMiB: 1024,
    maxResourceMiB: 128,
    byteBudget: 1024 * 1024 * 1024,
    maxResourceBytes: 128 * 1024 * 1024,
  });
  assert.deepEqual(
    nativeSponzaCaptureBudgetsFromOptions((_name, fallback) => fallback),
    {
      totalMiB: 256,
      maxResourceMiB: 16,
      byteBudget: 256 * 1024 * 1024,
      maxResourceBytes: 16 * 1024 * 1024,
    },
  );
  const maximum = nativeSponzaCaptureBudgetsFromOptions((name, fallback) =>
    name === "capture-rhi-byte-budget-mib"
      ? "2048"
      : name === "capture-rhi-max-resource-mib"
        ? "1024"
        : fallback,
  );
  assert.deepEqual(maximum, {
    totalMiB: 2048,
    maxResourceMiB: 1024,
    byteBudget: 2048 * 1024 * 1024,
    maxResourceBytes: 1024 * 1024 * 1024,
  });
  for (const invalid of ["0", "-1", "1.5", "2049", "invalid"]) {
    assert.throws(
      () =>
        nativeSponzaCaptureBudgetsFromOptions((name, fallback) =>
          name === "capture-rhi-byte-budget-mib" ? invalid : fallback,
        ),
      /capture-rhi-byte-budget-mib must be an integer from 1 to 2048 MiB/,
    );
  }
  for (const invalid of ["0", "-1", "1.5", "1025", "invalid"]) {
    assert.throws(
      () =>
        nativeSponzaCaptureBudgetsFromOptions((name, fallback) =>
          name === "capture-rhi-max-resource-mib" ? invalid : fallback,
        ),
      /capture-rhi-max-resource-mib must be an integer from 1 to 1024 MiB/,
    );
  }
  assert.throws(
    () =>
      nativeSponzaCaptureBudgetsFromOptions((name, fallback) =>
        name === "capture-rhi-byte-budget-mib"
          ? "64"
          : name === "capture-rhi-max-resource-mib"
            ? "128"
            : fallback,
      ),
    /capture-rhi-max-resource-mib cannot exceed --capture-rhi-byte-budget-mib/,
  );
});

test("writes one exact RHI tape from the next completed Renderer frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeax-native-sponza-capture-"));
  const outputPath = join(directory, "frame.rhitape");
  const bytes = Uint8Array.from([0x46, 0x41, 0x58, 0x37]);
  const budgets = nativeSponzaCaptureBudgetsFromOptions((name, fallback) => {
    if (name === "capture-rhi-byte-budget-mib") return "2048";
    if (name === "capture-rhi-max-resource-mib") return "128";
    return fallback;
  });
  let captureOptions;
  let boundaryCount = 0;
  let resolveCapture;
  const recorder = {
    backend: { rhi: { identity: "recorded-rhi" } },
    captureFrame(options) {
      captureOptions = options;
      return new Promise((resolve) => {
        resolveCapture = resolve;
      });
    },
    async frameBoundary() {
      boundaryCount++;
      if (boundaryCount === 2) {
        resolveCapture({
          ok: true,
          value: { bytes, byteLength: bytes.byteLength, digest: "sha256:fixture" },
        });
      }
      return { ok: true };
    },
    async dispose() {
      return { ok: true };
    },
  };
  const capture = createNativeSponzaCapture(recorder, {
    outputPath,
    snapshotTimeoutMs: 30_000,
    byteBudget: budgets.byteBudget,
    maxResourceBytes: budgets.maxResourceBytes,
  });

  try {
    assert.equal(capture.rhi, recorder.backend.rhi);
    assert.equal(capture.idle, true);
    assert.deepEqual(capture.requestAfterCompletedFrame(100, "irradiance-field"), {
      status: "armed",
      requestedAfterFrameId: 100,
      requestedMode: "irradiance-field",
      outputPath,
      snapshotTimeoutMs: 30_000,
      byteBudget: 2048 * 1024 * 1024,
      byteBudgetMiB: 2048,
      maxResourceBytes: 128 * 1024 * 1024,
    });
    assert.deepEqual(captureOptions, {
      snapshotTimeoutMs: 30_000,
      byteBudget: 2048 * 1024 * 1024,
      seed: { maxResourceBytes: 128 * 1024 * 1024 },
    });
    assert.equal(capture.idle, false);
    assert.throws(() => capture.requestAfterCompletedFrame(101, "off"), /one-shot/);
    assert.deepEqual(await capture.beforeNextFrame(), {
      status: "recording",
      requestedAfterFrameId: 100,
      requestedMode: "irradiance-field",
    });
    assert.deepEqual(await capture.afterFrame(101, "irradiance-field"), {
      status: "captured",
      requestedAfterFrameId: 100,
      requestedMode: "irradiance-field",
      frameId: 101,
      mode: "irradiance-field",
      outputPath,
      byteLength: bytes.byteLength,
      digest: "sha256:fixture",
    });
    assert.deepEqual(await readFile(outputPath), Buffer.from(bytes));
    assert.equal(boundaryCount, 2);
    assert.equal(capture.idle, false);
    assert.deepEqual(await capture.dispose(), { status: "disposed" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports snapshot boundary errors without writing an artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeax-native-sponza-capture-fail-"));
  const outputPath = join(directory, "frame.rhitape");
  const recorder = {
    backend: { rhi: {} },
    captureFrame() {
      return Promise.resolve({ ok: false, error: { code: "capture-snapshot-failed" } });
    },
    async frameBoundary() {
      return { ok: false, error: { code: "capture-snapshot-failed" } };
    },
    async dispose() {
      return { ok: true };
    },
  };
  const capture = createNativeSponzaCapture(recorder, {
    outputPath,
    snapshotTimeoutMs: 30_000,
    byteBudget: 256 * 1024 * 1024,
    byteBudgetMiB: 256,
    maxResourceBytes: 16 * 1024 * 1024,
  });

  try {
    capture.requestAfterCompletedFrame(42, "screen-probe");
    assert.deepEqual(await capture.beforeNextFrame(), {
      status: "failed",
      stage: "snapshot",
      error: { code: "capture-snapshot-failed" },
      requestedAfterFrameId: 42,
      requestedMode: "screen-probe",
    });
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  } finally {
    await capture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
