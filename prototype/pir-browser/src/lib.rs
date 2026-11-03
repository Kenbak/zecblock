//! Local-only browser binding for the pinned upstream native PIR implementation.
//! This bounded fixture profile is not a production wallet-pir HTTP endpoint.
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zakura_pir_client::transparent::native::{NativeSecret, TableClientExt, TableProfile};
use zakura_pir_protocol::transparent::{
    events::Txid,
    shard::{
        display::placement_row,
        txid::{self, Address, Tag},
    },
};

pub mod full_record;
mod global_client;
#[path = "global.rs"]
pub mod global_data;
pub use global_client::GlobalPirBrowser;

const SCHEMA: &str = "zecblock-private-tx-fixture-v1";
const GEOMETRY: &str = "fixture-2k";
const ROWS: u64 = 2048;
const ROW_BYTES: u32 = 2048;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: String,
    geometry: String,
    table: String,
    rows: u64,
    row_bytes: u32,
    placement_seed: u32,
    shard: u64,
    bucket: u32,
    scheme: zakura_pir_protocol::transparent::native::NativeScheme,
    public_sha256: String,
}

struct Pending {
    secret: NativeSecret,
    txid: Txid,
    display_txid: String,
    row: u64,
}

/// One client of the fixed, locally published fixture table.
/// Secrets and row selection stay in WASM until a response is decoded or cancelled.
#[wasm_bindgen]
pub struct PirBrowser {
    profile: TableProfile,
    public: Vec<u8>,
    pending: Option<Pending>,
}

fn js_error(message: impl ToString) -> JsValue {
    JsValue::from_str(&message.to_string())
}

fn parse_txid(display: &str) -> Result<Txid, String> {
    if display.len() != 64 || !display.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Enter a 64-character hexadecimal transaction ID.".into());
    }
    let mut bytes: [u8; 32] = hex::decode(display)
        .map_err(|_| "Invalid transaction ID")?
        .try_into()
        .map_err(|_| "Invalid transaction ID")?;
    // Upstream Txid and Tag use serialized/internal order; URLs use display order.
    bytes.reverse();
    Ok(Txid(bytes))
}

fn address_json(address: Address) -> serde_json::Value {
    json!({"kind": address.kind, "hash": hex::encode(address.hash)})
}

