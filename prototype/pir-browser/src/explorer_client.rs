//! Browser client for the private explorer. The txid, its row and the
//! decryption secrets stay in WASM; the page only moves opaque uploads and
//! replies between this object and the server.
//!
//! A publication is accepted only with a valid signature from the pinned
//! ZecBlock key, and every decrypted row must prove itself against the
//! signed roots before its bytes are read. A "not found" is therefore proven
//! too: the whole verified bucket lacks the txid.
use crate::explorer_record::{BLOCK_POINTER, BlockRecord, Record, block_height_key, layout, publication};
use reinspiring::native::{NativeDecoder, NativeDecodingState};
use serde_json::json;
use wasm_bindgen::prelude::*;
use zakura_pir_client::transparent::native::{NativeSecret, TableClientExt, TableProfile};
use zakura_pir_protocol::native::{D, Q_BITS, bits::contiguous_bytes_to_u64s};

const TABLE: &str = "txdirectory";

fn js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

struct Table {
    kind: &'static str,
    profile: TableProfile,
    side: publication::Side,
    /// Public mask transforms for every instance, built once per publication,
    /// so a reply decodes without redoing them.
    decoder: NativeDecoder,
}

/// One encrypted selection of a local row and, once prepared, its
/// request-local decoding products (computed from the secret alone while the
/// reply is in flight).
struct Query {
    row: usize,
    secret: NativeSecret,
    state: Option<NativeDecodingState>,
}

