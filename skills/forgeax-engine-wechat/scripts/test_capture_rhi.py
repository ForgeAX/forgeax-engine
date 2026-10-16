import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import capture_rhi
from capture_rhi import NATIVE_SOURCE, WINDOW_BYTES, capture, copy_chunks, copy_native_windows, evaluation
from wechatide import ToolFailure


class NativeCapture:
    """Official-call boundary fixture; the real host subprocess copies actual files."""
    def __init__(self, root, data, lose_ack=False, bad_digest=False):
        self.root, self.data, self.calls = root, data, []
        self.lose_ack, self.bad_digest = lose_ack, bad_digest
        self.offset, self.last_ack, self.path = 0, None, None
        self.max_size = 0

    def metadata(self):
        digest = '0' * 64 if self.bad_digest else hashlib.sha256(self.data).hexdigest()
        identity = {'generation': 7, 'byteLength': len(self.data), 'digest': 'sha256:' + digest}
        if self.offset == len(self.data):
            return {'phase': 'complete', 'offset': self.offset, **identity}
        return {'phase': 'native-window', 'offset': self.offset,
                'length': min(WINDOW_BYTES, len(self.data) - self.offset), **identity,
                'uniqueName': self.path.name, 'virtualPath': 'http://usr/' + self.path.name}

    def write_window(self):
        if self.offset < len(self.data):
            self.path.write_bytes(self.data[self.offset:self.offset + WINDOW_BYTES])
            self.max_size = max(self.max_size, self.path.stat().st_size)

    def invoke(self, _config, args, _directory, timeout):
        request = json.loads(args[-1].rpartition('return operate(')[2].removesuffix('); }'))
        self.calls.append(request)
        if request['operation'] == 'start':
            self.path = self.root / f'forgeax-rhi-{request["id"]}.rhitape'
            self.write_window()
            value = {'phase': 'capturing', 'generation': 7}
        elif request['operation'] == 'status':
            value = self.metadata()
        elif request['operation'] == 'ack':
            advanced = False
            if self.last_ack != request:
                assert request['offset'] == self.offset
                assert request['length'] == self.path.stat().st_size
                self.path.unlink()
                self.offset += request['length']
                self.last_ack = request
                self.write_window()
                advanced = True
                if self.lose_ack:
                    self.lose_ack = False
                    raise ToolFailure('lost ACK reply after next window is ready')
            value = {'phase': 'writing', 'generation': 7} if advanced else self.metadata()
        else:
            self.path.unlink(missing_ok=True)
            value = {'phase': 'released'}
        return {'ok': True, 'result': {'success': True, 'result': value}}, 0


