export const tauriStorageSource = `use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{ipc::{InvokeBody, Request, Response}, Manager, WebviewWindow};

#[derive(Default)]
pub struct StorageState {
    readers: Mutex<HashMap<String, ReadLease>>,
}

struct ReadLease {
    key: String,
    size: u64,
    file: Arc<Mutex<File>>,
}

const MAX_READERS: usize = 128;
const MAX_TRANSFER: usize = 32 * 1024 * 1024;
const MAX_RECORD_TOTAL: u64 = 128 * 1024 * 1024;
const MAX_RECORD_COUNT: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9007199254740991;
static MUTATIONS: Mutex<()> = Mutex::new(());

fn map_io(error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::NotFound => "missing".into(),
        ErrorKind::PermissionDenied => "unavailable".into(),
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => "quota".into(),
        _ => "io".into(),
    }
}

fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io(error)),
    }
}

fn hex_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn slot_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64
        && key.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

fn file_id(key: &str) -> bool {
    (24..=80).contains(&key.len())
        && key.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == b'-')
}

fn read_record(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(map_io)?;
    if file.metadata().map_err(map_io)?.len() > MAX_TRANSFER as u64 {
        return Err("io".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_TRANSFER + 1) as u64).read_to_end(&mut bytes).map_err(map_io)?;
    if bytes.len() > MAX_TRANSFER { return Err("io".into()); }
    Ok(bytes)
}

fn put_record(root: &Path, path: &Path, id: &str, body: &[u8], durable: bool) -> Result<(), String> {
    fs::create_dir_all(root).map_err(map_io)?;
    let staging = root.join(format!("{id}.record-tmp"));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&staging).map_err(map_io)?;
    let written = (|| {
        file.write_all(body)?;
        if durable { file.sync_all()?; }
        Ok::<(), std::io::Error>(())
    })();
    drop(file);
    let result = written.and_then(|()| fs::rename(&staging, path)).map_err(map_io);
    if result.is_err() { let _ = remove(&staging); }
    result
}

fn prune_cache(root: &Path, retained: &Path) -> std::io::Result<()> {
    let mut items = Vec::new();
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(key) = name.to_str().and_then(|name| name.strip_suffix(".bin")) else { continue };
        if !hex_key(key) { continue; }
        let metadata = entry.metadata()?;
        if !metadata.is_file() { continue; }
        total += metadata.len();
        count += 1;
        if entry.path() != retained {
            items.push((metadata.modified()?, metadata.len(), entry.path()));
        }
    }
    items.sort_by_key(|item| item.0);
    for (_, bytes, path) in items {
        if total <= MAX_RECORD_TOTAL && count <= MAX_RECORD_COUNT { break; }
        fs::remove_file(path)?;
        total -= bytes;
        count -= 1;
    }
    Ok(())
}

fn record(root: &Path, kind: &str, op: &str, key: &str, nonce: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    let durable = kind == "saves";
    if !(if durable { slot_key(key) } else { hex_key(key) }) { return Err("invalid-input".into()); }
    let path = root.join(format!("{key}.bin"));
    if op == "read" {
        let bytes = read_record(&path)?;
        if !durable {
            if let Ok(file) = File::open(&path) {
                let _ = file.set_modified(std::time::SystemTime::now());
            }
        }
        return Ok(bytes);
    }
    let _lock = MUTATIONS.lock().map_err(|_| "io")?;
    match op {
        "replace" | "import" => {
            if !file_id(nonce) { return Err("invalid-input".into()); }
            if op == "import" {
                match read_record(&path) {
                    Ok(bytes) => return Ok(bytes),
                    Err(code) if code == "missing" => {}
                    Err(code) => return Err(code),
                }
            }
            put_record(root, &path, nonce, body, durable)?;
            if !durable { let _ = prune_cache(root, &path); }
            Ok(if op == "import" { body.to_vec() } else { Vec::new() })
        }
        "remove" => { remove(&path)?; Ok(Vec::new()) }
        _ => Err("invalid-input".into()),
    }
}

fn open_read(state: &StorageState, path: &Path, key: &str, nonce: &str, size: u64) -> Result<(), String> {
    if !file_id(nonce) { return Err("invalid-input".into()); }
    let mut readers = state.readers.lock().map_err(|_| "io")?;
    if readers.contains_key(nonce) { return Err("invalid-input".into()); }
    if readers.len() >= MAX_READERS { return Err("quota".into()); }
    let file = File::open(path).map_err(map_io)?;
    if file.metadata().map_err(map_io)?.len() != size { return Err("io".into()); }
    readers.insert(nonce.to_owned(), ReadLease { key: key.to_owned(), size, file: Arc::new(Mutex::new(file)) });
    Ok(())
}

fn close_read(state: &StorageState, key: &str, nonce: &str) -> Result<(), String> {
    let mut readers = state.readers.lock().map_err(|_| "io")?;
    if readers.get(nonce).is_some_and(|lease| lease.key == key) { readers.remove(nonce); }
    Ok(())
}

fn read_file(state: &StorageState, key: &str, nonce: &str, size: u64, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    if offset > size || (length as u64) > size - offset { return Err("invalid-input".into()); }
    let file = {
        let readers = state.readers.lock().map_err(|_| "io")?;
        let lease = readers.get(nonce).ok_or("closed")?;
        if lease.key != key || lease.size != size { return Err("invalid-input".into()); }
        Arc::clone(&lease.file)
    };
    let mut file = file.lock().map_err(|_| "io")?;
    let mut bytes = vec![0; length];
    file.seek(SeekFrom::Start(offset)).map_err(map_io)?;
    file.read_exact(&mut bytes).map_err(map_io)?;
    Ok(bytes)
}

fn version_file(state: &StorageState, root: &Path, op: &str, key: &str, nonce: &str, size: u64, offset: u64, length: usize, body: &[u8]) -> Result<Vec<u8>, String> {
    if !file_id(key) || size > MAX_SAFE_INTEGER { return Err("invalid-input".into()); }
    let path = root.join(format!("{key}.bin"));
    match op {
        "open" => return open_read(state, &path, key, nonce, size).map(|()| Vec::new()),
        "read" => return read_file(state, key, nonce, size, offset, length),
        "close" => return close_read(state, key, nonce).map(|()| Vec::new()),
        _ => {}
    }
    let stage = root.join(format!("{key}.tmp"));
    let _lock = MUTATIONS.lock().map_err(|_| "io")?;
    match op {
        "begin" => {
            fs::create_dir_all(root).map_err(map_io)?;
            OpenOptions::new().create_new(true).write(true).open(&stage).map_err(map_io)?;
        }
        "append" => {
            let mut file = OpenOptions::new().append(true).open(&stage).map_err(map_io)?;
            let actual = file.metadata().map_err(map_io)?.len();
            if offset != actual || offset > size || (body.len() as u64) > size - offset {
                return Err("invalid-input".into());
            }
            file.write_all(body).map_err(map_io)?;
        }
        "commit" => {
            let file = File::open(&stage).map_err(map_io)?;
            if file.metadata().map_err(map_io)?.len() != size { return Err("invalid-input".into()); }
            drop(file);
            fs::rename(&stage, &path).map_err(map_io)?;
        }
        "abort" => remove(&stage)?,
        "remove" => {
            let readers = state.readers.lock().map_err(|_| "io")?;
            if readers.values().any(|lease| lease.key == key) { return Err("io".into()); }
            remove(&path)?;
        }
        _ => return Err("invalid-input".into()),
    }
    Ok(Vec::new())
}

fn header<'a>(request: &'a Request<'_>, key: &str) -> Result<&'a str, String> {
    request.headers().get(key).ok_or_else(|| "invalid-input".to_string())?
        .to_str().map_err(|_| "invalid-input".into())
}

fn number<T: std::str::FromStr>(request: &Request<'_>, key: &str) -> Result<T, String> {
    header(request, key)?.parse().map_err(|_| "invalid-input".into())
}

fn request_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_TRANSFER => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Raw(_) => Err("quota".into()),
        // Tauri serializes ArrayBuffer as a byte array on its postMessage transport.
        InvokeBody::Json(serde_json::Value::Array(values)) if values.len() <= MAX_TRANSFER => {
            let bytes = values.iter().map(|value| {
                value.as_u64().and_then(|value| u8::try_from(value).ok()).ok_or("invalid-input")
            }).collect::<Result<Vec<_>, _>>()?;
            Ok(Cow::Owned(bytes))
        }
        InvokeBody::Json(serde_json::Value::Array(_)) => Err("quota".into()),
        _ => Err("invalid-input".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_raw_and_post_message_bytes() {
        let raw = InvokeBody::Raw(vec![0, 128, 255]);
        let serialized = InvokeBody::Json(serde_json::json!([0, 128, 255]));
        assert!(matches!(request_bytes(&raw), Ok(Cow::Borrowed(_))));
        assert_eq!(request_bytes(&raw).unwrap(), request_bytes(&serialized).unwrap());
        for value in [serde_json::json!([256]), serde_json::json!([-1]), serde_json::json!([1.5]), serde_json::json!({ "0": 1 })] {
            assert_eq!(request_bytes(&InvokeBody::Json(value)).unwrap_err(), "invalid-input");
        }
    }
}

// Commands run off the WebView thread. The bundled main WebView owns this capability.
#[tauri::command(async)]
pub fn storage_io(window: WebviewWindow, request: Request<'_>) -> Result<Response, String> {
    if window.label() != "main" { return Err("unavailable".into()); }
    let kind = header(&request, "x-forgeax-space")?;
    let op = header(&request, "x-forgeax-operation")?;
    let key = header(&request, "x-forgeax-key")?;
    let body = request_bytes(request.body())?;
    let paths = window.app_handle().path();
    let root: PathBuf = match kind {
        "cache" => paths.app_cache_dir(),
        "saves" | "files" => paths.app_local_data_dir(),
        _ => return Err("invalid-input".into()),
    }.map_err(|_| "unavailable")?.join("forgeax-storage-v1").join(kind);
    // WebView2 can omit empty headers. The operations that use a nonce validate it.
    let nonce = request.headers().get("x-forgeax-nonce")
        .map(|value| value.to_str().map_err(|_| "invalid-input"))
        .transpose()?.unwrap_or_default();
    if kind == "files" {
        let state = window.state::<StorageState>();
        let size = number(&request, "x-forgeax-size")?;
        let offset = number(&request, "x-forgeax-offset")?;
        let length = number(&request, "x-forgeax-length")?;
        if length > MAX_TRANSFER { return Err("quota".into()); }
        return version_file(&state, &root, op, key, nonce, size, offset, length, &body).map(Response::new);
    }
    record(&root, kind, op, key, nonce, &body).map(Response::new)
}
`;
