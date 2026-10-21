import assert from 'node:assert/strict';
import test from 'node:test';
import { colorHex, hsvToRgb, parseColorHex, previewColor, previewGradient, rgbToHsv, roundColorValue, toColorValue } from '../packages/view-components/src/color-picker-model.ts';
import { addColorToTheme, createColorTheme, deleteColorTheme, duplicateColorTheme, getColorPickerPalettes,
  recordRecentColor, renameColorTheme, selectColorTheme } from '../packages/view-components/src/color-picker-palettes.ts';

test('linear Pack color displays as sRGB hex and parses back', () => {
  const source = toColorValue([1, 0.913, 0.832, 0.5]);
  const hex = colorHex(source);
  assert.equal(hex.slice(0, 2), 'FF');
  assert.equal(hex.slice(6), '80');
  const parsed = parseColorHex(hex);
  assert.ok(parsed);
  parsed.forEach((channel, index) => assert.ok(Math.abs(channel - source[index]) < 0.004));
  assert.equal(parseColorHex('invalid'), null);
});

test('HSV editor preserves normalized linear RGB and alpha separately', () => {
  const color = toColorValue([1, 0.913, 0.832, 0.4]);
  const [hue, saturation, value] = rgbToHsv(color);
  assert.ok(Math.abs(hue - 28.93) < 0.1);
  assert.ok(Math.abs(saturation - 0.168) < 0.001);
  const rgb = hsvToRgb(hue, saturation, value);
  rgb.forEach((channel, index) => assert.ok(Math.abs(channel - color[index]) < 0.0001));
  assert.equal(color[3], 0.4);
});

test('confirmed color matches the three-decimal channel display', () => {
  const selected = [...hsvToRgb(338.639, 0.459, 0.9), 0.3333333333333333];
  assert.deepEqual(roundColorValue(selected), [0.9, 0.487, 0.634, 0.333]);
});

test('sRGB preview encodes intermediate gradient colors without changing the linear value', () => {
  const linear = [0.418, 0.413, 1, 1];
  const sample = position => [linear[0] * position, linear[1] * position, position, 1];
  const encoded = previewGradient('to top', sample, true);
  const unencoded = previewGradient('to top', sample, false);
  assert.ok(encoded.includes(`${previewColor(sample(0.5), true)} 50%`));
  assert.ok(unencoded.includes(`${previewColor(sample(0.5), false)} 50%`));
  assert.notEqual(encoded, unencoded);
  assert.deepEqual(linear, [0.418, 0.413, 1, 1]);
});

test('shortcut color themes retain independent swatches and recent selections', () => {
  const stored = new Map();
  globalThis.window = { localStorage: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  } };
  try {
    const aqua = toColorValue([0, 1, 1, 1]);
    const red = toColorValue([1, 0, 0, 1]);
    const first = createColorTheme();
    assert.ok(first);
    addColorToTheme(first, aqua);
    addColorToTheme(first, aqua);
    assert.deepEqual(getColorPickerPalettes().themes[0].colors, [aqua]);

    const second = duplicateColorTheme(first);
    assert.ok(second);
    renameColorTheme(second, 'Accents');
    addColorToTheme(second, red);
    assert.equal(getColorPickerPalettes().selectedThemeId, second);
    assert.deepEqual(getColorPickerPalettes().themes[0].colors, [aqua]);
    assert.deepEqual(getColorPickerPalettes().themes[1].colors, [aqua, red]);

    selectColorTheme(first);
    assert.equal(getColorPickerPalettes().selectedThemeId, first);
    deleteColorTheme(first);
    assert.equal(getColorPickerPalettes().selectedThemeId, null);
    recordRecentColor(red);
    recordRecentColor(aqua);
    assert.deepEqual(getColorPickerPalettes().recent, [aqua, red]);
    assert.equal(getColorPickerPalettes().themes[0].name, 'Accents');
    assert.ok(stored.size > 0);
  } finally {
    delete globalThis.window;
  }
});
