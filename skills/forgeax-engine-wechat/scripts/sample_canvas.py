#!/usr/bin/env python3
"""Pair one bounded actual Canvas readback with the official simulator screenshot."""
import argparse
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import zlib

from wechatide import ToolFailure, invoke, load_config, outcome
from wait_game import screenshot_available


def reader_source(region, selector):
    if (len(region) != 4 or any(type(value) is not int for value in region)
            or min(region[:2]) < 0 or min(region[2:]) <= 0 or region[2] * region[3] > 3072):
        raise ToolFailure('region must be X Y WIDTH HEIGHT, nonnegative and at most 3072 pixels')
    if not isinstance(selector, str) or not selector.strip() or len(selector) > 1024:
        raise ToolFailure('positive-control selector must contain 1–1024 characters')
    source = Path(__file__).with_name('read_canvas.js').read_text()
    options = json.dumps({'region': region, 'selector': selector}, ensure_ascii=True)
    return f'function () {{ return ({source})({options}); }}'


def read_result(response, status):
    result = response.get('result') if isinstance(response, dict) else None
    if (status != 0 or not isinstance(response, dict) or response.get('ok') is not True
            or outcome(response) != 0 or not isinstance(result, dict)
            or result.get('success') is not True or not isinstance(result.get('result'), dict)):
        raise ToolFailure('Canvas evaluation needs a completed successful tool envelope')
    value = result['result']
    if value.get('status') not in ('captured', 'unavailable'):
        raise ToolFailure('Canvas evaluation returned no structured capture status')
    return value


def png_bytes(data, width, height):
    """Encode bounded GL bottom-to-top RGBA with only the Python standard library."""
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    stride = width * 4
    rows = b''.join(b'\0' + data[y * stride:(y + 1) * stride] for y in range(height - 1, -1, -1))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def save_pixels(value, directory):
    pixels = value.get('pixels')
    if (not isinstance(pixels, list) or len(pixels) != 2
            or [item.get('name') for item in pixels if isinstance(item, dict)] != ['region', 'positive-control']):
        raise ToolFailure('exactly one region and one positive-control crop are required')
    decoded, total = [], 0
    for item in pixels:
        width, height = item.get('width'), item.get('height')
        if (type(width) is not int or type(height) is not int or min(width, height) <= 0
                or width * height > 4096 or item.get('rowOrder') != 'bottom-to-top'
                or not isinstance(item.get('rgbaBase64'), str) or len(item['rgbaBase64']) > 21848):
            raise ToolFailure('invalid bounded crop dimensions, row order or payload')
        data = base64.b64decode(item['rgbaBase64'], validate=True)
        total += len(data)
        if len(data) != width * height * 4 or total > 16384:
            raise ToolFailure('readback length exceeds declared crops or 16 KiB')
        decoded.append((item, data))
    images = []
    for item, data in decoded:
        path = directory / f"{item['name']}.png"
        encoded = png_bytes(data, item['width'], item['height'])
        path.write_bytes(encoded)
        path.chmod(0o600)
        images.append({**{key: value for key, value in item.items() if key != 'rgbaBase64'},
                       'path': str(path.resolve()), 'rgbaSha256': hashlib.sha256(data).hexdigest(),
                       'pngSha256': hashlib.sha256(encoded).hexdigest()})
    return images


def sample(config, project, directory, region, selector):
    if not Path(project).is_absolute():
        raise ToolFailure('project must be an absolute path on the DevTools machine')
    source = reader_source(region, selector)
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    summary = {'project': project, 'region': region, 'positiveSelector': selector,
               'captureAvailable': False, 'images': [], 'failures': []}
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            response, status = invoke(config, ['automation_evaluate', '--project', project,
                '--fn-source', source], directory / 'canvas-read', 30)
        value = read_result(response, status)
        summary['result'] = {key: value for key, value in value.items() if key != 'pixels'}
        if value.get('status') == 'captured':
            summary['images'] = save_pixels(value, directory)
            if value.get('bindingsRestored') is not True:
                raise ToolFailure('temporary GL read/pack state was not restored')
            summary['captureAvailable'] = True
        else:
            summary['failures'].append({'kind': 'readback', 'message': value.get('reason')})
    except (ToolFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
        summary['failures'].append({'kind': 'readback', 'message': str(error)})
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            response, status = invoke(config, ['simulator_screenshot', '--project', project],
                                      directory / 'simulator-screen', 30)
        summary['simulatorScreenshot'] = {'status': status, 'result': response}
        if not screenshot_available(response, status):
            raise ToolFailure('no successful locally copied official screenshot')
    except (ToolFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
        summary['failures'].append({'kind': 'screenshot', 'message': str(error)})
    path = directory / 'summary.json'
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)
    print(json.dumps({'summary': str(path.resolve()), 'captureAvailable': summary['captureAvailable'],
                      'images': summary['images'], 'failures': summary['failures']}, ensure_ascii=False))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path, help='private machine JSON; see tooling.md')
    parser.add_argument('--project', required=True, help='absolute already-open project on DevTools machine')
    parser.add_argument('--out', required=True, type=Path, help='new private local evidence directory')
    parser.add_argument('--region', type=int, nargs=4, default=[0, 0, 256, 12], metavar=('X', 'Y', 'WIDTH', 'HEIGHT'),
                        help='top-left physical-pixel coordinates; at most 3072 pixels')
    parser.add_argument('--positive-selector', default='.languages button', help='visible known UI control')
    args = parser.parse_args()
    result = sample(load_config(args.config), args.project, args.out, args.region, args.positive_selector)
    return 0 if result['captureAvailable'] and not result['failures'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ToolFailure, OSError, ValueError) as error:
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