impl Table {
    fn new(kind: &'static str, side: publication::Side, publics: &[u8]) -> Result<Self, String> {
        let profile = TableProfile::new(layout::SCHEMA_NAME, &layout::geometry(kind, side.rows), TABLE, side.rows as u64, layout::ROW_BYTES as u32)?;
        let size = profile.scheme.public_bytes;
        if publics.len() != size * side.instances {
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
        Ok(Table { kind, profile, side, decoder })
    }

    /// Count-prefixed body asking every instance for each local row.
    fn query(&self, local_rows: &[usize]) -> Result<(Vec<Query>, Vec<u8>), String> {
        let mut body = (local_rows.len() as u32).to_le_bytes().to_vec();
        let mut queries = Vec::with_capacity(local_rows.len());
        for &row in local_rows {
            let (secret, upload) = self.profile.prepare(row)?;
            queries.push(Query { row, secret, state: None });
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

    /// Verified payloads: one Vec per query, one payload per instance.
    fn decode(&self, queries: &mut [Query], reply: &[u8]) -> Result<Vec<Vec<Vec<u8>>>, String> {
        let size = self.profile.scheme.response_bytes;
        let instances = self.side.instances;
        if reply.len() != queries.len() * instances * size {
            return Err("reply has the wrong length".into());
        }
        self.prepare(queries)?;
        let shift = Q_BITS - self.profile.native.response_bits;
        reply
            .chunks(size * instances)
            .zip(queries.iter())
            .map(|(per, query)| {
                let bodies: Vec<u64> = per.chunks_exact(size)
                    .flat_map(|response| contiguous_bytes_to_u64s(response, self.profile.native.response_bits))
                    .map(|value| value << shift)
                    .collect();
                let values = query.state.as_ref().unwrap().decrypt(&bodies).map_err(|e| e.to_string())?;
                if values.len() != instances * self.profile.cols {
                    return Err("decoded reply has the wrong shape".to_string());
                }
                values.chunks_exact(self.profile.cols).enumerate().map(|(instance, row)| {
                    let row: Vec<u8> = row[..layout::ROW_BYTES].iter().map(|&v| v as u8).collect();
                    let payload = layout::verify_row(self.kind, instance as u32, query.row as u32, &row, &self.side.roots[instance], self.side.depth)?;
                    Ok(payload.to_vec())
                }).collect()
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

/// Lookup key (hex) of the block at `height` in a block publication.
#[wasm_bindgen]
pub fn block_key(height: u32) -> String {
    hex::encode(block_height_key(height))
}

#[wasm_bindgen]
pub struct ExplorerPirBrowser {
    main: Table,
    overflow: Table,
    /// "tx" or "block".
    kind: String,
    snapshot_tip: u64,
    publication_id: String,
    pending: Option<Pending>,
}

#[wasm_bindgen]
impl ExplorerPirBrowser {
    /// `manifest` must be the exact bytes the signature covers.
    #[wasm_bindgen(constructor)]
    pub fn new(manifest: &[u8], signature: &[u8], main_publics: &[u8], overflow_publics: &[u8]) -> Result<ExplorerPirBrowser, JsValue> {
        let verified = publication::verify(manifest, signature).map_err(js)?;
        let main = Table::new("main", verified.main, main_publics).map_err(js)?;
        let overflow = Table::new("overflow", verified.overflow, overflow_publics).map_err(js)?;
        let id = {
            use sha2::{Digest, Sha256};
            hex::encode(&Sha256::digest(manifest)[..12])
        };
        let kind = verified.value["kind"].as_str().unwrap_or("tx").to_owned();
        if kind != "tx" && kind != "block" {
            return Err(JsValue::from_str("unsupported publication kind"));
        }
        Ok(ExplorerPirBrowser { snapshot_tip: verified.tip, publication_id: id, kind, main, overflow, pending: None })
    }

    /// Encrypted main-table request for a displayed txid. Every lookup has
    /// this same shape, whatever the transaction.
    pub fn query_main(&mut self, txid_hex: &str) -> Result<Vec<u8>, JsValue> {
        let txid: [u8; 32] = hex::decode(txid_hex.trim())
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| JsValue::from_str("Enter a 64-character transaction ID"))?;
        let row = layout::row_of(&txid, self.main.side.rows as u64) as usize;
        let (queries, body) = self.main.query(&[row]).map_err(js)?;
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
        .map_err(js)
    }

    /// The result JSON. A large transaction comes back as a preview with
    /// `partial: true` and `fullRows`, the padded row count `query_full`
    /// would request.
    pub fn decode_main(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Main { txid, mut queries }) = self.pending.take() else {
            return Err(JsValue::from_str("no main query is pending"));
        };
        let bucket = self.main.decode(&mut queries, reply).map_err(js)?.remove(0).concat();
        // Only a recent publication carries these; a base bucket never does.
        let spent = layout::find_spent(&bucket, &txid).map_err(js)?;
        let mut result = match layout::find(&bucket, &txid).map_err(js)? {
            layout::Entry::Absent => json!({"found":false,"txid":hex::encode(txid),"snapshotTip":self.snapshot_tip,"verified":true}),
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

    /// One main-table query for row 0 whose reply is discarded: the second
    /// round of a block search that round one already answered. Leaves the
    /// pending lookup (and any preview) untouched.
    pub fn query_dummy_main(&self) -> Result<Vec<u8>, JsValue> {
        Ok(self.main.query(&[0]).map_err(js)?.1)
    }

    /// `count` overflow queries for row 0, sent to the publication that does
    /// not hold the record while the other fetches its full form, so both
    /// tables always see the same padded request.
    pub fn query_dummy(&self, count: usize) -> Result<Vec<u8>, JsValue> {
        Ok(self.overflow.query(&vec![0; count.max(1)]).map_err(js)?.1)
    }

    /// Padded overflow request for the full form of the last preview.
    pub fn query_full(&mut self) -> Result<Vec<u8>, JsValue> {
        let Some(Pending::Preview { txid, start, len }) = self.pending.take() else {
            return Err(JsValue::from_str("no preview is pending"));
        };
        let rows = self.overflow.side.rows;
        let globals: Vec<u64> = layout::overflow_rows(start, len).collect();
        let mut local: Vec<usize> = globals.iter().map(|g| *g as usize % rows).collect();
        // Padding repeats the first row; the server cannot see which rows.
        local.resize(layout::padded_rows(local.len()), local[0]);
        let (queries, body) = self.overflow.query(&local).map_err(js)?;
        self.pending = Some(Pending::Full { txid, start, len, globals, queries });
        Ok(body)
    }

    pub fn decode_full(&mut self, reply: &[u8]) -> Result<String, JsValue> {
        let Some(Pending::Full { txid, start, len, globals, mut queries }) = self.pending.take() else {
            return Err(JsValue::from_str("no full-record fetch is pending"));
        };
        let rows = self.overflow.side.rows;
        let fetched = self.overflow.decode(&mut queries, reply).map_err(js)?;
        let bytes: Vec<u8> = globals.iter().zip(&fetched).flat_map(|(g, per)| per[*g as usize / rows].clone()).collect();
        let offset = (start - globals[0] * layout::PAYLOAD as u64) as usize;
        let record = bytes.get(offset..offset + len).ok_or_else(|| JsValue::from_str("overflow record exceeds fetched rows"))?;
        Ok(self.finish(txid, record, None)?.to_string())
    }

    #[wasm_bindgen(getter)]
    pub fn snapshot_tip(&self) -> f64 {
        self.snapshot_tip as f64
    }

    /// First 12 bytes of SHA-256 of the signed manifest, as the server names it.
    #[wasm_bindgen(getter)]
    pub fn publication_id(&self) -> String {
        self.publication_id.clone()
    }

    fn finish(&self, txid: [u8; 32], bytes: &[u8], full_rows: Option<usize>) -> Result<serde_json::Value, JsValue> {
        let mut json = if self.kind == "tx" {
            Record::decode(txid, bytes).map_err(js)?.to_json()
        } else if bytes.first() == Some(&BLOCK_POINTER) {
            // A block hash resolves to its height; the record is under that key.
            let mut at = 1;
            let height = bytes[1..].iter().take(5).enumerate().try_fold(0u64, |v, (i, &b)| {
                at += 1;
                let v = v | u64::from(b & 0x7f) << (7 * i);
                if b & 0x80 == 0 { Err(v) } else { Ok(v) }
            }).err().ok_or_else(|| JsValue::from_str("bad block pointer"))?;
            if at != bytes.len() {
                return Err(JsValue::from_str("bad block pointer"));
            }
            json!({"pointer": height})
        } else {
            BlockRecord::decode(bytes).map_err(js)?.to_json()
        };
        json["found"] = json!(true);
        json["verified"] = json!(true);
        json["snapshotTip"] = json!(self.snapshot_tip);
        json["partial"] = json!(full_rows.is_some());
        if let Some(rows) = full_rows {
            json["fullRows"] = json!(rows);
        }
        Ok(json)
    }
}
