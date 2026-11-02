//! Fixed-size full-record fixture rows shared by the browser and local publisher.
//! Cryptography remains in the pinned upstream native PIR implementation.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zakura_pir_protocol::transparent::{events::Txid, native::TableProfile};

pub const SCHEMA: &str = "zecblock-private-tx-full-v1";
pub const RECORD_SCHEMA: &str = "zecblock-private-tx-record-v1";
pub const GEOMETRY: &str = "full-2k-8k";
pub const TABLE: &str = "txdirectory";
pub const ROWS: usize = 2048;
pub const ROW_BYTES: usize = 8192;
pub const HEADER_BYTES: usize = 128;
pub const PAYLOAD_BYTES: usize = ROW_BYTES - HEADER_BYTES;
const MAGIC: &[u8; 8] = b"ZBFTX001";

pub const RECORD_CODEC: &str = "json-context-zlib-v1";
pub const MAX_DECODED_RECORD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ENCODED_RECORD_BYTES: usize = 64 * PAYLOAD_BYTES;
const STORED_MAGIC: &[u8; 8] = b"ZBTXZ001";
const STORED_HEADER: usize = 16;

/// The codec field is optional for existing uncompressed publications. Its
/// explicit value is included in the publication identity for new records.
pub fn record_codec(manifest: &Value) -> Result<Option<&str>, String> {
    match manifest.get("recordCodec") {
        None => Ok(None),
        Some(Value::String(codec)) if codec == RECORD_CODEC => Ok(Some(RECORD_CODEC)),
        _ => Err("Unsupported full-record storage codec".into()),
    }
}

/// Store only transaction-specific facts. Shared context is reconstructed from
/// the publication-bound manifest; a flag preserves the original presence of
/// decoded.hex when that field exactly duplicates raw.hex.
pub fn encode_record_for_storage(envelope: &Value) -> Result<Vec<u8>, String> {
    if serde_json::to_vec(envelope)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_DECODED_RECORD_BYTES
    {
        return Err("Decoded full-record envelope exceeds its limit".into());
    }
    let mut payload = envelope.clone();
    let object = payload
        .as_object_mut()
        .ok_or("Invalid full-record object")?;
    if object.contains_key("found") || object.contains_key("publicationId") {
        return Err("Full-record input contains reserved result context".into());
    }
    for field in ["schema", "network", "snapshot", "coverage"] {
        object
            .remove(field)
            .ok_or("Missing shared full-record context")?;
    }
    let restore_hex = payload["raw"]["hex"].is_string()
        && payload["raw"]["decoded"]["hex"] == payload["raw"]["hex"];
    if restore_hex {
        payload["raw"]["decoded"]
            .as_object_mut()
            .ok_or("Invalid decoded transaction object")?
            .remove("hex");
    }
    let decoded = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if decoded.is_empty() || decoded.len() > MAX_DECODED_RECORD_BYTES {
        return Err("Decoded full-record storage payload exceeds its limit".into());
    }
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&decoded, 6);
    let mut stored = Vec::with_capacity(STORED_HEADER + compressed.len());
    stored.extend_from_slice(STORED_MAGIC);
    stored.extend_from_slice(&(decoded.len() as u32).to_le_bytes());
    stored.push(u8::from(restore_hex));
    stored.extend_from_slice(&[0; 3]);
    stored.extend(compressed);
    if stored.len() > MAX_ENCODED_RECORD_BYTES {
        return Err("Encoded full-record storage payload exceeds its chunk budget".into());
    }
    Ok(stored)
}

