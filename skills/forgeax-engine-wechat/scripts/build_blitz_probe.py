#!/usr/bin/env python3
"""Reproduce the isolated Blitz Grid kernel experiment; never an Engine UI build."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess


BLITZ_REVISION = "74fe1abf090732524c86d96e6cdb6f95d8f8d6dc"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blitz-source", type=pathlib.Path, required=True)
    parser.add_argument("--engine-root", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--appid", required=True)
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--wasm-bindgen", default="wasm-bindgen")
    parser.add_argument("--node", default="node")
    parser.add_argument("--target-dir", type=pathlib.Path)
    args = parser.parse_args()
    import re
    if not re.fullmatch(r"wx[0-9a-f]{16}", args.appid):
        parser.error("--appid must be a Mini Game AppID")
    source = args.blitz_source.resolve()
    revision = run("git", "-C", str(source), "rev-parse", "HEAD", capture_output=True).stdout.strip()
    dirty = run("git", "-C", str(source), "status", "--porcelain", capture_output=True).stdout.strip()
    if revision != BLITZ_REVISION or dirty:
        parser.error("Blitz source must be the clean qualified revision: " + BLITZ_REVISION)
    bindgen = run(args.wasm_bindgen, "--version", capture_output=True).stdout.strip()
    if bindgen != "wasm-bindgen 0.2.129":
        parser.error("install wasm-bindgen 0.2.129; the lockfile fixes that ABI")
    output = args.out.resolve()
    output.mkdir()  # Refuse an existing directory; private login/game state is never overwritten.
    fixtures = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "blitz-headless"
    crate = output / "crate"
    shutil.copytree(fixtures, crate)
    # The symlink is build-local and points only at the exact clean input above.
    (output / "blitz-source").symlink_to(source, target_is_directory=True)
    target = args.target_dir.resolve() if args.target_dir else output / "target"
    cargo = [args.cargo, "+1.99.0", "--locked", "--manifest-path", str(crate / "Cargo.toml")]
    run(cargo[0], cargo[1], "test", *cargo[2:], "--target-dir", str(target))
    run(cargo[0], cargo[1], "build", *cargo[2:], "--target-dir", str(target),
        "--release", "--target", "wasm32-unknown-unknown")
    pkg = output / "pkg"
    run(args.wasm_bindgen, "--target", "web", "--out-dir", str(pkg),
        str(target / "wasm32-unknown-unknown/release/forgeax_blitz_headless_probe.wasm"))
    glue = (pkg / "forgeax_blitz_headless_probe.js").read_bytes()
    # This probe exposes generated helpers to test native instantiation. Production
    # adoption requires a producer-owned native initializer and provenance contract.
    (crate / "blitz-probe.mjs").write_bytes(glue +
        b"\nexport { __wbg_get_imports as getImports, __wbg_finalize_init as finishInit };\n")
    project = output / "project"
    (project / "ui").mkdir(parents=True)
    build_script = output / "bundle.mjs"
    build_script.write_text("""import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
const [engine, entry, outfile, wasmBytes] = process.argv.slice(2);
const { build } = createRequire(realpathSync(engine + '/node_modules/tsup/dist/index.js'))('esbuild');
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'neutral', format: 'cjs', target: 'es2022', define: { __FORGEAX_BLITZ_WASM_BYTES__: wasmBytes } });
""")
    run(args.node, str(build_script), str(args.engine_root.resolve()),
        str(crate / "game.js"), str(project / "probe.js"),
        str((pkg / "forgeax_blitz_headless_probe_bg.wasm").stat().st_size))
    wasm = pkg / "forgeax_blitz_headless_probe_bg.wasm"
    shutil.copyfile(wasm, project / "ui/blitz.wasm")
    (project / "ui/game.js").write_text("// Isolated headless Grid kernel bytes.\n")
    (project / "game.js").write_text(
        "try { require('./probe.js'); } catch (error) { console.error('FORGEAX_BLITZ_IMPORT_FAILURE', String(error), error.stack); }\n")
    (project / "game.json").write_text(json.dumps({"deviceOrientation": "portrait",
        "subpackages": [{"name": "ui", "root": "ui/"}]}))
    config = project / "project.config.json"
    config.write_text(json.dumps({"appid": args.appid, "compileType": "game",
        "projectname": "ForgeaX Blitz Kernel Contract", "libVersion": "latest",
        "setting": {"es6": False, "minified": False}}))
    config.chmod(0o600)
    def fact(path):
        data = path.read_bytes()
        return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    receipt = {"kind": "isolated-blitz-grid-probe", "blitzRevision": revision,
        "rust": "1.99.0", "wasmBindgen": bindgen,
        "lockfile": fact(crate / "Cargo.lock"), "wasm": fact(wasm),
        "canonicalGlue": fact(pkg / "forgeax_blitz_headless_probe.js"),
        "derivedGlue": fact(crate / "blitz-probe.mjs"), "game": fact(project / "probe.js")}
    (output / "probe-evidence.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"project": str(project), "receipt": str(output / "probe-evidence.json")}))


if __name__ == "__main__":
    main()
