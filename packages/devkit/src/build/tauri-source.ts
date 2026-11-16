export const tauriBuildScript = `import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
const args = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--');
const host = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const selected = args[0] === '--platform' ? args.splice(0, 2)[1] : host;
if (!['windows', 'macos', 'linux', 'android', 'ios'].includes(selected)) throw new Error('Expected --platform windows|macos|linux|android|ios');
if ((selected === 'ios' && host !== 'macos') || (!['android', 'ios'].includes(selected) && selected !== host)) {
  throw new Error('Build ' + selected + ' on its native host (iOS requires macOS); export with --prepare-only from ForgeAX on other hosts');
}
const run = command => {
  const result = spawnSync(process.execPath, [cli, ...command], { cwd: root, env: { ...process.env, CI: 'true' }, stdio: 'inherit', timeout: 1800000 });
  if (result.status !== 0) throw new Error('Tauri ' + command.slice(0, 2).join(' ') + ' failed (exit ' + result.status + ')', { cause: result.error });
};
run(['icon', 'icon.svg']);
if (selected === 'android' || selected === 'ios') {
  const generated = selected === 'android' ? 'android' : 'apple';
  if (!existsSync(resolve(root, 'src-tauri/gen', generated))) run([selected, 'init', '--ci']);
  if (selected === 'android') {
    const main = resolve(root, 'src-tauri/gen/android/app/src/main');
    mkdirSync(resolve(main, 'res/xml'), { recursive: true });
    copyFileSync(resolve(root, 'src-tauri/android/loopback-network.xml'), resolve(main, 'res/xml/forgeax_loopback.xml'));
    const manifest = resolve(main, 'AndroidManifest.xml');
    const xml = readFileSync(manifest, 'utf8');
    if (!xml.includes('android:networkSecurityConfig=')) writeFileSync(manifest, xml.replace('<application', '<application android:networkSecurityConfig="@xml/forgeax_loopback"'));
  }
  run([selected, 'build', '--ci', ...(selected === 'android' ? ['--apk', '--aab'] : []), ...args]);
} else {
  const bundles = { macos: 'app,dmg', windows: 'nsis,msi', linux: 'appimage,deb,rpm' }[selected];
  run(['build', '--ci', '--bundles', bundles, ...args]);
}
`;

export const tauriSmokeScript = `import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, 'src-tauri/target'), 'release');
if (process.platform !== 'darwin' && !process.env.FORGEAX_TAURI_EXECUTABLE) throw new Error('Packaged smoke requires the actual installed executable via FORGEAX_TAURI_EXECUTABLE on this OS');
const packagedApp = resolve(root, 'artifacts/macos', config.productName + '.app', 'Contents/MacOS/forgeax-game');
const retainedApp = await access(packagedApp).then(() => packagedApp, () => undefined);
const executable = process.env.FORGEAX_TAURI_EXECUTABLE ?? retainedApp ?? (process.platform === 'darwin'
  ? resolve(target, 'bundle/macos', config.productName + '.app', 'Contents/MacOS/forgeax-game')
  : process.platform === 'win32' ? resolve(target, 'forgeax-game.exe') : resolve(target, 'forgeax-game'));
const reportDir = resolve(root, 'report');
await mkdir(reportDir, { recursive: true });
await rm(resolve(reportDir, 'report.json'), { force: true });
const child = spawn(executable, ['--smoke', '--report-dir', reportDir, ...process.argv.slice(2)], { stdio: 'inherit' });
let exited = false;
const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
const deadline = Date.now() + 120000;
let captured = false;
try {
while (!exited && Date.now() < deadline) {
  try {
    const report = JSON.parse(await readFile(resolve(reportDir, 'report.json'), 'utf8'));
    captured ||= report.snapshot === 'webview-ready.png';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await setTimeout(100);
}
if (!exited) throw new Error('Tauri smoke timed out');
const status = await exit;
const report = JSON.parse(await readFile(resolve(reportDir, 'report.json'), 'utf8'));
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
report.artifact = { executable, executableSha256: await digest(executable),
  distributionSha256: await digest(resolve(root, 'forgeax-dist.json')),
  cargoLockSha256: await digest(resolve(root, 'src-tauri/Cargo.lock')) };
await writeFile(resolve(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\\n');
if (status.code !== 0 || report.phase !== 'closed' || report.cleanup !== 'completed' || report.presented < 60 || report.errors.length || !report.permissionDenied || (process.platform === 'darwin' && !captured)) {
  throw new Error('Tauri smoke failed: ' + JSON.stringify({ status, report }));
}
console.log(JSON.stringify({ executable, reportDir, completed: report.completed, cleanup: report.cleanup, captured }));
} finally {
  if (!exited) { child.kill('SIGTERM'); await exit; }
}
`;

