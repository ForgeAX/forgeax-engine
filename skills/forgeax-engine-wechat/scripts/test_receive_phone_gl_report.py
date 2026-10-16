from contextlib import contextmanager
import hashlib
import http.client
import json
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
import unittest

from receive_phone_gl_report import MAX_BYTES, receive_report

SOURCE = {'manifestSha256': 'a' * 64, 'entrySha256': 'b' * 64}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def payload():
    text = '#version 300 es\n// \u4e2d\u6587 caf\u00e9 \U0001f6f8\nvoid main() {}'
    shader = {'text': text, 'bytes': len(text.encode()), 'sha256': digest(text.encode())}
    return {'kind': 'forgeax-phone-gl-link', 'source': SOURCE, 'reason': 'link-not-true',
            'finishedAt': 123456, 'sources': [shader],
            'records': [{'phase': 'link', 'linkStatus': {'type': 'boolean', 'value': False},
                         'shaders': [{'source': {'availability': 'available',
                                                'sha256': shader['sha256'], 'bytes': shader['bytes']}}]}]}


class PhoneGlReceiverTests(unittest.TestCase):
    @contextmanager
    def server(self, deadline=3, kind='forgeax-phone-gl-link'):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'capture'
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            ready, final = threading.Event(), []

            def run():
                final.append(receive_report(port, '/private/report_123', out, SOURCE,
                                            deadline=deadline, ready=lambda _: ready.set(), kind=kind))

            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            self.assertTrue(ready.wait(2), 'receiver did not bind')
            try:
                yield port, out, final
            finally:
                worker.join(deadline + 1)
                self.assertFalse(worker.is_alive(), 'receiver exceeded its deadline')
                self.assertEqual(json.loads((out / 'result.json').read_bytes()), final[0])

    def post(self, port, value=None, path='/private/report_123', headers=None, body=None):
        body = body if body is not None else json.dumps(value or payload(), ensure_ascii=False).encode()
        actual_headers = {'Content-Type': 'application/json',
                          'X-Forgeax-Report-Bytes': str(len(body)), 'X-Forgeax-Report-Sha256': digest(body)}
        actual_headers.update(headers or {})
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            connection.request('POST', path, body, actual_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read()), body
        finally:
            connection.close()

    def test_real_loopback_receives_exact_bytes_once_with_private_files(self):
        with self.server() as (port, out, final):
            status, receipt, body = self.post(port)
            self.assertEqual(status, 200)
            self.assertEqual(receipt['status'], 'saved')
            self.assertEqual(receipt['bytes'], len(body))
            self.assertEqual(receipt['sha256'], digest(body))
            self.assertEqual((out / 'report.json').read_bytes(), body)
            self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((out / 'report.json').stat().st_mode), 0o600)
        self.assertEqual(final[0]['sources'], 1)
        with socket.socket() as closed:
            self.assertNotEqual(closed.connect_ex(('127.0.0.1', port)), 0)

    def test_rejects_corrupt_digest_source_identity_or_shader_without_saving_report(self):
        for mode in ['hash', 'identity', 'source-hash', 'source-reference', 'source-missing']:
            with self.subTest(mode=mode), self.server() as (port, out, final):
                value, headers = payload(), {}
                if mode == 'hash': headers['X-Forgeax-Report-Sha256'] = '0' * 64
                if mode == 'identity': value['source'] = SOURCE | {'entrySha256': 'c' * 64}
                if mode == 'source-hash': value['sources'][0]['text'] += ' changed'
                if mode == 'source-reference': value['records'][0]['shaders'][0]['source']['sha256'] = 'd' * 64
                if mode == 'source-missing': del value['sources']
                status, result, _ = self.post(port, value, headers=headers)
                self.assertEqual(status, 400)
                self.assertEqual(result['status'], 'rejected')
                self.assertFalse((out / 'report.json').exists())

    def test_wrong_path_cannot_consume_or_write_the_capture(self):
        with self.server() as (port, out, final):
            self.assertEqual(self.post(port, path='/another-session')[0], 404)
            self.assertFalse((out / 'report.json').exists())
            self.assertEqual(self.post(port)[0], 200)

    def test_oversized_request_is_rejected_before_reading_body(self):
        with self.server() as (port, out, final):
            status, result, _ = self.post(port, body=b'', headers={
                'Content-Length': str(MAX_BYTES + 1), 'X-Forgeax-Report-Bytes': str(MAX_BYTES + 1)})
            self.assertEqual(status, 400)
            self.assertIn('size limit', result['reason'])
            self.assertFalse((out / 'report.json').exists())

    def test_deadline_closes_an_incomplete_native_request_and_leaves_no_partial_report(self):
        began = time.monotonic()
        with self.server(deadline=1) as (port, out, final):
            with socket.create_connection(('127.0.0.1', port)) as slow:
                slow.sendall(b'POST /private/report_123 HTTP/1.1\r\nHost: 127.0.0.1\r\n')
                slow.settimeout(3)
                self.assertEqual(slow.recv(1), b'')
            self.assertFalse((out / 'report.json').exists())
        self.assertEqual(final[0]['status'], 'timeout')
        self.assertLess(time.monotonic() - began, 2.5)

    def test_refuses_existing_evidence_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / 'report.json'
            marker.write_bytes(b'prior evidence')
            with self.assertRaises(FileExistsError):
                receive_report(9012, '/report', temporary, SOURCE)
            self.assertEqual(marker.read_bytes(), b'prior evidence')

    def test_startup_receiver_verifies_selected_kind_source_hash_and_terminal_structure(self):
        value = {'kind': 'forgeax-phone-startup', 'source': SOURCE, 'reason': 'startup-failed',
                 'finishedAt': 123456, 'transitions': [{'phase': 'scene'}],
                 'observation': {'renderer': {'phase': 'failed', 'startupError': {
                     'message': 'original error', 'cause': {'code': 'plugin-startup-failed',
                                                        'detail': {'guid': 'original-guid'}}}}},
                 'serialization': {'issues': []}}
        with self.server(kind='forgeax-phone-startup') as (port, out, _):
            status, receipt, body = self.post(port, value)
            self.assertEqual(status, 200)
            self.assertEqual(receipt['kind'], 'forgeax-phone-startup')
            self.assertEqual((out / 'report.json').read_bytes(), body)
        for mode in ['kind', 'source', 'hash', 'terminal', 'observation']:
            with self.subTest(mode=mode), self.server(kind='forgeax-phone-startup') as (port, out, _):
                copy, headers = json.loads(json.dumps(value)), {}
                if mode == 'kind': copy = payload()
                if mode == 'source': copy['source']['entrySha256'] = 'c' * 64
                if mode == 'hash': headers['X-Forgeax-Report-Sha256'] = '0' * 64
                if mode == 'terminal': del copy['finishedAt']
                if mode == 'observation': del copy['observation']
                status, _, _ = self.post(port, copy, headers=headers)
                self.assertEqual(status, 400)
                self.assertFalse((out / 'report.json').exists())
        with self.server() as (port, out, _):
            self.assertEqual(self.post(port, value)[0], 400, 'GL receiver cannot infer startup mode')


if __name__ == '__main__':
    unittest.main()
