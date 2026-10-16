#!/usr/bin/env python3
"""Clone a verified WeChat publication with an early native startup diagnostic."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def digest(body):
    return hashlib.sha256(body).hexdigest()


def validate_report_url(value):
    match = re.fullmatch(r'http://127\.0\.0\.1:([0-9]{1,5})(/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)', value)
    if not match or not 1 <= int(match[1]) <= 65535:
        raise ValueError('--report-url requires http://127.0.0.1:<port>/<explicit-path> without query or fragment')
    return value


def clone_diagnostic(source, out, observe_frames=False, show_frame_result=False, frame_timeout=150,
                     observe_gl_link=False, engine_root=None, report_url=None, observe_startup=False,
                     minimum_scene_frames=1, inspection_reads=(), probe_fence_status=False,
                     observe_wasm_lifetime=False, fence_probe_delay_ms=None, fence_probe_interval_ms=None):
    source, out = source.resolve(), out.resolve()
    if out == source or source in out.parents or out.exists():
        raise ValueError('--out must be new and outside --source')
    if show_frame_result and not observe_frames:
        raise ValueError('--show-frame-result requires --observe-frames')
    if not 20 <= frame_timeout <= 600:
        raise ValueError('--frame-timeout must be between 20 and 600 seconds')
    if observe_startup and (observe_gl_link or observe_frames):
        raise ValueError('--observe-startup cannot be combined with other observation modes')
    if type(minimum_scene_frames) is not int or not 1 <= minimum_scene_frames <= 36000:
        raise ValueError('--minimum-scene-frames must be an integer between 1 and 36000')
    if minimum_scene_frames != 1 and not observe_startup:
        raise ValueError('--minimum-scene-frames requires --observe-startup')
    if (len(inspection_reads) > 8 or any(not isinstance(name, str) or
            re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}', name) is None for name in inspection_reads)
            or len(set(inspection_reads)) != len(inspection_reads)):
        raise ValueError('--inspection-read requires at most 8 unique explicit projection IDs')
    if inspection_reads and not observe_startup:
        raise ValueError('--inspection-read requires --observe-startup')
    if probe_fence_status and not observe_startup:
        raise ValueError('--probe-fence-status requires --observe-startup')
    if observe_wasm_lifetime and not observe_startup:
        raise ValueError('--observe-wasm-lifetime requires --observe-startup')
    for flag, value, lower, upper in [('--fence-probe-delay-ms', fence_probe_delay_ms, 0, 300000),
                                      ('--fence-probe-interval-ms', fence_probe_interval_ms, 100, 60000)]:
        if value is not None:
            if type(value) is not int or not lower <= value <= upper:
                raise ValueError(f'{flag} must be an integer between {lower} and {upper}')
            if not probe_fence_status:
                raise ValueError(f'{flag} requires --probe-fence-status')
    if report_url is not None:
        validate_report_url(report_url)
        if not observe_gl_link and not observe_startup:
            raise ValueError('--report-url requires --observe-gl-link or --observe-startup')
    manifest_bytes = (source / 'forgeax-dist.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get('target') != 'wechat':
        raise ValueError('--source must contain a WeChat publication')
    before = {}
    for file in source.rglob('*'):
        if file.is_symlink():
            raise ValueError('publication must not contain symlinks')
        if file.is_file():
            before[file.relative_to(source).as_posix()] = digest(file.read_bytes())
    for row in manifest['artifacts']:
        path = row['path']
        if path not in before or before[path] != row['sha256']:
            raise ValueError(f'published artifact does not match its manifest: {path}')
        if (source / path).stat().st_size != row['bytes']:
            raise ValueError(f'published artifact size does not match: {path}')
    original = (source / 'game.js').read_bytes()
    prefix = Path(__file__).with_name('phone_startup_prefix.js').read_bytes()
    prefix = prefix.replace(b'__FORGEAX_PROBE_MANIFEST__', digest(manifest_bytes)[:12].encode())
    options = {'observeFrames': observe_frames, 'showFrameResult': show_frame_result,
               'observeGlLink': observe_gl_link, 'observeStartup': observe_startup,
               'minimumSceneFrames': minimum_scene_frames,
               'inspectionReads': list(inspection_reads),
               'probeFenceStatus': probe_fence_status,
               'observeWasmLifetime': observe_wasm_lifetime,
               'fenceProbeDelayMs': 0 if fence_probe_delay_ms is None else fence_probe_delay_ms,
               'fenceProbeIntervalMs': 100 if fence_probe_interval_ms is None else fence_probe_interval_ms,
               'deadlineMs': int(frame_timeout * 1000), 'windowMs': 10000, 'pollMs': 250,
               'source': {'manifestSha256': digest(manifest_bytes), 'entrySha256': digest(original)}}
    if report_url is not None:
        options['reportUrl'] = report_url
    prefix = prefix.replace(b'__FORGEAX_PROBE_OPTIONS__', json.dumps(options).encode())
    if observe_gl_link or observe_startup:
        engine_root = Path(engine_root) if engine_root else Path(__file__).resolve().parents[3]
        bundled = subprocess.run(['node', str(Path(__file__).with_name('bundle_phone_gl_link.mjs')),
                                  '--probe', 'startup' if observe_startup else 'gl-link',
                                  '--engine-root', str(engine_root)], check=True, stdout=subprocess.PIPE).stdout
        bundled = bundled.replace(b'__FORGEAX_PROBE_OPTIONS__', json.dumps(options).encode())
        prefix = bundled if observe_startup else bundled + b'\n' + prefix
    shutil.copytree(source, out)
    out.chmod(0o700)
    (out / 'game.js').write_bytes(prefix + b'\n' + original)
    changed = [path for path, expected in before.items()
               if digest((out / path).read_bytes()) != expected]
    if changed != ['game.js']:
        raise RuntimeError(f'Diagnostic must change only game.js: {changed}')
    report = {
        'kind': 'startup-diagnostic-only',
        'originalManifestSha256': digest(manifest_bytes),
        'originalEntrySha256': digest(original),
        'diagnosticEntrySha256': digest((out / 'game.js').read_bytes()),
        'unchangedFiles': len(before) - 1,
        'changedFiles': changed,
        'manifestPolicy': 'Original retained; this diagnostic is not a qualified distribution.',
    }
    if observe_frames:
        report['frameObservation'] = options
    if observe_gl_link:
        report['glLinkObservation'] = options
    if observe_startup:
        report['startupObservation'] = options
    (out / 'startup-diagnostic.json').write_text(json.dumps(report, indent=2) + '\n')
    return report | {'directory': str(out)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Original published WeChat directory')
    parser.add_argument('--out', required=True, type=Path, help='New private diagnostic directory')
    parser.add_argument('--observe-frames', action='store_true', help='observe scene-ready completion receipts for an independent 10-second window')
    parser.add_argument('--show-frame-result', action='store_true', help='show the final frame result only after observation terminates')
    parser.add_argument('--observe-gl-link', action='store_true', help='log raw native link/compile status types on the original canvas without changing their results')
    parser.add_argument('--observe-startup', action='store_true', help='retain the actual startup terminal with bounded complete nested error cause/detail, without displaying diagnostic modals')
    parser.add_argument('--probe-fence-status', action='store_true', help='diagnostic intervention: pair native query/clientWaitSync(0,0)/query on at most 8 same-sync observations after scene readiness; requires --observe-startup')
    parser.add_argument('--fence-probe-delay-ms', type=int, help='minimum time after the first verified scene-ready baseline before probing, 0..300000 ms (default: 0); requires --probe-fence-status')
    parser.add_argument('--fence-probe-interval-ms', type=int, help='minimum time between probe pairs, 100..60000 ms (default: 100); requires --probe-fence-status')
    parser.add_argument('--observe-wasm-lifetime', action='store_true', help='diagnostic-only bounded 1-second WASM memory/native call and passive GL fence counts inside/outside synchronous submit, not FPS/performance qualification; requires --observe-startup')
    parser.add_argument('--minimum-scene-frames', type=int, default=1, help='new completed scene presentations required after the first ready snapshot, in one Host/device generation; requires --observe-startup (default: 1)')
    parser.add_argument('--inspection-read', action='append', default=[], help='read this existing game projection once after the required scene frames, bounded to 5 seconds; repeat for at most 8 IDs; requires --observe-startup')
    parser.add_argument('--report-url', help='opt-in one report POST to http://127.0.0.1:<port>/<path> over an explicitly prepared ADB reverse; requires --observe-gl-link or --observe-startup')
    parser.add_argument('--engine-root', type=Path, help='Engine source checkout with installed dependencies, used to bundle diagnostic hash and UTF-8 owners')
    parser.add_argument('--frame-timeout', type=float, default=150, help='total startup and frame observation deadline, seconds')
    args = parser.parse_args()
    try:
        report = clone_diagnostic(args.source, args.out, args.observe_frames, args.show_frame_result,
                                  args.frame_timeout, args.observe_gl_link, args.engine_root, args.report_url,
                                  args.observe_startup, args.minimum_scene_frames, args.inspection_read, args.probe_fence_status,
                                  args.observe_wasm_lifetime, args.fence_probe_delay_ms, args.fence_probe_interval_ms)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