/// Called only after the complete fixed PIR batch and its encoded checksum are
/// verified. Exact stream consumption rejects trailing/concatenated zlib data.
pub fn decode_record_from_storage(
    stored: &[u8],
    manifest: &Value,
    selected: &str,
) -> Result<Value, String> {
    if stored.is_empty() || stored.len() > MAX_ENCODED_RECORD_BYTES {
        return Err("Encoded full-record storage length exceeds its limit".into());
    }
    let record = if record_codec(manifest)?.is_none() {
        let record: Value = serde_json::from_slice(stored).map_err(|error| error.to_string())?;
        if serde_json::to_vec(&record).map_err(|error| error.to_string())? != stored {
            return Err("Noncanonical full-record JSON".into());
        }
        record
    } else {
        use miniz_oxide::inflate::{
            TINFLStatus,
            core::{DecompressorOxide, decompress, inflate_flags},
        };
        if stored.len() <= STORED_HEADER
            || &stored[..8] != STORED_MAGIC
            || stored[12] & !1 != 0
            || stored[13..16] != [0; 3]
        {
            return Err("Invalid compressed full-record header".into());
        }
        let length = u32::from_le_bytes(stored[8..12].try_into().unwrap()) as usize;
        if length == 0 || length > MAX_DECODED_RECORD_BYTES {
            return Err("Decoded full-record length exceeds its limit".into());
        }
        let mut decoded = vec![0; length];
        let (status, consumed, produced) = decompress(
            &mut DecompressorOxide::new(),
            &stored[STORED_HEADER..],
            &mut decoded,
            0,
            inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER
                | inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
        );
        if status != TINFLStatus::Done
            || consumed != stored.len() - STORED_HEADER
            || produced != length
        {
            return Err(
                "Invalid, truncated, trailing or oversized compressed full-record stream".into(),
            );
        }
        let mut payload: Value =
            serde_json::from_slice(&decoded).map_err(|error| error.to_string())?;
        if serde_json::to_vec(&payload).map_err(|error| error.to_string())? != decoded {
            return Err("Noncanonical compressed full-record JSON".into());
        }
        let object = payload
            .as_object_mut()
            .ok_or("Invalid stored full-record object")?;
        if [
            "schema",
            "network",
            "snapshot",
            "coverage",
            "found",
            "publicationId",
        ]
        .iter()
        .any(|field| object.contains_key(*field))
        {
            return Err("Stored full-record payload contains reserved shared context".into());
        }
        if stored[12] == 1 {
            let hex = payload["raw"]["hex"]
                .as_str()
                .ok_or("Missing deduplicated raw hex")?
                .to_owned();
            let decoded = payload["raw"]["decoded"]
                .as_object_mut()
                .ok_or("Missing decoded transaction object")?;
            if decoded.insert("hex".into(), json!(hex)).is_some() {
                return Err("Conflicting deduplicated raw hex".into());
            }
        }
        let object = payload.as_object_mut().unwrap();
        object.insert("schema".into(), json!(RECORD_SCHEMA));
        for field in ["network", "snapshot", "coverage"] {
            object.insert(
                field.into(),
                manifest
                    .get(field)
                    .ok_or("Missing publication context")?
                    .clone(),
            );
        }
        payload
    };
    if record_codec(manifest)?.is_some()
        && serde_json::to_vec(&record)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_DECODED_RECORD_BYTES
    {
        return Err("Reconstructed full-record envelope exceeds its limit".into());
    }
    validate_record(&record, manifest, selected)?;
    Ok(record)
}

pub fn profile() -> Result<TableProfile, String> {
    TableProfile::new(SCHEMA, GEOMETRY, TABLE, ROWS as u64, ROW_BYTES as u32)
}

pub fn parse_display_txid(display: &str) -> Result<Txid, String> {
    let mut bytes = decode_hash(display)?;
    bytes.reverse();
    Ok(Txid(bytes))
}

fn decode_hash(hash: &str) -> Result<[u8; 32], String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Expected a 64-character hexadecimal identifier".into());
    }
    hex::decode(hash)
        .map_err(|_| "Invalid hexadecimal identifier".to_string())?
        .try_into()
        .map_err(|_| "Invalid hexadecimal identifier".to_string())
}

/// Identity covers the public layout, source snapshot and all record commitments.
/// serde_json's default sorted map representation gives the native/browser hash
/// the same deterministic encoding; do not enable its preserve_order feature.
/// Optional compact layout is explicitly bound to the publication. Legacy
/// manifests omit both fields and retain their original identity bytes.
pub fn packing_cover_row(manifest: &Value) -> Result<Option<usize>, String> {
    match manifest.get("packing") {
        None if manifest.get("coverRow").is_none() => Ok(None),
        Some(Value::String(packing))
            if packing == "compact-v1"
                && manifest["coverRow"].as_u64() == Some((ROWS - 1) as u64) =>
        {
            Ok(Some(ROWS - 1))
        }
        _ => Err("Unsupported full-record packing or cover row".into()),
    }
}

pub fn publication_identity(manifest: &Value) -> Result<Value, String> {
    let keys = [
        "schema",
        "geometry",
        "table",
        "rows",
        "rowBytes",
        "payloadBytes",
        "chunkCount",
        "network",
        "snapshot",
        "coverage",
        "catalogue",
    ];
    let mut identity = serde_json::Map::new();
    for key in keys {
        let value = manifest
            .get(key)
            .ok_or_else(|| format!("Missing publication field {key}"))?;
        identity.insert(key.to_string(), value.clone());
    }
    if record_codec(manifest)?.is_some() {
        identity.insert("recordCodec".into(), manifest["recordCodec"].clone());
    }
    if packing_cover_row(manifest)?.is_some() {
        identity.insert("packing".into(), manifest["packing"].clone());
        identity.insert("coverRow".into(), manifest["coverRow"].clone());
    }
    Ok(Value::Object(identity))
}

