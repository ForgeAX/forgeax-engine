import json
from pathlib import Path
import tempfile
import unittest

from diagnose_phone_startup import clone_diagnostic, digest, validate_report_url


class PhoneDiagnosticCloneTests(unittest.TestCase):
    def publication(self, directory):
        source = directory / 'source'
        source.mkdir()
        (source / 'game.js').write_bytes(b'globalThis.originalGame = true;\n')
        (source / 'payload.bin').write_bytes(b'unchanged payload')
        manifest = {'target': 'wechat', 'artifacts': [
            {'path': name, 'bytes': (source / name).stat().st_size,
             'sha256': digest((source / name).read_bytes())}
            for name in ['game.js', 'payload.bin']]}
        (source / 'forgeax-dist.json').write_text(json.dumps(manifest))
        return source

    def test_default_startup_clone_retains_existing_modal_mode_and_payload(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            before = {path.name: path.read_bytes() for path in source.iterdir()}
            report = clone_diagnostic(source, base / 'diagnostic')
            self.assertEqual(report['changedFiles'], ['game.js'])
            self.assertNotIn('frameObservation', report)
            entry = (base / 'diagnostic/game.js').read_bytes()
            self.assertIn(b'"observeFrames": false', entry)
            self.assertTrue(entry.endswith(before['game.js']))
            self.assertEqual({path.name: path.read_bytes() for path in source.iterdir()}, before)
            self.assertEqual((base / 'diagnostic/payload.bin').read_bytes(), before['payload.bin'])

    def test_frame_mode_embeds_exact_source_identity_without_rewriting_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            report = clone_diagnostic(source, base / 'diagnostic', True, True, 60)
            options = report['frameObservation']
            self.assertEqual(options['windowMs'], 10000)
            self.assertEqual(options['deadlineMs'], 60000)
            self.assertEqual(options['source']['manifestSha256'], digest((source / 'forgeax-dist.json').read_bytes()))
            self.assertEqual((base / 'diagnostic/forgeax-dist.json').read_bytes(), (source / 'forgeax-dist.json').read_bytes())
            self.assertNotIn(b'__FORGEAX_PROBE_OPTIONS__', (base / 'diagnostic/game.js').read_bytes())

    def test_refuses_corrupt_source_and_result_modal_without_frame_observation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            with self.assertRaisesRegex(ValueError, 'requires --observe-frames'):
                clone_diagnostic(source, base / 'invalid', False, True)
            (source / 'payload.bin').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'does not match its manifest'):
                clone_diagnostic(source, base / 'invalid')
            self.assertFalse((base / 'invalid').exists())

    def test_gl_link_mode_only_prepends_observation_and_retains_published_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            report = clone_diagnostic(source, base / 'diagnostic', observe_gl_link=True)
            entry = (base / 'diagnostic/game.js').read_bytes()
            self.assertTrue(report['glLinkObservation']['observeGlLink'])
            self.assertEqual(report['changedFiles'], ['game.js'])
            self.assertIn(b'[forgeax.phone.gl-link]', entry)
            self.assertNotIn(b'__FORGEAX_PROBE_OPTIONS__', entry)
            self.assertTrue(entry.endswith((source / 'game.js').read_bytes()))
            self.assertEqual((base / 'diagnostic/forgeax-dist.json').read_bytes(), (source / 'forgeax-dist.json').read_bytes())

    def test_report_transfer_is_opt_in_and_only_admits_explicit_loopback_path(self):
        for url in ['http://localhost:9012/report', 'https://127.0.0.1:9012/report',
                    'http://127.0.0.1:9012/', 'http://127.0.0.1:9012/report?token=x',
                    'http://127.0.0.1:9012/report#x', 'http://user@127.0.0.1:9012/report',
                    'http://127.0.0.1:0/report', 'http://127.0.0.1:65536/report',
                    'http://127.0.0.1:9012/%2e%2e/report', 'http://127.0.0.1:9012/report\n']:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'requires http'):
                validate_report_url(url)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            url = 'http://127.0.0.1:9012/private/report_123'
            with self.assertRaisesRegex(ValueError, 'requires --observe-gl-link'):
                clone_diagnostic(source, base / 'invalid', report_url=url)
            self.assertFalse((base / 'invalid').exists())
            report = clone_diagnostic(source, base / 'diagnostic', observe_gl_link=True, report_url=url)
            self.assertEqual(report['glLinkObservation']['reportUrl'], url)
            self.assertEqual(report['changedFiles'], ['game.js'])
            self.assertEqual((base / 'diagnostic/forgeax-dist.json').read_bytes(), (source / 'forgeax-dist.json').read_bytes())

    def test_startup_mode_preserves_publication_and_requires_an_exclusive_observer(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            before = {path.name: path.read_bytes() for path in source.iterdir()}
            report = clone_diagnostic(source, base / 'diagnostic', observe_startup=True,
                                      report_url='http://127.0.0.1:19143/startup-test')
            self.assertEqual(report['changedFiles'], ['game.js'])
            self.assertTrue(report['startupObservation']['observeStartup'])
            self.assertEqual(report['startupObservation']['minimumSceneFrames'], 1)
            self.assertFalse(report['startupObservation']['observeWasmLifetime'])
            entry = (base / 'diagnostic/game.js').read_bytes()
            self.assertIn(b'forgeax-phone-startup', entry)
            self.assertNotIn(b'__FORGEAX_PROBE_OPTIONS__', entry)
            self.assertNotIn(b'ForgeaX native API facts', entry)
            self.assertTrue(entry.endswith(before['game.js']))
            self.assertEqual((base / 'diagnostic/forgeax-dist.json').read_bytes(), before['forgeax-dist.json'])
            self.assertEqual({path.name: path.read_bytes() for path in source.iterdir()}, before)
            for mode in ['observe_frames', 'observe_gl_link']:
                with self.assertRaisesRegex(ValueError, 'cannot be combined'):
                    clone_diagnostic(source, base / 'invalid', observe_startup=True, **{mode: True})

    def test_minimum_scene_frames_is_explicit_bounded_startup_observation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            for count in [0, -1, 1.5, True, 36001]:
                with self.subTest(count=count), self.assertRaisesRegex(ValueError, 'minimum-scene-frames'):
                    clone_diagnostic(source, base / 'invalid', observe_startup=True,
                                     minimum_scene_frames=count)
            with self.assertRaisesRegex(ValueError, 'requires --observe-startup'):
                clone_diagnostic(source, base / 'invalid', minimum_scene_frames=60)
            report = clone_diagnostic(source, base / 'diagnostic', observe_startup=True,
                                      minimum_scene_frames=60)
            self.assertEqual(report['startupObservation']['minimumSceneFrames'], 60)

    def test_fence_probe_is_explicit_startup_only_intervention(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            with self.assertRaisesRegex(ValueError, 'requires --observe-startup'):
                clone_diagnostic(source, base / 'invalid', probe_fence_status=True)
            report = clone_diagnostic(source, base / 'diagnostic', observe_startup=True,
                                      minimum_scene_frames=60, probe_fence_status=True)
            self.assertTrue(report['startupObservation']['probeFenceStatus'])
            self.assertEqual(report['startupObservation']['fenceProbeDelayMs'], 0)
            self.assertEqual(report['startupObservation']['fenceProbeIntervalMs'], 100)
            self.assertEqual(report['changedFiles'], ['game.js'])
            self.assertTrue((base / 'diagnostic/game.js').read_bytes().endswith((source / 'game.js').read_bytes()))

    def test_fence_probe_timing_is_explicit_bounded_and_requires_the_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            for option, values in [('fence_probe_delay_ms', [-1, 300001, True, 0.5]),
                                   ('fence_probe_interval_ms', [99, 60001, True, 100.5])]:
                for value in values:
                    with self.subTest(option=option, value=value), self.assertRaisesRegex(ValueError, 'fence-probe-'):
                        clone_diagnostic(source, base / 'invalid', observe_startup=True,
                                         probe_fence_status=True, **{option: value})
            for option, value in [('fence_probe_delay_ms', 0), ('fence_probe_interval_ms', 100)]:
                with self.assertRaisesRegex(ValueError, 'requires --probe-fence-status'):
                    clone_diagnostic(source, base / 'invalid', observe_startup=True, **{option: value})
            report = clone_diagnostic(source, base / 'diagnostic', observe_startup=True,
                                      probe_fence_status=True, fence_probe_delay_ms=10000, fence_probe_interval_ms=1000)
            self.assertEqual(report['startupObservation']['fenceProbeDelayMs'], 10000)
            self.assertEqual(report['startupObservation']['fenceProbeIntervalMs'], 1000)
            self.assertFalse(report['startupObservation']['observeWasmLifetime'])
            self.assertEqual(report['changedFiles'], ['game.js'])

    def test_wasm_lifetime_is_explicit_startup_only_observation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            with self.assertRaisesRegex(ValueError, '--observe-wasm-lifetime requires --observe-startup'):
                clone_diagnostic(source, base / 'invalid', observe_wasm_lifetime=True)
            self.assertFalse((base / 'invalid').exists())
            report = clone_diagnostic(source, base / 'diagnostic', observe_startup=True,
                                      minimum_scene_frames=12000, frame_timeout=600, observe_wasm_lifetime=True)
            self.assertTrue(report['startupObservation']['observeWasmLifetime'])
            self.assertEqual(report['startupObservation']['deadlineMs'], 600000)
            self.assertEqual(report['changedFiles'], ['game.js'])
            self.assertTrue((base / 'diagnostic/game.js').read_bytes().endswith((source / 'game.js').read_bytes()))
            self.assertEqual((base / 'diagnostic/forgeax-dist.json').read_bytes(), (source / 'forgeax-dist.json').read_bytes())

    def test_inspection_reads_are_explicit_unique_bounded_projection_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = self.publication(base)
            for names in [[''], ['x()'], ['x'] * 2, ['x' * 129], [str(n) for n in range(9)]]:
                with self.subTest(names=names), self.assertRaisesRegex(ValueError, 'inspection-read'):
                    clone_diagnostic(source, base / 'invalid', observe_startup=True, inspection_reads=names)
            with self.assertRaisesRegex(ValueError, 'requires --observe-startup'):
                clone_diagnostic(source, base / 'invalid', inspection_reads=['game-3d.runtime-vase'])
            report = clone_diagnostic(source, base / 'diagnostic', observe_startup=True,
                                      inspection_reads=['game-3d.runtime-vase', 'game-3d.player'])
            self.assertEqual(report['startupObservation']['inspectionReads'], ['game-3d.runtime-vase', 'game-3d.player'])


if __name__ == '__main__':
    unittest.main()
