import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Test instrumentation reads Renderer-owned allocations after completion. It
// never supplies a receiver, trace, history, pass or shader to the Renderer.
const output = resolve(process.argv[2] ?? 'artifacts/sponza-reconstruction');
const moving = process.argv.includes('--motion');
const reuseIndex = process.argv.indexOf('--reuse-raw');
const reuseRaw = reuseIndex < 0 ? undefined : resolve(process.argv[reuseIndex + 1]);
assert(process.env.FORGEAX_RASTER_CDP, 'A dedicated qualified browser is required');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.FORGEAX_RASTER_CDP);
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(240000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
});
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2));
await page.addInitScript(() => {
  const allocations = new Map();
  let device;
  const createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (descriptor) {
    const buffer = createBuffer.call(this, descriptor);
    if (
      descriptor.label === 'ray-path.accumulation' ||
      descriptor.label?.startsWith('ray-diffuse.')
    ) {
      allocations.set(descriptor.label, buffer);
      device = this;
    }
    return buffer;
  };
  window.__readDiffuseBuffers = async (names) => {
    if (!device) throw new Error('No Renderer diffuse allocation');
    const encoder = device.createCommandEncoder();
    const staging = [];
    try {
      for (const name of names) {
        const source = allocations.get(name);
        if (!source) throw new Error(`Missing ${name}`);
        const target = device.createBuffer({ size: source.size, usage: 9 });
        encoder.copyBufferToBuffer(source, 0, target, 0, source.size);
        staging.push([name, target]);
      }
      device.queue.submit([encoder.finish()]);
      const result = {};
      for (const [name, target] of staging) {
        await target.mapAsync(1);
        const bytes = new Uint8Array(target.getMappedRange());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        result[name] = btoa(binary);
      }
      return result;
    } finally {
      for (const [, target] of staging) target.destroy();
    }
  };
});
try {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(
    process.env.FORGEAX_RASTER_URL ?? 'http://127.0.0.1:8759/raster.html?resolution=128&surfaces=1',
  );
  await page.waitForFunction(() => window.__sponzaRaster || window.__sponzaRasterFailure);
  assert.equal(await page.evaluate(() => window.__sponzaRasterFailure), undefined);
  await page.evaluate(() => window.__sponzaRaster.warm());
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return {
      userAgent: navigator.userAgent,
      info: adapter?.info,
      timestampQuery: adapter?.features.has('timestamp-query'),
      scene: window.__sponzaRaster.inspect(),
    };
  });
  await save('environment.json', environment);
  if (reuseRaw !== undefined) {
    assert(
      !moving && !process.argv.includes('--quick'),
      'Raw reuse is for full quality comparisons',
    );
    const prior = JSON.parse(await readFile(resolve(reuseRaw, 'environment.json'), 'utf8'));
    for (const key of ['camera', 'width', 'height', 'light'])
      assert.deepEqual(
        JSON.parse(JSON.stringify(environment.scene[key])),
        prior.scene[key],
        `Reference ${key} must match`,
      );
    assert.equal(
      environment.scene.validationScene ?? 'sponza',
      prior.scene.validationScene ?? 'sponza',
    );
    await save('reused-raw.json', {
      source: reuseRaw,
      scope:
        'Previously measured raw streams; every new reconstructed raw frame must match in compare-reconstruction.mjs',
    });
  }
  const settings = {
    gather: 'exact',
    maxBounces: 1,
    maxDistance: 100,
    environment: [0.25, 0.3, 0.4],
    seed: 47,
  };
  // Independent raw reference streams never share the four trial seeds.
  const sequences = moving
    ? [{ mode: 'combined', seed: 47, frames: 64 }]
    : process.argv.includes('--quick')
      ? [{ mode: 'combined', seed: 47, frames: 24 }]
      : [
          { mode: 'raw', seed: 8009, frames: 512 },
          { mode: 'raw', seed: 16001, frames: 512 },
          ...[47, 2017, 4099, 65521].flatMap((seed) =>
            ['raw', 'spatial', 'temporal', 'combined'].map((mode) => ({ mode, seed, frames: 64 })),
          ),
        ];
  for (const sequence of sequences) {
    const name = `${sequence.mode}-${sequence.seed}`;
    const directory = resolve(output, name);
    if (reuseRaw !== undefined && sequence.mode === 'raw') {
      await cp(resolve(reuseRaw, name), directory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await cp(resolve(reuseRaw, `${name}.json`), resolve(output, `${name}.json`));
      console.log(`Reused measured ${name}; comparison requires exact raw agreement`);
      continue;
    }
    await mkdir(directory, { recursive: true });
    console.log(`Begin ${name}: ${sequence.frames} frames`);
    const ready = await page.evaluate(
      ({ settings, sequence }) =>
        window.__sponzaRaster.setDiffuseGi({
          ...settings,
          seed: sequence.seed,
          ...(sequence.mode === 'raw' ? {} : { reconstruction: sequence.mode }),
        }),
      { settings, sequence },
    );
    assert.equal(ready.diffuseGi.state, 'ready');
    assert.equal(
      ready.diffuseGi.submittedFrames,
      1,
      'All modes start at the same first raw sample',
    );
    const states = [];
    const poses = [];
    for (let frame = 1; frame <= sequence.frames; frame++) {
      if (moving && frame >= 17) {
        const side = frame <= 48 ? (frame - 16) * 0.02 : frame <= 56 ? 3 : 0;
        await page.evaluate((side) => window.__sponzaRaster.set({ side }), side);
      }
      const record = await page.evaluate(
        async ({ advance, reconstructed }) => {
          const host = window.__sponzaRaster;
          if (advance) {
            const renderer = host.app.renderer;
            let unsubscribe;
            const submitted = new Promise((resolve, reject) => {
              unsubscribe = renderer.subscribe((event) => {
                if (event.kind === 'frame-submitted') resolve(event.receipt);
                else if (event.kind === 'error') reject(event.error);
              });
            });
            try {
              host.app.stepFrame(1 / 60).unwrap();
              (await (await submitted).completed).unwrap();
            } finally {
              unsubscribe();
            }
          }
          const state = host.inspect();
          const buffers = await window.__readDiffuseBuffers([
            'ray-path.accumulation',
            ...(reconstructed
              ? [
                  'ray-diffuse.signal',
                  'ray-diffuse.diagnostics',
                  `ray-diffuse.history-${state.diffuseGi.submittedFrames % 2 === 1 ? 'a' : 'b'}`,
                ]
              : []),
          ]);
          return { state: state.diffuseGi, camera: state.camera, buffers };
        },
        { advance: frame > 1, reconstructed: sequence.mode !== 'raw' },
      );
      assert.equal(record.state.submittedFrames, frame, 'No hidden frame advances');
      assert.equal(
        record.state.generation,
        ready.diffuseGi.generation,
        'Static content stays in one generation',
      );
      for (const [label, data] of Object.entries(record.buffers)) {
        const bytes = Buffer.from(data, 'base64');
        const suffix =
          label === 'ray-path.accumulation' ? 'raw' : label.replace('ray-diffuse.', '');
        await writeFile(resolve(directory, `${frame}-${suffix}.bin`), bytes);
      }
      states.push(record.state);
      poses.push(record.camera);
      if (moving && [16, 17, 32, 48, 49, 56, 57, 64].includes(frame))
        await page.locator('#app').screenshot({ path: resolve(directory, `${frame}-canvas.png`) });
      if (frame % 32 === 0) console.log(`${name}: ${frame}/${sequence.frames}`);
    }
    await writeFile(resolve(directory, 'states.json'), JSON.stringify(states));
    await save(`${name}-poses.json`, poses);
    await page.screenshot({ path: resolve(directory, 'last-frame.png') });
    await page.locator('#app').screenshot({ path: resolve(directory, 'canvas.png') });
    await save(`${name}.json`, {
      ...sequence,
      width: ready.width,
      height: ready.height,
      complete: true,
    });
  }
  if (moving) {
    const frames = [];
    let previousIdentities = new Set();
    for (let frame = 1; frame <= 64; frame++) {
      const directory = resolve(output, 'combined-47');
      const h = await readFile(
        resolve(directory, `${frame}-history-${frame % 2 === 1 ? 'a' : 'b'}.bin`),
      );
      const d = await readFile(resolve(directory, `${frame}-diagnostics.bin`));
      const raw = await readFile(resolve(directory, `${frame}-raw.bin`));
      const identities = new Set();
      const facts = { frame, valid: 0, supported: 0, cold: 0, newlyVisibleIdentityPixels: 0 };
      for (let i = 0; i < h.length / 96; i++) {
        assert.equal(raw.readUInt32LE(i * 80 + 12), 1);
        assert.equal(raw.readUInt32LE(i * 80 + 28), 0);
        if (h.readUInt32LE(i * 96 + 72) !== 1) continue;
        const identity = h.subarray(i * 96 + 32, i * 96 + 64).toString('hex');
        identities.add(identity);
        facts.valid++;
        const mask = d.readUInt32LE(i * 16 + 4);
        const weight = h.readFloatLE(i * 96 + 12);
        assert(weight >= 1 && weight <= 16);
        if (mask === 0) {
          facts.cold++;
          assert.equal(weight, 1);
        } else facts.supported++;
        // Independent disocclusion oracle: no pixel in the previous image had
        // this stable object/material identity, so no historical tap can supply it.
        if (frame > 1 && !previousIdentities.has(identity)) {
          facts.newlyVisibleIdentityPixels++;
          assert.equal(mask, 0, 'A newly visible identity must not inherit another surface');
          assert.equal(weight, 1);
        }
      }
      if (frame > 1) assert(facts.supported > 0, 'Moving view must retain some compatible history');
      frames.push(facts);
      previousIdentities = identities;
    }
    const exposed = frames.some((frame) => frame.newlyVisibleIdentityPixels > 0);
    await save('motion.json', {
      status: exposed ? 'pass' : 'fail',
      frames,
      scope:
        'Translation/rotation and large moves; newly visible identity oracle, not a per-pixel ground-truth motion field',
    });
    assert(exposed, 'Movement must expose previously invisible identities');
  }
  assert.deepEqual(errors, []);
} finally {
  await save('errors.json', errors);
  await page.evaluate(() => window.__sponzaRaster?.dispose()).catch(() => {});
  await page.close();
  await browser.close();
}
