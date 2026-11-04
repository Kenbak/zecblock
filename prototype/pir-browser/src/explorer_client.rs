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
    Main { txid: [u8; 32], secrets: Vec<NativeSecret> },
    /// A preview was shown; the full record can be fetched on request.
    Preview { txid: [u8; 32], start: u64, len: usize },
    Full { txid: [u8; 32], start: u64, len: usize, globals: Vec<u64>, secrets: Vec<NativeSecret> },
}

#[wasm_bindgen]
pub struct ExplorerPirBrowser {
    main: Table,
    overflow: Table,
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
        Ok(ExplorerPirBrowser { snapshot_tip: manifest.snapshot_tip, main, overflow, pending: None })
    }

    /// Encrypted main-table request for a displayed txid. Every lookup has
    /// this same shape, whatever the transaction.
    pub fn query_main(&mut self, txid_hex: &str) -> Result<Vec<u8>, JsValue> {
        let txid: [u8; 32] = hex::decode(txid_hex.trim())
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| JsValue::from_str("Enter a 64-character transaction ID"))?;
        let row = layout::row_of(&txid, self.main.rows as u64) as usize;
        let (secrets, body) = self.main.query(&[row]).map_err(|e| JsValue::from_str(&e))?;
        self.pending = Some(Pending::Main { txid, secrets });
        Ok(body)
    }

    /// The result JSON. A large transaction comes back as a preview with
    /// `partial: true` and `fullRows`, the padded row count `query_full`
    /// would request.
    pub fn decode_main(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Main { txid, secrets }) = self.pending.take() else {
            return Err(JsValue::from_str("no main query is pending"));
        };
        let rows = self.main.decode(&secrets, reply).map_err(|e| JsValue::from_str(&e))?;
        let bucket = rows[0].concat();
        // Only a recent publication carries these; a base bucket never does.
        let spent = layout::find_spent(&bucket, &txid).map_err(|e| JsValue::from_str(&e))?;
        let mut result = match layout::find(&bucket, &txid).map_err(|e| JsValue::from_str(&e))? {
            layout::Entry::Absent => json!({"found":false,"txid":hex::encode(txid),"snapshotTip":self.snapshot_tip}),
            layout::Entry::Inline(bytes) => self.finish(txid, &bytes, None)?,
            layout::Entry::Preview { preview, start, len } => {
                let rows = layout::padded_rows(layout::overflow_rows(start, len).count());
                self.pending = Some(Pending::Preview { txid, start, len });
                self.finish(txid, &preview, Some(rows))?
            }
        };
        if let Some(indices) = spent {
            result["outputsSpentSinceBase"] = json!(indices);
        }
        Ok(result.to_string())
    }

    /// `count` overflow queries for row 0, sent to the publication that does
    /// not hold the record while the other fetches its full form, so both
    /// tables always see the same padded request.
    pub fn query_dummy(&self, count: usize) -> Result<Vec<u8>, JsValue> {
        Ok(self.overflow.query(&vec![0; count.max(1)]).map_err(|e| JsValue::from_str(&e))?.1)
    }

    /// Padded overflow request for the full form of the last preview.
    pub fn query_full(&mut self) -> Result<Vec<u8>, JsValue> {
        let Some(Pending::Preview { txid, start, len }) = self.pending.take() else {
            return Err(JsValue::from_str("no preview is pending"));
        };
        let globals: Vec<u64> = layout::overflow_rows(start, len).collect();
        let mut local: Vec<usize> = globals.iter().map(|g| *g as usize % self.overflow.rows).collect();
        // Padding repeats the first row; the server cannot see which rows.
        local.resize(layout::padded_rows(local.len()), local[0]);
        let (secrets, body) = self.overflow.query(&local).map_err(|e| JsValue::from_str(&e))?;
        self.pending = Some(Pending::Full { txid, start, len, globals, secrets });
        Ok(body)
    }

    pub fn decode_full(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Full { txid, start, len, globals, secrets }) = self.pending.take() else {
            return Err(JsValue::from_str("no full-record fetch is pending"));
        };
        let rows = self.overflow.decode(&secrets, reply).map_err(|e| JsValue::from_str(&e))?;
        let bytes: Vec<u8> = globals.iter().zip(&rows).flat_map(|(g, per)| per[*g as usize / self.overflow.rows].clone()).collect();
        let offset = (start - globals[0] * layout::ROW_BYTES as u64) as usize;
        let record = bytes.get(offset..offset + len).ok_or_else(|| JsValue::from_str("overflow record exceeds fetched rows"))?;
        Ok(self.finish(txid, record, None)?.to_string())
    }

    #[wasm_bindgen(getter)]
    pub fn snapshot_tip(&self) -> f64 {
        self.snapshot_tip as f64
    }

    fn finish(&self, txid: [u8; 32], bytes: &[u8], full_rows: Option<usize>) -> Result<serde_json::Value, JsValue> {
        let mut json = Record::decode(txid, bytes).map_err(|e| JsValue::from_str(&e))?.to_json();
        json["found"] = json!(true);
        json["snapshotTip"] = json!(self.snapshot_tip);
        json["partial"] = json!(full_rows.is_some());
        if let Some(rows) = full_rows {
            json["fullRows"] = json!(rows);
        }
        Ok(json)
    }
}
