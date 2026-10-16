//! Transport bridge only: Blitz retains all parser and resource identities.
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use std::collections::BTreeMap;
use std::sync::Mutex;

struct Pending {
    request: Request,
    handler: Box<dyn NetHandler>,
}

#[derive(Default)]
struct Queue {
    next: u32,
    pending: BTreeMap<u32, Pending>,
    unreported: Vec<u32>,
}

#[derive(Default)]
pub(crate) struct Resources(Mutex<Queue>);

impl NetProvider for Resources {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        // The same standard data URL produced from verified asset bytes works
        // in browsers and this native provider; no package or GUID registry lives here.
        if request.url.scheme() == "data" {
            let url = request.url.to_string();
            if url.len() > 45 * 1024 * 1024 {
                handler.failed(url, "UI data resource exceeds 32 MiB".into());
                return;
            }
            let decoded = data_url::DataUrl::process(&url)
                .map_err(|error| format!("Invalid data URL: {error:?}"))
                .and_then(|data| {
                    data.decode_to_vec()
                        .map_err(|error| format!("Invalid data URL bytes: {error:?}"))
                });
            match decoded {
                Ok((bytes, _)) if bytes.len() <= 32 * 1024 * 1024 => {
                    handler.bytes(url, Bytes::from(bytes))
                }
                Ok(_) => handler.failed(url, "UI data resource exceeds 32 MiB".into()),
                Err(message) => handler.failed(url, message),
            }
            return;
        }
        let mut queue = self.0.lock().unwrap();
        if queue.pending.len() >= 4096 || queue.next == u32::MAX {
            drop(queue);
            handler.failed(
                request.url.to_string(),
                "UI resource request limit exceeded".into(),
            );
            return;
        }
        queue.next += 1;
        let id = queue.next;
        queue.pending.insert(id, Pending { request, handler });
        queue.unreported.push(id);
    }
}

impl Resources {
    pub fn take_requests(&self) -> Vec<u32> {
        std::mem::take(&mut self.0.lock().unwrap().unreported)
    }

    pub fn url(&self, id: u32) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .pending
            .get(&id)
            .map(|pending| pending.request.url.to_string())
            .ok_or_else(|| "ui-stale-resource: request is no longer pending".into())
    }

    pub fn complete(&self, id: u32, result: Result<Vec<u8>, String>) -> Result<(), String> {
        let pending = self
            .0
            .lock()
            .unwrap()
            .pending
            .remove(&id)
            .ok_or_else(|| "ui-stale-resource: request is no longer pending".to_string())?;
        if pending
            .request
            .signal
            .as_ref()
            .is_some_and(|signal| signal.aborted())
        {
            return Ok(());
        }
        let url = pending.request.url.to_string();
        // Parsers can synchronously enqueue nested @import or @font-face work:
        // never hold the transport mutex while invoking a handler.
        match result {
            Ok(bytes) => pending.handler.bytes(url, Bytes::from(bytes)),
            Err(message) => pending.handler.failed(url, message),
        }
        Ok(())
    }
}
