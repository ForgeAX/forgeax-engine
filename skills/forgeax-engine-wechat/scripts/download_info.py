#!/usr/bin/env python3
"""Resolve current official WeChat DevTools downloads without installing anything."""
import argparse
import json
from pathlib import Path
import sys
from urllib.parse import urlparse
from urllib.request import urlopen

CONFIG_URL = 'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json'


def select(config, channel, os_name, arch):
    matches = [row for row in config['channels'] if row['id'] == channel]
    if len(matches) != 1:
        raise ValueError(f'channel unavailable: {channel}')
    row = matches[0]
    downloads = [item for item in row['downloads'] if item['os'] == os_name and item['arch'] == arch]
    if len(downloads) != 1:
        raise ValueError(f'no unique official download for {os_name}/{arch} in {channel}')
    url = downloads[0]['url']
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in (
            'devtools.wxqcloud.qq.com.cn', 'dldir1.qq.com', 'servicewechat.com'):
        raise ValueError('unexpected download origin; inspect official documentation before proceeding')
    return {'source': CONFIG_URL, 'channel': channel, 'version': row['version'],
            'date': row.get('date'), 'os': os_name, 'arch': arch, 'url': url}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channel', default='stable')
    parser.add_argument('--os', default='macOS', choices=['macOS', 'Windows'])
    parser.add_argument('--arch', default='ARM64', choices=['ARM64', 'x64', '64', '32'])
    parser.add_argument('--from-file', type=Path, help='saved official config for offline reproduction')
    args = parser.parse_args()
    if args.from_file:
        config = json.loads(args.from_file.read_text())
    else:
        with urlopen(CONFIG_URL, timeout=30) as response:
            config = json.load(response)
    print(json.dumps(select(config, args.channel, args.os, args.arch), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