#[wasm_bindgen]
impl PirBrowser {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str, public_setup: &[u8]) -> Result<PirBrowser, JsValue> {
        let manifest: Manifest = serde_json::from_str(manifest_json).map_err(js_error)?;
        // Parameters are pinned by this client, never chosen by an untrusted server.
        if manifest.schema != SCHEMA
            || manifest.geometry != GEOMETRY
            || manifest.table != "txdirectory"
            || manifest.rows != ROWS
            || manifest.row_bytes != ROW_BYTES
            || manifest.placement_seed != 0
            || manifest.shard != 0
            || manifest.bucket != 0
        {
            return Err(js_error("Unsupported fixture manifest"));
        }
        let profile = TableProfile::new(SCHEMA, GEOMETRY, "txdirectory", ROWS, ROW_BYTES)
            .map_err(js_error)?;
        if manifest.scheme != profile.scheme
            || public_setup.len() != profile.scheme.public_bytes
            || hex::encode(Sha256::digest(public_setup)) != manifest.public_sha256
        {
            return Err(js_error(
                "Fixture setup or profile does not match its manifest",
            ));
        }
        Ok(Self {
            profile,
            public: public_setup.to_vec(),
            pending: None,
        })
    }

    /// Generate a fresh upstream PIR key and encrypted selection with browser entropy.
    /// This returns only K_g plus the encrypted selection; no txid or row is framed.
    pub fn make_query(&mut self, display_txid: &str) -> Result<Vec<u8>, JsValue> {
        if self.pending.is_some() {
            return Err(js_error("Finish or cancel the pending private query first"));
        }
        let txid = parse_txid(display_txid).map_err(js_error)?;
        let row = placement_row(&Tag::of(&txid), 0, 0, 0, ROWS);
        let (secret, query) = self.profile.prepare(row as usize).map_err(js_error)?;
        self.pending = Some(Pending {
            secret,
            txid,
            display_txid: display_txid.to_ascii_lowercase(),
            row,
        });
        Ok(query)
    }

    /// Decode one packed upstream response and validate the canonical Display row.
    /// A failed response consumes the pending state; a retry must make a fresh query.
    pub fn decode_response(&mut self, response: &[u8]) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| js_error("No pending private query"))?;
        let row = self
            .profile
            .decode(&pending.secret, &self.public, response)
            .map_err(js_error)?;
        let entry = txid::find_entry(&[row], &pending.txid, |tag| {
            placement_row(tag, 0, 0, 0, ROWS) == pending.row
        })
        .map_err(js_error)?;
        let mut result = json!({
            "txid": pending.display_txid,
            "found": entry.is_some(),
            "scope": "Bounded local fixture; trusted publisher summary, not transaction authentication",
            "codec": txid::CODEC,
        });
        if let Some(entry) = entry {
            let outputs: Vec<_> = entry
                .outputs
                .iter()
                .enumerate()
                .filter_map(|(index, output)| {
                    output.map(|output| {
                        json!({
                            "index": index,
                            "valueZatoshis": output.value.to_string(),
                            "address": address_json(output.address),
                        })
                    })
                })
                .collect();
            let facts = json!({
                "coinbase": entry.coinbase,
                "hasShieldedComponents": entry.shielded_components,
                "feeZatoshis": entry.fee.to_string(),
                "inputCount": entry.input_count,
                "outputCount": entry.output_count,
                "moreThanTwoOutputs": entry.more_than_two_outputs(),
                "multipleSourceScripts": entry.multiple_source_scripts,
                "shieldedAndTransparentFunding": entry.shielded_and_transparent_funding,
                "completeDisplaySummary": entry.is_complete(),
                "source": address_json(entry.source),
                "outputs": outputs,
            });
            result
                .as_object_mut()
                .unwrap()
                .extend(facts.as_object().unwrap().clone());
        }
        serde_json::to_string(&result).map_err(js_error)
    }

    /// Drop pending state. This is not a claim of guaranteed memory erasure.
    pub fn cancel_query(&mut self) {
        self.pending = None;
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullDirectoryEntry {
    txid: String,
    rows: Vec<usize>,
    record_bytes: usize,
    record_sha256: String,
}

struct FullLookup {
    entry: Option<FullDirectoryEntry>,
    next_query: usize,
    next_response: usize,
    secrets: Vec<Option<NativeSecret>>,
    assembled: Vec<u8>,
}

/// Bound request-local keys and transport buffers before accepting a publication.
/// At 64 chunks the secret coefficient vectors contain at most 1 MiB; this is
/// not an estimate of the complete browser/WASM resident memory.
pub const MAX_BATCH_CHUNKS: usize = 64;

fn batch_chunk_count(value: &serde_json::Value) -> Result<usize, String> {
    value
        .as_u64()
        .filter(|&n| n > 0 && n <= MAX_BATCH_CHUNKS as u64)
        .map(|n| n as usize)
        .ok_or_else(|| "Unsupported full-record batch chunk count".into())
}

/// Full confirmed records from one explicitly bounded, versioned publication.
/// Every lookup reads the same number of fixed-size encrypted chunks.
#[wasm_bindgen]
pub struct FullPirBrowser {
    manifest: serde_json::Value,
    publication_id: String,
    profile: TableProfile,
    public: Vec<u8>,
    chunk_count: usize,
    cover_row: Option<usize>,
    catalogue: std::collections::BTreeMap<String, FullDirectoryEntry>,
    lookup: Option<FullLookup>,
}

fn canonical_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_full_catalogue(
    manifest: &serde_json::Value,
    chunk_count: usize,
    cover_row: Option<usize>,
) -> Result<std::collections::BTreeMap<String, FullDirectoryEntry>, String> {
    let entries: Vec<FullDirectoryEntry> =
        serde_json::from_value(manifest["catalogue"].clone()).map_err(|error| error.to_string())?;
    if entries.is_empty()
        || entries.len() > cover_row.unwrap_or(full_record::ROWS)
        || cover_row.is_none()
            && entries
                .len()
                .checked_mul(chunk_count)
                .is_none_or(|n| n > full_record::ROWS)
    {
        return Err("Full-record catalogue exceeds its pinned table".into());
    }
    let mut catalogue = std::collections::BTreeMap::new();
    let mut used_rows = std::collections::HashSet::new();
    let mut max_actual = 0;
    for entry in entries {
        let actual = entry.record_bytes.div_ceil(full_record::PAYLOAD_BYTES);
        let expected = if cover_row.is_some() {
            actual
        } else {
            chunk_count
        };
        if !canonical_hash(&entry.txid)
            || !canonical_hash(&entry.record_sha256)
            || entry.rows.len() != expected
            || actual == 0
            || actual > chunk_count
            || entry
                .rows
                .iter()
                .any(|&row| row >= cover_row.unwrap_or(full_record::ROWS) || !used_rows.insert(row))
            || catalogue.contains_key(&entry.txid)
        {
            return Err("Invalid full-record catalogue allocation or commitment".into());
        }
        max_actual = max_actual.max(actual);
        catalogue.insert(entry.txid.clone(), entry);
    }
    if cover_row.is_some() && max_actual != chunk_count {
        return Err("Compact publication batch count must match its largest record".into());
    }
    Ok(catalogue)
}

#[wasm_bindgen]
impl FullPirBrowser {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str, public_setup: &[u8]) -> Result<FullPirBrowser, JsValue> {
        let manifest: serde_json::Value = serde_json::from_str(manifest_json).map_err(js_error)?;
        if manifest["schema"] != full_record::SCHEMA
            || manifest["geometry"] != full_record::GEOMETRY
            || manifest["table"] != full_record::TABLE
            || manifest["rows"] != full_record::ROWS
            || manifest["rowBytes"] != full_record::ROW_BYTES
            || manifest["payloadBytes"] != full_record::PAYLOAD_BYTES
            || manifest["network"] != "mainnet"
        {
            return Err(js_error("Unsupported full-record publication"));
        }
        let publication_id = full_record::publication_id(&manifest).map_err(js_error)?;
        if manifest["publicationId"] != publication_id {
            return Err(js_error("Full-record publication identity mismatch"));
        }
        let chunk_count = batch_chunk_count(&manifest["chunkCount"]).map_err(js_error)?;
        let profile = full_record::profile().map_err(js_error)?;
        if manifest["scheme"] != serde_json::to_value(&profile.scheme).map_err(js_error)?
            || public_setup.len() != profile.scheme.public_bytes
            || manifest["publicSha256"] != hex::encode(Sha256::digest(public_setup))
        {
            return Err(js_error(
                "Full-record public setup or pinned native profile mismatch",
            ));
        }
        let cover_row = full_record::packing_cover_row(&manifest).map_err(js_error)?;
        let catalogue =
            validate_full_catalogue(&manifest, chunk_count, cover_row).map_err(js_error)?;
        Ok(Self {
            manifest,
            publication_id,
            profile,
            public: public_setup.to_vec(),
            chunk_count,
            cover_row,
            catalogue,
            lookup: None,
        })
    }

    /// Resolve only in the uniformly downloaded local directory. An unknown
    /// txid is outside this publication; it is not a claim of chain absence.
    pub fn begin_query(&mut self, txid: &str) -> Result<u32, JsValue> {
        self.begin_lookup(txid).map_err(js_error)
    }

    /// A collection lookup uses this on every non-selected segment. All C
    /// encrypted cover requests and responses follow the same fixed schedule.
    pub fn begin_cover_query(&mut self) -> Result<u32, JsValue> {
        self.begin_cover_lookup().map_err(js_error)
    }

    /// Generate the whole fixed query batch in order before dispatch or decode.
    /// Reply bytes cannot be consumed until every query has been generated.
    pub fn make_chunk_query(&mut self, index: u32) -> Result<Vec<u8>, JsValue> {
        self.generate_chunk_query(index as usize).map_err(js_error)
    }

    /// Decode replies in batch order only after query generation is complete.
    /// The transport must collect the entire fixed response schedule before
    /// calling this method. Any failure discards all keys and partial content.
    pub fn decode_chunk_response(&mut self, response: &[u8]) -> Result<Option<String>, JsValue> {
        self.decode_batch_response(response).map_err(js_error)
    }

    /// Discard partial results and all retained per-query secrets. The upstream
    /// NativeSecret destructor zeroizes its coefficient vector; complete browser
    /// or device memory erasure is not claimed.
    pub fn cancel_query(&mut self) {
        self.lookup = None;
    }
}