pub fn publication_id(manifest: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(&publication_identity(manifest)?).map_err(|e| e.to_string())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub struct ChunkContext<'a> {
    pub publication_id: &'a str,
    pub txid: &'a str,
    pub index: usize,
    pub count: usize,
    pub record_bytes: usize,
    pub record_sha256: &'a str,
}

impl ChunkContext<'_> {
    fn payload_len(&self) -> Result<usize, String> {
        if self.count == 0
            || self.count > ROWS
            || self.index >= self.count
            || self.record_bytes == 0
            || self.record_bytes > self.count * PAYLOAD_BYTES
        {
            return Err("Unsupported full-record chunk shape".into());
        }
        Ok(self
            .record_bytes
            .saturating_sub(self.index * PAYLOAD_BYTES)
            .min(PAYLOAD_BYTES))
    }
}

pub fn encode_chunk(context: &ChunkContext<'_>, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() != context.payload_len()? {
        return Err("Full-record chunk payload length mismatch".into());
    }
    let mut row = vec![0; ROW_BYTES];
    row[..8].copy_from_slice(MAGIC);
    row[8..40].copy_from_slice(&decode_hash(context.publication_id)?);
    row[40..72].copy_from_slice(&parse_display_txid(context.txid)?.0);
    for (offset, number) in [
        (72, context.index),
        (76, context.count),
        (80, payload.len()),
        (84, context.record_bytes),
    ] {
        row[offset..offset + 4].copy_from_slice(&(number as u32).to_le_bytes());
    }
    row[88..120].copy_from_slice(&decode_hash(context.record_sha256)?);
    row[HEADER_BYTES..HEADER_BYTES + payload.len()].copy_from_slice(payload);
    Ok(row)
}

pub fn decode_chunk(context: &ChunkContext<'_>, row: &[u8]) -> Result<Vec<u8>, String> {
    let payload_len = context.payload_len()?;
    if row.len() != ROW_BYTES
        || &row[..8] != MAGIC
        || row[8..40] != decode_hash(context.publication_id)?
        || row[40..72] != parse_display_txid(context.txid)?.0
        || row[88..120] != decode_hash(context.record_sha256)?
        || row[120..HEADER_BYTES].iter().any(|&b| b != 0)
    {
        return Err("Full-record chunk identity mismatch".into());
    }
    let number = |offset| u32::from_le_bytes(row[offset..offset + 4].try_into().unwrap()) as usize;
    if number(72) != context.index
        || number(76) != context.count
        || number(80) != payload_len
        || number(84) != context.record_bytes
        || row[HEADER_BYTES + payload_len..].iter().any(|&b| b != 0)
    {
        return Err("Full-record chunk shape or padding mismatch".into());
    }
    Ok(row[HEADER_BYTES..HEADER_BYTES + payload_len].to_vec())
}

fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

