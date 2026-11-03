//! Browser client for the private explorer test. The txid, its row and the
//! decryption secrets stay in WASM; the page only moves opaque uploads and
//! replies between this object and the server.
use crate::explorer_record::{Record, layout};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;
use zakura_pir_client::transparent::native::{NativeSecret, TableClientExt, TableProfile};

const TABLE: &str = "txdirectory";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Side {
    instances: usize,
    rows: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: String,
    snapshot_tip: u64,
    row_bytes: usize,
    main: Side,
    overflow: Side,
}

struct Table {
    profile: TableProfile,
    publics: Vec<Vec<u8>>,
    rows: usize,
}

impl Table {
    fn new(kind: &str, side: &Side, publics: &[u8]) -> Result<Self, String> {
        let profile = TableProfile::new(layout::SCHEMA_NAME, &layout::geometry(kind, side.rows), TABLE, side.rows as u64, layout::ROW_BYTES as u32)?;
        let size = profile.scheme.public_bytes;
        if side.instances == 0 || publics.len() != size * side.instances {
            return Err(format!("{kind} public parameters have the wrong length"));
        }
        Ok(Table { publics: publics.chunks(size).map(<[u8]>::to_vec).collect(), profile, rows: side.rows })
    }

    /// Count-prefixed body asking every instance for each local row.
    fn query(&self, local_rows: &[usize]) -> Result<(Vec<NativeSecret>, Vec<u8>), String> {
        let mut body = (local_rows.len() as u32).to_le_bytes().to_vec();
        let mut secrets = Vec::with_capacity(local_rows.len());
        for &row in local_rows {
            let (secret, upload) = self.profile.prepare(row)?;
            secrets.push(secret);
            body.extend(upload);
        }
        Ok((secrets, body))
    }

    /// Decoded rows: one Vec per query, one row per instance.
    fn decode(&self, secrets: &[NativeSecret], reply: &[u8]) -> Result<Vec<Vec<Vec<u8>>>, String> {
        let size = self.profile.scheme.response_bytes;
        if reply.len() != secrets.len() * self.publics.len() * size {
            return Err("reply has the wrong length".into());
        }
        reply
            .chunks(size * self.publics.len())
            .zip(secrets)
            .map(|(per, secret)| per.chunks(size).zip(&self.publics).map(|(r, p)| self.profile.decode(secret, p, r)).collect())
            .collect()
    }
}

enum Pending {
    Main { txid: [u8; 32], instance: usize, secrets: Vec<NativeSecret> },
    Overflow { txid: [u8; 32], start: u64, len: usize, globals: Vec<u64>, secrets: Vec<NativeSecret> },
}

#[wasm_bindgen]
pub struct ExplorerPirBrowser {
    main: Table,
    overflow: Table,
    total_rows: u64,
    snapshot_tip: u64,
    pending: Option<Pending>,
}

#[wasm_bindgen]
impl ExplorerPirBrowser {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str, main_publics: &[u8], overflow_publics: &[u8]) -> Result<ExplorerPirBrowser, JsValue> {
        let manifest: Manifest = serde_json::from_str(manifest_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if manifest.schema != layout::SCHEMA_NAME || manifest.row_bytes != layout::ROW_BYTES {
            return Err(JsValue::from_str("unsupported private explorer manifest"));
        }
        let main = Table::new("main", &manifest.main, main_publics).map_err(|e| JsValue::from_str(&e))?;
        let overflow = Table::new("overflow", &manifest.overflow, overflow_publics).map_err(|e| JsValue::from_str(&e))?;
        Ok(ExplorerPirBrowser {
            total_rows: (manifest.main.instances * manifest.main.rows) as u64,
            snapshot_tip: manifest.snapshot_tip,
            main,
            overflow,
            pending: None,
        })
    }

    /// Encrypted main-table request for a displayed txid.
    pub fn query_main(&mut self, txid_hex: &str) -> Result<Vec<u8>, JsValue> {
        let txid: [u8; 32] = hex::decode(txid_hex.trim())
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| JsValue::from_str("Enter a 64-character transaction ID"))?;
        let global = layout::row_of(&txid, self.total_rows) as usize;
        let (secrets, body) = self.main.query(&[global % self.main.rows]).map_err(|e| JsValue::from_str(&e))?;
        self.pending = Some(Pending::Main { txid, instance: global / self.main.rows, secrets });
        Ok(body)
    }

    /// Either a finished result, or `{"needsOverflow":rows}` after which the
    /// page sends `query_overflow()` and passes its reply to `decode_overflow`.
    pub fn decode_main(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Main { txid, instance, secrets }) = self.pending.take() else {
            return Err(JsValue::from_str("no main query is pending"));
        };
        let rows = self.main.decode(&secrets, reply).map_err(|e| JsValue::from_str(&e))?;
        match layout::find(&rows[0][instance], &txid).map_err(|e| JsValue::from_str(&e))? {
            layout::Entry::Absent => Ok(json!({"found":false,"txid":hex::encode(txid),"snapshotTip":self.snapshot_tip}).to_string()),
            layout::Entry::Inline(bytes) => self.finish(txid, &bytes),
            layout::Entry::Overflow { start, len } => {
                let globals: Vec<u64> = layout::overflow_rows(start, len).collect();
                let count = globals.len();
                self.pending = Some(Pending::Overflow { txid, start, len, globals, secrets: Vec::new() });
                Ok(json!({"needsOverflow":count}).to_string())
            }
        }
    }

    pub fn query_overflow(&mut self) -> Result<Vec<u8>, JsValue> {
        let Some(Pending::Overflow { globals, secrets, .. }) = self.pending.as_mut() else {
            return Err(JsValue::from_str("no overflow fetch is pending"));
        };
        let local: Vec<usize> = globals.iter().map(|g| *g as usize % self.overflow.rows).collect();
        let (new_secrets, body) = self.overflow.query(&local).map_err(|e| JsValue::from_str(&e))?;
        *secrets = new_secrets;
        Ok(body)
    }

    pub fn decode_overflow(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Overflow { txid, start, len, globals, secrets }) = self.pending.take() else {
            return Err(JsValue::from_str("no overflow fetch is pending"));
        };
        let rows = self.overflow.decode(&secrets, reply).map_err(|e| JsValue::from_str(&e))?;
        let bytes: Vec<u8> = globals.iter().zip(&rows).flat_map(|(g, per)| per[*g as usize / self.overflow.rows].clone()).collect();
        let offset = (start - globals[0] * layout::ROW_BYTES as u64) as usize;
        let record = bytes.get(offset..offset + len).ok_or_else(|| JsValue::from_str("overflow record exceeds fetched rows"))?;
        self.finish(txid, record)
    }

    #[wasm_bindgen(getter)]
    pub fn snapshot_tip(&self) -> f64 {
        self.snapshot_tip as f64
    }

    fn finish(&self, txid: [u8; 32], bytes: &[u8]) -> Result<String, JsValue> {
        let mut json = Record::decode(txid, bytes).map_err(|e| JsValue::from_str(&e))?.to_json();
        json["found"] = json!(true);
        json["snapshotTip"] = json!(self.snapshot_tip);
        Ok(json.to_string())
    }
}
