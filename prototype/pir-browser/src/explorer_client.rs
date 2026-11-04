//! Browser client for the private explorer test. The txid, its row and the
//! decryption secrets stay in WASM; the page only moves opaque uploads and
//! replies between this object and the server.
use crate::explorer_record::{Record, layout};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;
use reinspiring::native::{NativeDecoder, NativeDecodingState};
use zakura_pir_client::transparent::native::{NativeSecret, TableClientExt, TableProfile};
use zakura_pir_protocol::native::{D, Q_BITS, bits::contiguous_bytes_to_u64s};

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
    instances: usize,
    rows: usize,
    /// Public mask transforms for every instance, built once per publication,
    /// so a reply decodes without redoing them.
    decoder: NativeDecoder,
}

/// One encrypted selection and, once prepared, its request-local decoding
/// products (computed from the secret alone while the reply is in flight).
struct Query {
    secret: NativeSecret,
    state: Option<NativeDecodingState>,
}

impl Table {
    fn new(kind: &str, side: &Side, publics: &[u8]) -> Result<Self, String> {
        let profile = TableProfile::new(layout::SCHEMA_NAME, &layout::geometry(kind, side.rows), TABLE, side.rows as u64, layout::ROW_BYTES as u32)?;
        let size = profile.scheme.public_bytes;
        if side.instances == 0 || publics.len() != size * side.instances {
            return Err(format!("{kind} public parameters have the wrong length"));
        }
        if profile.native.entry_bytes() != 1 {
            return Err("the explorer decoder requires one byte per entry".into());
        }
        let (mut first, mut other) = (Vec::new(), Vec::new());
        for setup in publics.chunks_exact(size) {
            let masks: Vec<u64> = contiguous_bytes_to_u64s(setup, profile.native.mask_bits)
                .into_iter()
                .map(|value| value << (Q_BITS - profile.native.mask_bits))
                .collect();
            if masks.len() != 2 * profile.cols {
                return Err(format!("{kind} public mask shape mismatch"));
            }
            first.extend(masks[..profile.cols].chunks_exact(D).map(<[u64]>::to_vec));
            other.extend(masks[profile.cols..].chunks_exact(D).map(<[u64]>::to_vec));
        }
        let decoder = NativeDecoder::new(&profile.native.params(), &first, Some(&other)).map_err(|e| e.to_string())?;
        Ok(Table { profile, instances: side.instances, rows: side.rows, decoder })
    }

    /// Count-prefixed body asking every instance for each local row.
    fn query(&self, local_rows: &[usize]) -> Result<(Vec<Query>, Vec<u8>), String> {
        let mut body = (local_rows.len() as u32).to_le_bytes().to_vec();
        let mut queries = Vec::with_capacity(local_rows.len());
        for &row in local_rows {
            let (secret, upload) = self.profile.prepare(row)?;
            queries.push(Query { secret, state: None });
            body.extend(upload);
        }
        Ok((queries, body))
    }

    fn prepare(&self, queries: &mut [Query]) -> Result<(), String> {
        for query in queries.iter_mut().filter(|q| q.state.is_none()) {
            query.state = Some(self.decoder.prepare_request(&query.secret).map_err(|e| e.to_string())?);
        }
        Ok(())
    }

    /// Decoded rows: one Vec per query, one row per instance.
    fn decode(&self, queries: &mut [Query], reply: &[u8]) -> Result<Vec<Vec<Vec<u8>>>, String> {
        let size = self.profile.scheme.response_bytes;
        if reply.len() != queries.len() * self.instances * size {
            return Err("reply has the wrong length".into());
        }
        self.prepare(queries)?;
        let shift = Q_BITS - self.profile.native.response_bits;
        reply
            .chunks(size * self.instances)
            .zip(queries.iter())
            .map(|(per, query)| {
                let bodies: Vec<u64> = per.chunks_exact(size)
                    .flat_map(|response| contiguous_bytes_to_u64s(response, self.profile.native.response_bits))
                    .map(|value| value << shift)
                    .collect();
                let values = query.state.as_ref().unwrap().decrypt(&bodies).map_err(|e| e.to_string())?;
                if values.len() != self.instances * self.profile.cols {
                    return Err("decoded reply has the wrong shape".to_string());
                }
                Ok(values.chunks_exact(self.profile.cols).map(|row| row[..self.profile.row_bytes].iter().map(|&v| v as u8).collect()).collect())
            })
            .collect()
    }
}

enum Pending {
    Main { txid: [u8; 32], queries: Vec<Query> },
    /// A preview was shown; the full record can be fetched on request.
    Preview { txid: [u8; 32], start: u64, len: usize },
    Full { txid: [u8; 32], start: u64, len: usize, globals: Vec<u64>, queries: Vec<Query> },
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
        let (queries, body) = self.main.query(&[row]).map_err(|e| JsValue::from_str(&e))?;
        self.pending = Some(Pending::Main { txid, queries });
        Ok(body)
    }

    /// Computes the pending query's decoding products from its secret alone.
    /// Call it after sending the request, while the reply is in flight.
    pub fn prepare_decode(&mut self) -> Result<(), JsValue> {
        match &mut self.pending {
            Some(Pending::Main { queries, .. }) => self.main.prepare(queries),
            Some(Pending::Full { queries, .. }) => self.overflow.prepare(queries),
            _ => Ok(()),
        }
        .map_err(|e| JsValue::from_str(&e))
    }

    /// The result JSON. A large transaction comes back as a preview with
    /// `partial: true` and `fullRows`, the padded row count `query_full`
    /// would request.
    pub fn decode_main(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Main { txid, mut queries }) = self.pending.take() else {
            return Err(JsValue::from_str("no main query is pending"));
        };
        let rows = self.main.decode(&mut queries, reply).map_err(|e| JsValue::from_str(&e))?;
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
        let (queries, body) = self.overflow.query(&local).map_err(|e| JsValue::from_str(&e))?;
        self.pending = Some(Pending::Full { txid, start, len, globals, queries });
        Ok(body)
    }

    pub fn decode_full(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Full { txid, start, len, globals, mut queries }) = self.pending.take() else {
            return Err(JsValue::from_str("no full-record fetch is pending"));
        };
        let rows = self.overflow.decode(&mut queries, reply).map_err(|e| JsValue::from_str(&e))?;
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
