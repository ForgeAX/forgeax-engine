import type { Plugin } from 'vite';
import { pcmWav, toneWav } from '../support-tone';

export function addressedPcmWav(): Uint8Array {
  const samples = new Float32Array(96000);
  for (let frame = 0; frame < samples.length; frame++)
    samples[frame] = -0.3 + ((frame % 48000) / 48000) * 0.4 + Math.floor(frame / 48000) * 0.02;
  return pcmWav(samples);
}

export function pcmRangeFixture(): Plugin {
  return {
    name: 'audio-range-fixture',
    configureServer(server) {
      const tone = toneWav();
      const addressed = addressedPcmWav();
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__pcm/')) return next();
        // Rapid aborted reads must not retain a keep-alive connection between cases.
        res.setHeader('Connection', 'close');
        const bytes = req.url.includes('addressed') ? addressed : tone;
        const match = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
        if (req.url.includes('no-range')) {
          res.statusCode = 200;
          res.end(bytes);
          return;
        }
        if (!match) {
          res.statusCode = 416;
          res.end();
          return;
        }
        if (req.url.includes('offline')) {
          res.statusCode = 503;
          res.end();
          return;
        }
        const start = Number(match[1]),
          end = Number(match[2]);
        const body = bytes.slice(start, end + 1);
        if (req.url.includes('corrupt')) body[0] = (body[0] ?? 0) ^ 1;
        if (req.url.includes('oversized')) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
          res.end(Buffer.concat([body, Buffer.from([1])]));
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
        res.setHeader('Content-Length', body.length);
        if (req.url.includes('resume-slow')) setTimeout(() => res.end(body), 1500);
        else if (req.url.includes('slow')) setTimeout(() => res.end(body), 250);
        else res.end(body);
      });
    },
  };
}