/// Verify the claimed confirmed range and raw transaction identity. Derived
/// indexer fields remain publisher-trusted; this is not an inclusion proof.
pub fn validate_record(record: &Value, manifest: &Value, selected: &str) -> Result<(), String> {
    if record["schema"] != RECORD_SCHEMA
        || record["txid"] != selected
        || record["network"] != "mainnet"
        || record["network"] != manifest["network"]
        || record["snapshot"] != manifest["snapshot"]
        || record["coverage"] != manifest["coverage"]
        || record["detail"]["txid"] != selected
        || record["detail"]["status"] != "confirmed"
        || record["detail"]["isCanonical"] != true
        || !record["detail"]["inputs"].is_array()
        || !record["detail"]["outputs"].is_array()
        || !record["raw"]["decoded"].is_object()
    {
        return Err("Full-record envelope or confirmed-state mismatch".into());
    }
    let height = number(&record["detail"]["blockHeight"]).ok_or("Missing confirmed height")?;
    let start = number(&manifest["coverage"]["startHeight"]).ok_or("Missing coverage start")?;
    let end = number(&manifest["coverage"]["endHeight"]).ok_or("Missing coverage end")?;
    let tip = number(&manifest["snapshot"]["height"]).ok_or("Missing snapshot height")?;
    if start > end || end > tip || height < start || height > end {
        return Err("Confirmed transaction lies outside the declared snapshot coverage".into());
    }
    decode_hash(
        manifest["snapshot"]["hash"]
            .as_str()
            .ok_or("Missing snapshot hash")?,
    )?;
    decode_hash(
        record["detail"]["blockHash"]
            .as_str()
            .ok_or("Missing transaction block hash")?,
    )?;
    if height == tip && record["detail"]["blockHash"] != manifest["snapshot"]["hash"] {
        return Err("Transaction at the snapshot height names a different block".into());
    }
    if manifest["snapshot"]["publishedAt"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return Err("Missing publication time".into());
    }
    for key in [
        "feeZat",
        "totalInputZat",
        "totalOutputZat",
        "valueBalanceZat",
        "valueBalanceSaplingZat",
        "valueBalanceOrchardZat",
        "valueBalanceIronwoodZat",
    ] {
        if let Some(value) = record["detail"].get(key)
            && !value.is_null()
        {
            let text = value
                .as_str()
                .ok_or("Exact zatoshi amounts must be strings or null")?;
            let magnitude = text.strip_prefix('-').unwrap_or(text);
            if magnitude.is_empty()
                || !magnitude.bytes().all(|b| b.is_ascii_digit())
                || (magnitude.len() > 1 && magnitude.starts_with('0'))
            {
                return Err("Invalid exact zatoshi integer".into());
            }
        }
    }
    let raw = hex::decode(
        record["raw"]["hex"]
            .as_str()
            .ok_or("Missing raw transaction")?,
    )
    .map_err(|_| "Invalid raw transaction hex")?;
    let parsed =
        zcash_transaction_wire::TransactionView::parse_exact(&raw).map_err(|e| e.to_string())?;
    if parsed.txid() != parse_display_txid(selected)?.0 {
        return Err("Raw transaction does not match the selected txid".into());
    }
    for candidate in [&record["raw"]["txid"], &record["raw"]["decoded"]["txid"]] {
        if let Some(id) = candidate.as_str()
            && id != selected
        {
            return Err("Verbose transaction identity mismatch".into());
        }
    }
    Ok(())
}

pub fn result_envelope(mut record: Value, id: &str) -> Result<String, String> {
    let object = record.as_object_mut().ok_or("Invalid record object")?;
    object.insert("found".into(), json!(true));
    object.insert("publicationId".into(), json!(id));
    serde_json::to_string(&record).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_chunks_bind_every_field_and_zero_padding() {
        let id = "1".repeat(64);
        let txid = "2".repeat(64);
        let digest = "3".repeat(64);
        let context = ChunkContext {
            publication_id: &id,
            txid: &txid,
            index: 0,
            count: 2,
            record_bytes: 3,
            record_sha256: &digest,
        };
        let row = encode_chunk(&context, b"abc").unwrap();
        assert_eq!(decode_chunk(&context, &row).unwrap(), b"abc");
        for offset in [0, 8, 40, 72, 76, 80, 84, 88, 120, HEADER_BYTES + 3] {
            let mut bad = row.clone();
            bad[offset] ^= 1;
            assert!(decode_chunk(&context, &bad).is_err(), "offset {offset}");
        }
        let padding = ChunkContext {
            index: 1,
            ..context
        };
        let row = encode_chunk(&padding, &[]).unwrap();
        assert!(decode_chunk(&padding, &row).unwrap().is_empty());
        assert!(encode_chunk(&padding, &[1]).is_err());
    }
    #[test]
    fn legacy_publication_identity_known_answer_is_unchanged() {
        // Identity-only fixture with a hash recorded before compact fields.
        // It does not assert that the empty catalogue is a valid publication.
        let manifest = json!({
            "schema":"zecblock-private-tx-full-v1","geometry":"full-2k-8k",
            "table":"txdirectory","rows":2048,"rowBytes":8192,"payloadBytes":8064,
            "chunkCount":3,"network":"mainnet",
            "snapshot":{"height":1,"hash":"0".repeat(64),"publishedAt":"2026-10-29T00:00:00Z"},
            "coverage":{"startHeight":1,"endHeight":1},"catalogue":[]
        });
        assert_eq!(
            publication_id(&manifest).unwrap(),
            "81a22924cc3fac43229edb846fae1ecbbaec9d6ad7183f956d825516af4d3c0b"
        );
    }
}

#[cfg(test)]
#[path = "codec_tests.rs"]
mod codec_tests;