impl FullPirBrowser {
    fn begin_lookup(&mut self, txid: &str) -> Result<u32, String> {
        if self.lookup.is_some() {
            return Err("Finish or cancel the pending full-record lookup first".into());
        }
        full_record::parse_display_txid(txid)?;
        let entry = self
            .catalogue
            .get(&txid.to_ascii_lowercase())
            .cloned()
            .ok_or(
                "Transaction is outside this publication's catalogue; chain status is unknown",
            )?;
        self.lookup = Some(FullLookup {
            assembled: Vec::with_capacity(entry.record_bytes),
            entry: Some(entry),
            next_query: 0,
            next_response: 0,
            secrets: (0..self.chunk_count).map(|_| None).collect(),
        });
        Ok(self.chunk_count as u32)
    }

    fn begin_cover_lookup(&mut self) -> Result<u32, String> {
        if self.lookup.is_some() || self.cover_row.is_none() {
            return Err("Compact cover query unavailable or another lookup is pending".into());
        }
        self.lookup = Some(FullLookup {
            entry: None,
            next_query: 0,
            next_response: 0,
            secrets: (0..self.chunk_count).map(|_| None).collect(),
            assembled: Vec::new(),
        });
        Ok(self.chunk_count as u32)
    }

    fn generate_chunk_query(&mut self, index: usize) -> Result<Vec<u8>, String> {
        let mut lookup = self.lookup.take().ok_or("No pending full-record lookup")?;
        if lookup.next_query != index
            || index >= self.chunk_count
            || lookup.next_response != 0
            || lookup.secrets[index].is_some()
        {
            return Err("Invalid full-record query batch sequence".into());
        }
        let row = lookup
            .entry
            .as_ref()
            .and_then(|entry| entry.rows.get(index).copied())
            .or(self.cover_row)
            .ok_or("Missing full-record query row")?;
        let (secret, query) = self.profile.prepare(row)?;
        lookup.secrets[index] = Some(secret);
        lookup.next_query += 1;
        self.lookup = Some(lookup);
        Ok(query)
    }

