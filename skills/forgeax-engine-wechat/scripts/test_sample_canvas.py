#!/usr/bin/env python3
"""Offline checks for bounded pixel admission, PNG orientation and paired evidence."""
import base64
import contextlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib
sys.dont_write_bytecode = True

from sample_canvas import png_bytes, read_result, reader_source, sample, save_pixels
from wechatide import ToolFailure


def envelope(value):
    return {'ok': True, 'result': {'success': True, 'result': value}}


def captured():
    return {'status': 'captured', 'bindingsRestored': True, 'pixels': [
        {'name': name, 'width': 1, 'height': 2, 'rowOrder': 'bottom-to-top',
         'rgbaBase64': base64.b64encode(bytes([255, 0, 0, 255, 0, 255, 0, 255])).decode()}
        for name in ('region', 'positive-control')]}


class CanvasSampleTests(unittest.TestCase):
    def test_region_bound_and_literal_selector(self):
        selector = 'button[data-label="\u4e2d\u6587`$()"]'
        source = reader_source([0, 0, 256, 12], selector)
        self.assertTrue(source.endswith(json.dumps({'region': [0, 0, 256, 12], 'selector': selector}, ensure_ascii=True) + '); }'))
        for region in ([0, 0, 3073, 1], [-1, 0, 1, 1], [0, 0, 1, 0], [0, 0, True, 1], [0, 0, 1]):
            with self.subTest(region=region), self.assertRaises(ToolFailure):
                reader_source(region, '.control')

    def test_pending_and_nested_failures_cannot_become_capture(self):
        self.assertEqual(read_result(envelope(captured()), 0), captured())
        for response, status in [(None, 0), (envelope(captured()), 3),
                                 ({'ok': True, 'result': {'success': True, 'status': 'pending'}}, 0),
                                 ({'ok': False, 'result': {'success': True, 'result': captured()}}, 0),
                                 (envelope({}), 0)]:
            with self.subTest(response=response), self.assertRaises(ToolFailure):
                read_result(response, status)

    def test_png_pixels_are_flipped_to_top_down_with_valid_chunks(self):
        encoded = png_bytes(bytes([255, 0, 0, 255, 0, 255, 0, 255]), 1, 2)
        self.assertEqual(encoded[:8], b'\x89PNG\r\n\x1a\n')
        position, chunks = 8, {}
        while position < len(encoded):
            length = struct.unpack('>I', encoded[position:position + 4])[0]
            kind = encoded[position + 4:position + 8]
            data = encoded[position + 8:position + 8 + length]
            crc = struct.unpack('>I', encoded[position + 8 + length:position + 12 + length])[0]
            self.assertEqual(zlib.crc32(kind + data), crc)
            chunks[kind] = data
            position += length + 12
        self.assertEqual(zlib.decompress(chunks[b'IDAT']), bytes([0, 0, 255, 0, 255, 0, 255, 0, 0, 255]))

    def test_malformed_or_oversized_pair_creates_no_images(self):
        with tempfile.TemporaryDirectory() as root:
            for mutate in [lambda v: v['pixels'][0].update(name='../escape'),
                           lambda v: v['pixels'][1].update(rgbaBase64='AA=='),
                           lambda v: v['pixels'][0].update(width=4097),
                           lambda v: v['pixels'][1].update(rowOrder='unknown')]:
                value = captured()
                mutate(value)
                with self.assertRaises((ToolFailure, ValueError)):
                    save_pixels(value, Path(root))
                self.assertEqual(list(Path(root).iterdir()), [])

    def test_exactly_one_readback_then_screenshot_even_when_readback_fails(self):
        for value in [captured(), {'status': 'unavailable', 'reason': 'no-live-canvas'},
                      captured() | {'bindingsRestored': False}]:
            calls = []
            with tempfile.TemporaryDirectory() as root:
                out = Path(root) / 'evidence'
                def invoke(_config, args, directory, timeout):
                    calls.append(args[0])
                    self.assertEqual(timeout, 30)
                    if args[0] == 'automation_evaluate':
                        return envelope(value), 0
                    directory.mkdir()
                    image = directory / 'simulator.jpg'
                    image.write_bytes(b'official-image')
                    return {'ok': True, 'result': {'success': True, 'artifact': str(image)}}, 0
                with patch('sample_canvas.invoke', side_effect=invoke), contextlib.redirect_stdout(io.StringIO()):
                    result = sample({}, '/absolute/game', out, [0, 0, 256, 12], '.control')
                self.assertEqual(calls, ['automation_evaluate', 'simulator_screenshot'])
                self.assertEqual(result['captureAvailable'], value.get('bindingsRestored') is True)
                self.assertEqual(json.loads((out / 'summary.json').read_text()), result)
                self.assertEqual(out.stat().st_mode & 0o777, 0o700)
                self.assertEqual((out / 'summary.json').stat().st_mode & 0o777, 0o600)
                self.assertNotIn('pixels', result['result'])
                for image in result['images']:
                    self.assertEqual(Path(image['path']).stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    sample({}, '/absolute/game', out, [0, 0, 256, 12], '.control')


if __name__ == '__main__':
    unittest.main()
