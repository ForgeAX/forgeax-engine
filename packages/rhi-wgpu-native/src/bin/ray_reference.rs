use forgeax_rhi_wgpu_native::reference::{run_batch, ReferenceBatch};
use std::io::{Read, Write};

fn main() {
    // This transport is for a bounded scene re-execution, not a second native tape format.
    let result = (|| -> Result<_, String> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("reference input exceeds 32 MiB".into());
        }
        let batch: ReferenceBatch = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        pollster::block_on(run_batch(batch)).map_err(|e| format!("{}: {}", e.code(), e))
    })();
    match result {
        Ok(result) => {
            serde_json::to_writer(std::io::stdout(), &result).expect("write reference result");
        }
        Err(detail) => {
            let _ = writeln!(std::io::stderr(), "{detail}");
            std::process::exit(1);
        }
    }
}
