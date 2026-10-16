import { color } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'sRGB / linear / hex color',
  catalog: 'Color conversion',
  kind: 'headless',
  summary:
    'color.srgbToLinear / linearToSrgb / fromHex / toHex are pure out-param conversions; hex strings are sRGB and parse into linear values.',
  expect:
    'All checks pass: mid-grey 0.5 sRGB is about 0.214 linear, round trips are stable, and hex parse/format round-trips.',
  run(checks) {
    const lin = color.srgbToLinear(color.create(), color.create(0.5, 0, 1, 1));
    checks.near('sRGB 0.5 -> linear 0.214', lin[0] as number, 0.21404, 1e-4);
    checks.near('0 stays 0', lin[1] as number, 0, 1e-7);
    checks.near('1 stays 1', lin[2] as number, 1, 1e-6);
    checks.near('alpha untouched', lin[3] as number, 1, 1e-7);
    const back = color.linearToSrgb(color.create(), lin);
    checks.near('round trip back to 0.5', back[0] as number, 0.5, 1e-4);
    const out = color.create();
    const returned = color.srgbToLinear(out, color.create(0.2, 0.2, 0.2, 1));
    checks.ok('out-param returned by identity', returned === out);

    const fromHex = color.fromHex(color.create(), '#ff8000');
    checks.near('hex red channel 1', fromHex[0] as number, 1, 1e-6);
    checks.near('hex 0x80 parsed as linear', fromHex[1] as number, 0.21586, 1e-3);
    checks.equal('toHex round trip', color.toHex(fromHex).toLowerCase(), '#ff8000');
    const invalid = color.fromHex(color.create(), 'not-a-color');
    checks.equal('invalid hex resets to opaque black', Array.from(invalid), [0, 0, 0, 1]);
  },
});