    /// Return the validated whole result only after every equally padded chunk
    /// has arrived. Any error discards all partial content and pending secrets.
    fn decode_batch_response(&mut self, response: &[u8]) -> Result<Option<String>, String> {
        let mut lookup = self.lookup.take().ok_or("No pending full-record lookup")?;
        if lookup.next_query != self.chunk_count {
            return Err("Generate the complete fixed query batch before decoding any reply".into());
        }
        let secret = lookup.secrets[lookup.next_response]
            .take()
            .ok_or("No pending encrypted chunk")?;
        let row = self.profile.decode(&secret, &self.public, response)?;
        if let Some(entry) = lookup
            .entry
            .as_ref()
            .filter(|entry| lookup.next_response < entry.rows.len())
        {
            let context = full_record::ChunkContext {
                publication_id: &self.publication_id,
                txid: &entry.txid,
                index: lookup.next_response,
                count: entry.rows.len(),
                record_bytes: entry.record_bytes,
                record_sha256: &entry.record_sha256,
            };
            let payload = full_record::decode_chunk(&context, &row)?;
            lookup.assembled.extend(payload);
        } else if self.cover_row.is_none()
            || row.len() != full_record::ROW_BYTES
            || row.iter().any(|&byte| byte != 0)
        {
            return Err("Invalid full-record cover reply".into());
        }
        lookup.next_response += 1;
        if lookup.next_response < self.chunk_count {
            self.lookup = Some(lookup);
            return Ok(None);
        }
        let Some(entry) = lookup.entry else {
            return Ok(None);
        };
        if lookup.assembled.len() != entry.record_bytes
            || hex::encode(Sha256::digest(&lookup.assembled)) != entry.record_sha256
        {
            return Err("Full-record checksum or length mismatch".into());
        }
        let record = full_record::decode_record_from_storage(
            &lookup.assembled,
            &self.manifest,
            &entry.txid,
        )?;
        full_record::result_envelope(record, &self.publication_id).map(Some)
    }
}

#[cfg(test)]
mod batch_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_display_order_is_reversed_for_upstream_tagging() {
        let display = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let txid = parse_txid(display).unwrap();
        assert_eq!(txid.0[0], 31);
        assert_eq!(txid.0[31], 0);
        assert!(parse_txid("not-a-transaction").is_err());
        assert!(parse_txid(&"g".repeat(64)).is_err());
    }
}