export const tauriLibrarySource = String.raw`use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::Manager;

#[cfg(any(target_os = "windows", target_os = "android"))]
mod asset_server;

struct HostState {
    report_dir: Option<PathBuf>,
    report: Mutex<serde_json::Value>,
    closing: AtomicBool,
}

fn save(state: &HostState) -> Result<(), String> {
    if let Some(directory) = &state.report_dir {
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let report = state.report.lock().map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(&*report).map_err(|error| error.to_string())?;
        let pending = directory.join("report.pending.json");
        std::fs::write(&pending, bytes).map_err(|error| error.to_string())?;
        std::fs::rename(pending, directory.join("report.json")).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn smoke_report(window: tauri::WebviewWindow, state: tauri::State<'_, HostState>, mut report: serde_json::Value) -> Result<(), String> {
    if state.report_dir.is_none() { return Err("smoke-not-enabled".into()); }
    #[cfg(target_os = "macos")]
    let phase = report["phase"].as_str().unwrap_or("").to_owned();
    #[cfg(target_os = "macos")]
    let viewport = report["viewport"]["innerWidth"].as_f64()
        .zip(report["viewport"]["innerHeight"].as_f64());
    report["native"] = serde_json::json!({ "tauri": tauri::VERSION, "os": std::env::consts::OS, "arch": std::env::consts::ARCH });
    *state.report.lock().map_err(|error| error.to_string())? = report;
    save(&state)?;
    #[cfg(target_os = "macos")]
    if matches!(phase.as_str(), "document-loaded" | "ready" | "failed") {
        capture_webview(&window, phase, viewport)?;
    }
    Ok(())
}

// WKWebView captures its own composited page without desktop recording access.
// This also preserves an actual failed-startup image from an SSH-launched app.
#[cfg(target_os = "macos")]
fn capture_webview(window: &tauri::WebviewWindow, phase: String, viewport: Option<(f64, f64)>) -> Result<(), String> {
    use objc2::{AnyThread, MainThreadOnly};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    let app = window.app_handle().clone();
    window.with_webview(move |webview| unsafe {
        let native = &*(webview.inner() as *const WKWebView);
        let bounds = native.bounds();
        let configuration = WKSnapshotConfiguration::new(native.mtm());
        // WKWebView bounds can include title-bar inset space outside the JS viewport.
        let rect = match viewport.filter(|(width, height)| *width > 0.0 && *height > 0.0) {
            Some((width, height)) => NSRect::new(bounds.origin, NSSize::new(width.min(bounds.size.width), height.min(bounds.size.height))),
            None => bounds,
        };
        configuration.setRect(rect);
        let callback = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let state = app.state::<HostState>();
            let result = (|| -> Result<String, String> {
                let image = image.as_ref().ok_or_else(|| format!("WebView snapshot failed: {:?}", error.as_ref()))?;
                let tiff = image.TIFFRepresentation().ok_or("WebView snapshot has no image bytes")?;
                let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                    .ok_or("WebView snapshot cannot be decoded")?;
                let png = bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
                    .ok_or("WebView snapshot cannot be encoded")?;
                let name = format!("webview-{phase}.png");
                let path = state.report_dir.as_ref().ok_or("smoke-not-enabled")?.join(&name);
                std::fs::write(&path, png.as_bytes_unchecked()).map_err(|error| error.to_string())?;
                eprintln!("[forgeax.tauri.snapshot] {}", path.display());
                Ok(name)
            })();
            if let Ok(mut report) = state.report.lock() {
                report["snapshotBounds"] = serde_json::json!({ "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.size.width, "height": bounds.size.height });
                report["snapshotRect"] = serde_json::json!({ "x": rect.origin.x, "y": rect.origin.y, "width": rect.size.width, "height": rect.size.height });
                match result {
                    Ok(name) => report["snapshot"] = name.into(),
                    Err(error) => report["snapshotError"] = error.into(),
                }
            }
            let _ = save(&state);
        });
        native.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &callback);
    }).map_err(|error| error.to_string())
}

#[tauri::command]
fn finish_close(app: tauri::AppHandle, state: tauri::State<'_, HostState>, error: Option<String>) -> Result<(), String> {
    {
        let mut report = state.report.lock().map_err(|error| error.to_string())?;
        report["phase"] = "closed".into();
        report["cleanup"] = if error.is_none() { "completed" } else { "failed" }.into();
        if let Some(reason) = &error { report["closeError"] = reason.clone().into(); }
    }
    save(&state)?;
    app.exit(if error.is_none() { 0 } else { 1 });
    Ok(())
}

#[tauri::command]
fn request_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

const CLOSE: &str = r#"(async () => {
  let error = null;
  try { await globalThis.__forgeaxTauriDispose?.(); }
  catch (cause) { error = cause?.message ?? JSON.stringify(cause); }
  await window.__TAURI__.core.invoke('finish_close', { error });
})().catch(console.error);"#;

const SMOKE: &str = r#"(() => {
  const errors = [];
  let permissionDenied;
  let permissionProbe;
  addEventListener('error', event => errors.push(String(event.error?.stack ?? event.message ?? ('Resource failed: ' + event.target?.src))), true);
  addEventListener('securitypolicyviolation', event => errors.push('CSP ' + event.violatedDirective + ': ' + event.blockedURI));
  addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack ?? event.reason)));
  const started = performance.now();
  let enteredAt;
  const uiText = root => [...root.querySelectorAll('*')].flatMap(node => node.shadowRoot ? [node.shadowRoot.textContent, ...uiText(node.shadowRoot)] : []).join('\n');
  const timer = setInterval(async () => {
    if (!window.__TAURI__?.core) return;
    permissionProbe ??= window.__TAURI__.core.invoke('plugin:window|set_title', { label: 'main', title: 'Unauthorized title' })
      .then(() => errors.push('undeclared native window permission was admitted'), error => { permissionDenied = String(error); });
    const observation = globalThis.__forgeaxGameInspection?.renderer?.();
    const completed = observation?.execution?.frame?.completed ?? 0;
    if (document.documentElement.dataset.forgeaxInput === 'open' && enteredAt === undefined) enteredAt = completed;
    const presented = enteredAt === undefined ? 0 : completed - enteredAt;
    const ready = observation?.state === 'alive' && presented >= 60;
    const startup = globalThis.__forgeaxStartup?.inspect?.();
    const fatal = startup?.phase === 'failed' && startup.recovery !== 'retrying' ? startup.diagnostics || startup.message : undefined;
    if (fatal && errors.length === 0) errors.push(fatal);
    if (!ready && errors.length === 0 && performance.now() - started < 90000) return;
    clearInterval(timer);
    await permissionProbe;
    let probe;
    if (ready && globalThis.__forgeaxTauriSmokeProbe) {
      try { probe = await globalThis.__forgeaxTauriSmokeProbe(); }
      catch (error) { errors.push(String(error?.stack ?? error)); }
    }
    const report = { mode: 'tauri-webview', phase: ready ? 'ready' : 'failed', completed, presented, probe,
      errors, observation, permissionDenied, userAgent: navigator.userAgent,
      url: location.href, secureContext: isSecureContext,
      viewport: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
        document: document.documentElement.getBoundingClientRect().toJSON(), body: document.body.getBoundingClientRect().toJSON() },
      startup: { text: document.querySelector('#forgeax-loading')?.textContent, fatal: globalThis.__forgeaxStartup?.inspect?.().diagnostics,
        scripts: [...document.scripts].map(script => ({ src: script.src, type: script.type })), inspection: typeof globalThis.__forgeaxGameInspection },
      canvas: [...document.querySelectorAll('canvas')].map(canvas => ({ width: canvas.width, height: canvas.height })),
      ui: { count: document.querySelectorAll('#game-ui > *').length, text: uiText(document.querySelector('#game-ui') ?? document) },
      resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration })) };
    if (!ready && errors.length === 0) errors.push('60 completed frames were not observed before timeout');
    if (observation?.lastError) errors.push(JSON.stringify(observation.lastError));
    await window.__TAURI__.core.invoke('smoke_report', { report });
    setTimeout(() => window.__TAURI__.core.invoke('request_close'), 5000);
  }, 100);
})();"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    let args: Vec<_> = std::env::args().collect();
    #[cfg(mobile)]
    let args: Vec<String> = Vec::new();
    let smoke = args.iter().any(|argument| argument == "--smoke");
    let report_dir = smoke.then(|| args.windows(2)
        .find(|pair| pair[0] == "--report-dir")
        .map(|pair| PathBuf::from(&pair[1])).unwrap_or_else(|| PathBuf::from("report")));
    let probe = if smoke { args.windows(2).find(|pair| pair[0] == "--smoke-probe")
        .map(|pair| std::fs::read_to_string(&pair[1]).expect("Smoke probe could not be read")) } else { None };
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.register_uri_scheme_protocol(asset_server::PROTOCOL, |context, request| {
        asset_server::protocol_response(context.app_handle(), request)
    });
    builder
        .manage(HostState { report_dir, report: Mutex::new(serde_json::json!({ "phase": "launching" })), closing: AtomicBool::new(false) })
        .invoke_handler(tauri::generate_handler![smoke_report, finish_close, request_close])
        .on_page_load(move |window, payload| {
            if smoke {
                eprintln!("[forgeax.tauri.page] {:?} {}", payload.event(), payload.url());
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = window.eval(r#"globalThis.__TAURI_INTERNALS__?.invoke('smoke_report', { report: {
                        phase: 'document-loaded', url: location.href, visibility: document.visibilityState,
                        tauriGlobal: !!globalThis.__TAURI__, ready: document.readyState,
                        title: document.title, scripts: document.scripts.length,
                        viewport: { innerWidth, innerHeight, devicePixelRatio },
                        startupError: document.querySelector('#forgeax-fatal-details')?.textContent,
                    } });"#);
                }
            }
        })
        .setup(move |app| {
            save(&app.state::<HostState>())?;
            let title = app.config().product_name.clone().unwrap_or_else(|| "ForgeAX".into());
            #[cfg(any(target_os = "windows", target_os = "android"))]
            let url = asset_server::start(app)?;
            #[cfg(not(any(target_os = "windows", target_os = "android")))]
            let url = tauri::WebviewUrl::App("index.html".into());
            let mut builder = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title(title).inner_size(1280.0, 800.0);
            if let Some(source) = &probe { builder = builder.initialization_script(source); }
            if smoke { builder = builder.initialization_script(SMOKE); }
            let window = builder.build()?;
            #[cfg(desktop)]
            window.set_focus()?;
            #[cfg(desktop)]
            let handle = app.handle().clone();
            #[cfg(desktop)]
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let state = handle.state::<HostState>();
                    if !state.closing.swap(true, Ordering::SeqCst) {
                        if let Some(window) = handle.get_webview_window("main") {
                            if let Err(error) = window.eval(CLOSE) { eprintln!("ForgeAX Host close failed: {error}"); handle.exit(1); }
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri WebView Host failed")
        .run(|app, event| {
            #[cfg(any(target_os = "windows", target_os = "android"))]
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(server) = app.try_state::<asset_server::ResourceServer>() { server.stop(); }
            }
            #[cfg(desktop)]
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") { let _ = window.close(); }
            }
        });
}
`;