class CaptureExportTests(unittest.TestCase):
    def make_stream(self, data):
        metadata = {'generation': 7, 'byteLength': len(data),
                    'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}

        def call(request):
            offset = request['offset']
            if offset == len(data):
                return {'phase': 'complete', 'offset': offset, **metadata}
            chunk = data[offset:offset + 3]
            return {'phase': 'chunk', 'offset': offset, 'byteLength': len(chunk),
                    'data': base64.b64encode(chunk).decode()}
        return metadata, call

    def test_byte_identical_file_after_bounded_export(self):
        data = b'RHITAPE' + bytes(range(256))
        metadata, call = self.make_stream(data)
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            target = Path(directory) / 'frame.rhitape'
            result = copy_chunks(call, metadata, target, 3)
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(result['digest'], metadata['digest'])
            self.assertFalse(target.with_suffix('.rhitape.partial').exists())

    def test_rejects_changed_bytes_and_retains_partial_evidence(self):
        metadata, call = self.make_stream(b'RHITAPE')
        metadata['digest'] = 'sha256:' + '0' * 64
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            target = Path(directory) / 'frame.rhitape'
            with self.assertRaisesRegex(ToolFailure, 'SHA-256 mismatch'):
                copy_chunks(call, metadata, target, 3)
            self.assertFalse(target.exists())
            self.assertEqual(target.with_suffix('.rhitape.partial').read_bytes(), b'RHITAPE')

    def test_exclusive_publication_preserves_existing_evidence(self):
        metadata, call = self.make_stream(b'RHITAPE')
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            target = Path(directory) / 'frame.rhitape'
            target.write_bytes(b'existing evidence')
            with self.assertRaises(FileExistsError):
                copy_chunks(call, metadata, target, 3)
            self.assertEqual(target.read_bytes(), b'existing evidence')
            self.assertEqual(target.with_suffix('.rhitape.partial').read_bytes(), b'RHITAPE')

    def test_rejects_offset_length_and_completion_generation_changes(self):
        metadata, original = self.make_stream(b'RHITAPE')
        for key, value, complete in [('offset', 4, False), ('byteLength', 9, False), ('generation', 9, True)]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
                def call(request):
                    result = original(request)
                    if (result['phase'] == 'complete') == complete:
                        result[key] = value
                    return result
                with self.assertRaises(ToolFailure):
                    copy_chunks(call, metadata, Path(directory) / 'frame.rhitape', 3)

    def test_tool_success_does_not_mask_game_failure(self):
        with self.assertRaisesRegex(ToolFailure, 'capture-unavailable'):
            evaluation({'ok': True, 'result': {'success': True, 'result': {
                'phase': 'failed', 'error': {'code': 'capture-unavailable'}}}})

    def test_release_is_attempted_after_lost_start_reply(self):
        calls = []
        def invoke(_config, args, _directory, _timeout):
            calls.append(args[-1])
            if len(calls) == 1:
                raise ToolFailure('lost start reply')
            return {'ok': True, 'result': {'success': True, 'result': {'phase': 'released'}}}, 0
        with tempfile.TemporaryDirectory() as directory, patch('capture_rhi.invoke', invoke), contextlib.redirect_stdout(io.StringIO()):
            result = capture({}, '/game', Path(directory) / 'capture')
        self.assertFalse(result['success'])
        self.assertTrue(result['released'])
        self.assertIn('"operation": "release"', calls[-1])

    def test_native_windows_copy_and_verify_before_ack_without_recapture_after_lost_reply(self):
        data = b'RHITAPE' + bytes(range(256)) * (WINDOW_BYTES // 128)
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory) / 'sandbox $(never-shell-expand)'
            root.mkdir()
            unrelated = root / 'unrelated-cache'
            unrelated.write_bytes(b'preserve')
            fixture = NativeCapture(root, data, lose_ack=True)
            target = Path(directory) / 'capture'
            with patch('capture_rhi.invoke', fixture.invoke):
                result = capture({}, '/game', target, native_file=True, native_root=root,
                                 seed_max_resource_bytes=0)
            self.assertTrue(result['success'], result)
            self.assertTrue(result['released'])
            self.assertTrue(result['copiedAndVerified'])
            self.assertEqual((target / 'frame.rhitape').read_bytes(), data)
            self.assertFalse((target / 'frame.rhitape.partial').exists())
            self.assertEqual(result['artifact']['nativeWindows'], 3)
            self.assertEqual(fixture.max_size, WINDOW_BYTES)
            self.assertEqual(unrelated.read_bytes(), b'preserve')
            self.assertFalse(fixture.path.exists())
            self.assertEqual(len([c for c in fixture.calls if c['operation'] == 'start']), 1)
            self.assertEqual(len([c for c in fixture.calls if c['operation'] == 'ack']), 4)
            self.assertEqual(fixture.calls[0]['seedMaxResourceBytes'], 0)
            self.assertEqual((target / 'frame.rhitape').stat().st_mode & 0o777, 0o600)

    def test_native_mode_requires_explicit_root_before_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            for options in [dict(native_file=True), dict(native_root=Path('/sandbox')),
                            dict(native_file=True, native_root=Path('/'))]:
                with self.subTest(options=options), self.assertRaises(ToolFailure):
                    capture({}, '/game', Path(directory) / 'capture', **options)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_final_artifact_digest_still_checks_windows_with_valid_transport_hashes(self):
        data = b'RHITAPE' * 100
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root, target = Path(directory), Path(directory) / 'capture'
            fixture = NativeCapture(root, data, bad_digest=True)
            with patch('capture_rhi.invoke', fixture.invoke):
                result = capture({}, '/game', target, native_file=True, native_root=root)
            self.assertFalse(result['success'])
            self.assertTrue(result['released'])
            self.assertIn('whole-file SHA-256 mismatch', result['error'])
            self.assertFalse((target / 'frame.rhitape').exists())
            self.assertEqual((target / 'frame.rhitape.partial').read_bytes(), data)

    def test_corrupt_transport_never_acknowledges_window_and_keeps_failed_copy_evidence(self):
        original = subprocess.run
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root, target = Path(directory), Path(directory) / 'capture'
            fixture = NativeCapture(root, b'RHITAPE')
            def corrupt(*args, **kwargs):
                completed = original(*args, **kwargs)
                kwargs['stdout'].seek(0)
                kwargs['stdout'].write(b'BADTAPE')
                return completed
            with patch('capture_rhi.invoke', fixture.invoke), patch('capture_rhi.subprocess.run', corrupt):
                result = capture({}, '/game', target, native_file=True, native_root=root)
            self.assertFalse(result['success'])
            self.assertTrue(result['released'])
            self.assertIn('SHA-256 mismatch', result['error'])
            self.assertFalse(any(c['operation'] == 'ack' for c in fixture.calls))
            self.assertEqual(len(list(target.glob('window-*/copy-*.partial'))), 3)
            self.assertFalse((target / 'frame.rhitape').exists())

    def test_total_deadline_includes_native_transport_and_still_releases(self):
        clock = [10.0]
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root, target = Path(directory), Path(directory) / 'capture'
            fixture = NativeCapture(root, b'RHITAPE')
            def timed_out(*args, **kwargs):
                self.assertLessEqual(kwargs['timeout'], 1)
                clock[0] = 11.1
                raise subprocess.TimeoutExpired(args[0], kwargs['timeout'])
            with patch('capture_rhi.invoke', fixture.invoke), patch('capture_rhi.subprocess.run', timed_out), patch('capture_rhi.time.monotonic', lambda: clock[0]):
                result = capture({}, '/game', target, timeout=1, native_file=True, native_root=root)
            self.assertFalse(result['success'])
            self.assertIn('deadline exceeded', result['error'])
            self.assertTrue(result['released'])
            self.assertFalse(any(c['operation'] == 'ack' for c in fixture.calls))

    def test_stale_window_identity_is_rejected_before_host_read(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            fixture = NativeCapture(root, b'RHITAPE')
            fixture.path = root / 'forgeax-rhi-test.rhitape'
            original = fixture.metadata()
            for index, (key, value) in enumerate([('offset', 1), ('length', WINDOW_BYTES + 1),
                                                ('uniqueName', 'other.rhitape')]):
                target = root / f'frame-{index}.rhitape'
                with self.subTest(key=key), patch('capture_rhi.read_native_window') as reader:
                    with self.assertRaisesRegex(ToolFailure, 'window identity'):
                        copy_native_windows({}, None, {**original, key: value}, 'test', root,
                                            target, root, time.monotonic() + 10)
                    reader.assert_not_called()

    def test_release_failure_cannot_be_reported_as_success(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root, target = Path(directory), Path(directory) / 'capture'
            fixture = NativeCapture(root, b'RHITAPE')
            def invoke(*args):
                if '"operation": "release"' in args[1][-1]:
                    return {'ok': True, 'result': {'success': True, 'result': {
                        'phase': 'failed', 'error': {'code': 'capture-export-native-file-cleanup'}}}}, 0
                return fixture.invoke(*args)
            with patch('capture_rhi.invoke', invoke):
                result = capture({}, '/game', target, native_file=True, native_root=root)
            self.assertFalse(result['success'])
            self.assertFalse(result['released'])
            self.assertIn('capture-export-native-file-cleanup', result['releaseError'])


class NativeHostTests(unittest.TestCase):
    def setUp(self):
        scope = {'__name__': 'native_fixture'}
        exec(compile(NATIVE_SOURCE, 'native.py', 'exec'), scope)
        self.copy_window = scope['copy_window']

    def request(self, root, data=b'RHITAPE'):
        path = root / 'forgeax-rhi-test.rhitape'
        path.write_bytes(data)
        return path, {'root': str(root), 'uniqueName': path.name, 'length': len(data)}

    def test_host_hashes_exact_stable_file_without_mutating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, request = self.request(root)
            output = io.BytesIO()
            receipt = self.copy_window(request, output)
            self.assertEqual(output.getvalue(), path.read_bytes())
            self.assertEqual(receipt['digest'], 'sha256:' + hashlib.sha256(output.getvalue()).hexdigest())

    def test_rejects_duplicate_name_symlink_escape_and_wrong_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'sandbox'
            root.mkdir()
            path, request = self.request(root)
            duplicate = root / 'nested'
            duplicate.mkdir()
            (duplicate / path.name).write_bytes(path.read_bytes())
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                self.copy_window(request, io.BytesIO())
            (duplicate / path.name).unlink()
            outside = root.parent / path.name
            outside.write_bytes(path.read_bytes())
            with self.assertRaisesRegex(ValueError, 'escaped'):
                self.copy_window({**request, 'path': str(outside)}, io.BytesIO())
            with self.assertRaisesRegex(ValueError, 'acknowledged length'):
                self.copy_window({**request, 'length': 8}, io.BytesIO())
            path.unlink()
            path.symlink_to(outside)
            with self.assertRaises(ValueError):
                self.copy_window(request, io.BytesIO())

    def test_file_replacement_during_read_is_not_acknowledged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, request = self.request(root, b'x' * WINDOW_BYTES)
            class ReplacingOutput(io.BytesIO):
                def write(self, value):
                    replacement = root / 'replacement'
                    replacement.write_bytes(b'y' * WINDOW_BYTES)
                    os.replace(replacement, path)
                    return super().write(value)
            with self.assertRaisesRegex(ValueError, 'changed while reading'):
                self.copy_window(request, ReplacingOutput())


if __name__ == '__main__':
    unittest.main()
