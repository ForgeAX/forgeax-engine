import { createProfiler } from '@forgeax/engine/profiler';
import { buildIntrospectDoc, isProfilerRoot } from '@forgeax/engine/remote/introspect';
import { defineFeature } from '../../lab/feature';

interface Doc {
  readonly openrpc: string;
  readonly servers: readonly { readonly url: string }[];
  readonly methods: readonly { readonly name: string }[];
  readonly roots: Readonly<Record<string, unknown>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, unknown>>;
    readonly errors: unknown;
  };
}

export default defineFeature({
  title: 'Remote introspection',
  catalog: 'Remote introspection',
  kind: 'headless',
  summary:
    'introspect returns an OpenRPC 1.3.2 subset with eval/introspect, projected roots, and host-injected component schemas.',
  expect:
    'Methods are exactly eval+introspect, injected descriptors appear by name, and a profiler root adds ProfilerCapture only when present.',
  run(checks) {
    const descriptor = {
      name: 'LabTag',
      schema: { hue: 'f32' },
      fields: { hue: { type: 'f32' } },
      meta: { owner: 'feature-lab' },
    };
    const plain = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      introspection: [descriptor],
    }) as Doc;
    checks.equal('openrpc version', plain.openrpc, '1.3.2');
    checks.equal(
      'methods are eval + introspect',
      plain.methods.map((m) => m.name),
      ['eval', 'introspect'],
    );
    checks.equal(
      'server url uses /inspector',
      plain.servers[0]?.url,
      'ws://127.0.0.1:5732/inspector',
    );
    checks.ok(
      'World/Renderer/Assets schemas',
      ['World', 'Renderer', 'Assets'].every((name) => name in plain.components.schemas),
    );
    checks.ok(
      'injected descriptor projected verbatim',
      JSON.stringify(plain.components.schemas.LabTag) === JSON.stringify(descriptor),
    );
    checks.ok(
      'no profiler root without opt-in',
      !('profiler' in plain.roots) && !('ProfilerCapture' in plain.components.schemas),
    );
    checks.ok('error projection present', plain.components.errors !== undefined);

    const profiler = createProfiler();
    checks.ok('createProfiler satisfies isProfilerRoot', isProfilerRoot(profiler));
    checks.ok('arbitrary object is not a profiler root', !isProfilerRoot({ startCapture() {} }));
    const withProfiler = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      profiler,
    }) as Doc;
    checks.ok('profiler root projected on opt-in', 'profiler' in withProfiler.roots);
    checks.ok(
      'ProfilerCapture schema on opt-in',
      'ProfilerCapture' in withProfiler.components.schemas,
    );
  },
});
