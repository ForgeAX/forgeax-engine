export const tauriResourceProtocol = 'forgeax';

/** Serve the embedded closure where WebView protocol interception omits nested Workers. */
export const tauriResourceServerSource = `use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::Manager;
use tiny_http::{Header, Method, Response, Server};

#[cfg(target_os = "android")]
pub const PROTOCOL: &str = "${tauriResourceProtocol}";

pub struct ResourceServer {
    server: Arc<Server>,
    stopped: Arc<AtomicBool>,
}

impl ResourceServer {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.server.unblock();
    }
}

#[cfg(target_os = "android")]
pub fn protocol_response<R: tauri::Runtime>(app: &tauri::AppHandle<R>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let Some(port) = app.try_state::<ResourceServer>()
        .and_then(|state| state.server.server_addr().to_ip().map(|address| address.port())) else {
        return tauri::http::Response::builder().status(503).body(Vec::new()).unwrap();
    };
    if request.uri().scheme_str() != Some(PROTOCOL) || request.uri().host() != Some("localhost") || request.uri().port_u16() != Some(port)
        || !matches!(*request.method(), tauri::http::Method::GET | tauri::http::Method::HEAD) {
        return tauri::http::Response::builder().status(403).body(Vec::new()).unwrap();
    }
    let Some(asset) = app.asset_resolver().get_for_scheme(request.uri().path().into(), false) else {
        return tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
    };
    let mut response = tauri::http::Response::builder()
        .header("Content-Type", asset.mime_type)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(csp) = asset.csp_header { response = response.header("Content-Security-Policy", csp); }
    response.body(if request.method() == tauri::http::Method::HEAD { Vec::new() } else { asset.bytes }).unwrap()
}

pub fn start(app: &tauri::App) -> Result<tauri::WebviewUrl, Box<dyn std::error::Error>> {
    // Bind before publishing the URL; the port remains reserved for this process.
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let address = listener.local_addr()?;
    // Keep Android's document on Tauri's intercepted origin. Wry otherwise
    // injects its startup scripts both at document start and onPageStarted.
    #[cfg(target_os = "android")]
    let authority = format!("{PROTOCOL}.localhost:{}", address.port());
    #[cfg(not(target_os = "android"))]
    let authority = address.to_string();
    let origin = format!("http://{authority}");
    let server = Arc::new(Server::from_listener(listener, None)
        .map_err(|error| std::io::Error::other(error.to_string()))?);
    // Reuse the existing permission authority with this exact runtime origin.
    let mut capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/main.json"))?;
    capability["identifier"] = "main-loopback-host".into();
    capability["local"] = false.into();
    capability["remote"] = serde_json::json!({ "urls": [format!("{origin}/*")] });
    app.add_capability(serde_json::to_string(&capability)?)?;
    let stopped = Arc::new(AtomicBool::new(false));
    app.manage(ResourceServer { server: server.clone(), stopped: stopped.clone() });
    let assets = app.asset_resolver();
    std::thread::Builder::new().name("forgeax-assets".into()).spawn(move || {
        while !stopped.load(Ordering::Acquire) {
            let request = match server.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(Some(request)) => request,
                Ok(None) => continue,
                Err(_) => break,
            };
            let host_matches = request.headers().iter()
                .any(|header| header.field.equiv("Host") && header.value.as_str() == authority);
            if !host_matches || !matches!(request.method(), Method::Get | Method::Head) {
                let _ = request.respond(Response::empty(403));
                continue;
            }
            let path = request.url().split('?').next().unwrap_or("/").to_owned();
            if let Some(asset) = assets.get_for_scheme(path, false) {
                let mut response = Response::from_data(asset.bytes);
                let mut headers = vec![("Content-Type", asset.mime_type),
                    ("Cache-Control", "no-store".into()), ("X-Content-Type-Options", "nosniff".into())];
                if let Some(csp) = asset.csp_header { headers.push(("Content-Security-Policy", csp)); }
                for (name, value) in headers {
                    if let Ok(header) = Header::from_bytes(name, value) { response.add_header(header); }
                }
                let _ = request.respond(response);
            } else {
                let _ = request.respond(Response::empty(404));
            }
        }
    })?;
    Ok(tauri::WebviewUrl::External(format!("{origin}/").parse()?))
}
`;
