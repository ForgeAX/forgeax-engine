// @forgeax/engine-render-graph/src/pass-registry.ts — pass declaration
// registry (plan-strategy 3.1).
//
// Shape (D-5):
// - name -> reads/writes declaration + optional execute closure
// - supports listPasses enumeration

import { RenderGraphError } from './errors.js';
import type { PassDescriptor } from './graph.js';

export interface PassEntry<Ctx = unknown> {
  readonly name: string;
  readonly descriptor: PassDescriptor<Ctx>;
}

export class PassRegistry<Ctx = unknown> {
  private readonly passes: PassEntry<Ctx>[] = [];

  add(name: string, descriptor: PassDescriptor<Ctx>, before?: string): PassEntry<Ctx> {
    if (this.passes.some((pass) => pass.name === name)) {
      throw new RenderGraphError({
        code: 'duplicate-pass-name',
        expected: `pass name '${name}' is unique within one graph`,
        hint: `rename the second '${name}' pass; labels are diagnostics, not identity`,
        detail: { passName: name },
      });
    }
    const { reads, writes, execute, compute, storageBuffer, colorConnections } = descriptor;
    const entry: PassEntry<Ctx> = Object.freeze({
      name,
      descriptor: Object.freeze({
        reads: Object.freeze([...reads]),
        writes: Object.freeze([...writes]),
        ...(execute === undefined ? {} : { execute }),
        ...(compute === undefined ? {} : { compute }),
        ...(storageBuffer === undefined ? {} : { storageBuffer }),
        ...(colorConnections === undefined
          ? {}
          : {
              colorConnections: Object.freeze(
                colorConnections.map(({ source, destination, conversion }) =>
                  Object.freeze({
                    source,
                    destination,
                    ...(conversion === undefined
                      ? {}
                      : { conversion: Object.freeze({ kind: conversion.kind }) }),
                  }),
                ),
              ),
            }),
      }),
    });
    const beforeIndex =
      before === undefined ? -1 : this.passes.findIndex((pass) => pass.name === before);
    if (beforeIndex < 0) this.passes.push(entry);
    else this.passes.splice(beforeIndex, 0, entry);
    return entry;
  }

  list(): readonly PassEntry<Ctx>[] {
    return this.passes;
  }

  count(): number {
    return this.passes.length;
  }
}
