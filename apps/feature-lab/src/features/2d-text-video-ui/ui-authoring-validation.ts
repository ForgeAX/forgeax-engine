import { classifyUiAuthoring, validateUiAuthoring } from '@forgeax/engine/ui/authoring';
import { defineFeature } from '../../lab/feature';

const NATIVE = {
  sourcePath: 'hud.ui.html',
  html: '<section data-ui-part="root"><button data-ui-action="save">Save</button><img src="icons/panel.png" alt="Panel" /></section>',
  css: '.root { color: var(--fx-hud-accent); }',
};

export default defineFeature({
  title: 'UI authoring validation',
  catalog: 'UI authoring validation',
  kind: 'headless',
  summary:
    'validateUiAuthoring / classifyUiAuthoring parse UiAsset HTML+CSS headlessly and classify it as native, normalizable (inline style, global selectors, generated classes) or runtime-bound (scripts, inline handlers), with structured ImportDiagnostic records.',
  expect:
    'Every check passes: native source is accepted byte-for-byte with its companion references, normalizable and runtime-bound sources fail with source-validation-failed and located diagnostics, and missing companions or labels are reported.',
  async run(checks) {
    const native = await validateUiAuthoring({
      ...NATIVE,
      readCompanion: async () => ({ ok: true }),
    });
    checks.ok('native source validates', native.ok);
    if (native.ok) {
      checks.equal('native category', native.value.category, 'native');
      checks.equal('accepted html is unchanged', native.value.html, NATIVE.html);
      checks.equal('companion references are collected', native.value.references, [
        'icons/panel.png',
      ]);
    }

    const cases = [
      {
        name: 'inline style',
        html: '<div style="color:red">Inline</div>',
        css: '.x { color: red; }',
        category: 'normalizable',
        code: 'inline-style',
      },
      {
        name: 'body selector',
        html: '<div>Body</div>',
        css: 'body { margin: 0; }',
        category: 'normalizable',
        code: 'global-selector',
      },
      {
        name: 'script',
        html: '<script>alert(1)</script>',
        css: '.x { color: red; }',
        category: 'runtime-bound',
        code: undefined,
      },
      {
        name: 'inline handler',
        html: '<button onclick="save()">Save</button>',
        css: '.x { color: red; }',
        category: 'runtime-bound',
        code: 'runtime-event-handler',
      },
    ] as const;
    for (const entry of cases) {
      const input = {
        sourcePath: `${entry.name.replace(' ', '-')}.ui.html`,
        html: entry.html,
        css: entry.css,
      };
      const classified = classifyUiAuthoring(input);
      checks.equal(`${entry.name}: category`, classified.category, entry.category);
      checks.ok(`${entry.name}: blocking`, classified.blocking);
      const validated = await validateUiAuthoring(input);
      checks.equal(
        `${entry.name}: source-validation-failed`,
        validated.ok ? 'ok' : validated.error.code,
        'source-validation-failed',
      );
      if (!validated.ok && 'diagnostics' in validated.error.detail) {
        const diagnostics = validated.error.detail.diagnostics;
        const codes = diagnostics.map((d) => d.code);
        if (entry.code !== undefined)
          checks.ok(
            `${entry.name}: reports ${entry.code}`,
            codes.includes(entry.code),
            codes.join(','),
          );
        checks.ok(
          `${entry.name}: diagnostics carry sourcePath and range`,
          diagnostics.every((d) => typeof d.sourcePath === 'string' && d.sourceRange !== undefined),
        );
      }
    }

    const missing = await validateUiAuthoring({
      ...NATIVE,
      readCompanion: async (path) => ({ ok: false, path, reason: 'not found' }),
    });
    const missingCodes =
      !missing.ok && 'diagnostics' in missing.error.detail
        ? missing.error.detail.diagnostics.map((d) => d.code)
        : [];
    checks.ok(
      'missing companion blocks with companion-missing',
      missingCodes.includes('companion-missing'),
      missingCodes.join(','),
    );

    const unlabeled = await validateUiAuthoring({
      sourcePath: 'form.ui.html',
      html: '<input id="name" />',
      css: 'input { border: 0; }',
    });
    const warnings = unlabeled.ok
      ? unlabeled.value.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code)
      : [];
    checks.ok(
      'missing label is a non-blocking warning',
      unlabeled.ok && warnings.includes('missing-accessible-label'),
      warnings.join(','),
    );
  },
});
