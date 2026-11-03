//! Experimental global hash-row publication. This is a separate protocol from
//! the deployed bounded/full-record pilot; no pilot limits or identities change.
use serde_json::Value;
use sha2::{Digest, Sha256};
use zakura_pir_protocol::transparent::native::{PREPARED_HEADER_BYTES, TableProfile};

pub const SCHEMA: &str = "zecblock-private-global-v1";
pub const GEOMETRY: &str = "global-2k-64k";
pub const TABLE: &str = "txdirectory";
pub const HASH_ALGORITHM: &str = "sha256-display-v1";
pub const RECORD_CODEC: &str = "full-envelope-zlib-v1";
pub const COMPACT_RECORD_CODEC: &str = "full-envelope-binary-zlib-v2";
pub const ROWS: usize = 2048;
pub const ROW_BYTES: usize = 65_536;
pub const AUTH_HEADER_BYTES: usize = 512;
pub const PAYLOAD_BYTES: usize = ROW_BYTES - AUTH_HEADER_BYTES;
pub const MAX_LAYERS: usize = 128;
pub const MAX_BUCKET_BYTES: usize = MAX_LAYERS * PAYLOAD_BYTES;
pub const MAX_DECODED_RECORD_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_ENCODED_RECORD_BYTES: usize = MAX_BUCKET_BYTES - 128;
pub const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_SOURCE_SUMMARY_BYTES: usize = 16 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const RECORD_MAGIC: &[u8; 8] = b"ZBGLREC1";
const COMPACT_RECORD_MAGIC: &[u8; 8] = b"ZBGLREC2";
const RECORD_HEADER_BYTES: usize = 16;
const BUCKET_MAGIC: &[u8; 8] = b"ZBGLBKT1";
const BUCKET_HEADER_BYTES: usize = 16;
const ENTRY_HEADER_BYTES: usize = 72;
const ROW_MAGIC: &[u8; 8] = b"ZBGLROW1";
const MERKLE_DEPTH: usize = 11;

#[path = "global_codec.rs"]
mod compact_codec;

pub fn profile() -> Result<TableProfile, String> {
    TableProfile::new(SCHEMA, GEOMETRY, TABLE, ROWS as u64, ROW_BYTES as u32)
}

fn display_bytes(hash: &str) -> Result<[u8; 32], String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Expected a 64-character hexadecimal identifier".into());
    }
    hex::decode(hash)
        .map_err(|error| error.to_string())?
        .try_into()
        .map_err(|_| "Invalid hexadecimal identifier".into())
}

fn hash_bytes(hash: &str) -> Result<[u8; 32], String> {
    if hash.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err("Expected a canonical lowercase hexadecimal digest".into());
    }
    display_bytes(hash)
}

fn canonical(value: &Value) -> Result<Vec<u8>, String> {
    // Both crates deliberately use serde_json's sorted map representation.
    serde_json::to_vec(value).map_err(|error| error.to_string())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Hash DISPLAY order, without the reversal used by the wire Txid type.
pub fn key_row(txid: &str) -> Result<usize, String> {
    let mut hash = Sha256::new();
    hash.update(b"ZBGL-KEY-v1\0");
    hash.update(display_bytes(txid)?);
    let bytes = hash.finalize();
    Ok((u64::from_le_bytes(bytes[..8].try_into().unwrap()) % ROWS as u64) as usize)
}

/// A retained record is validated against its OWN observation context, never
/// rewritten to the newest global publication's source snapshot.
pub fn validate_record(record: &Value, selected: &str) -> Result<(), String> {
    display_bytes(selected)?;
    let object = record
        .as_object()
        .ok_or("Invalid global full-record object")?;
    if object.contains_key("found") || object.contains_key("publicationId") {
        return Err("Full-record input contains reserved result context".into());
    }
    crate::full_record::validate_record(record, record, &selected.to_ascii_lowercase())
}

/// Compress the complete canonical envelope. The one deduplication flag restores
/// decoded.hex only when it was present and exactly equal to raw.hex.
pub fn encode_record(record: &Value) -> Result<Vec<u8>, String> {
    encode_record_with_codec(record, RECORD_CODEC)
}

pub fn supported_record_codec(codec: &str) -> bool {
    matches!(codec, RECORD_CODEC | COMPACT_RECORD_CODEC)
}

pub fn encode_record_with_codec(record: &Value, codec: &str) -> Result<Vec<u8>, String> {
    if !supported_record_codec(codec) {
        return Err("Unsupported global full-record codec".into());
    }
    let full_bytes = canonical(record)?.len();
    if full_bytes == 0 || full_bytes > MAX_DECODED_RECORD_BYTES {
        return Err("Restored global full-record envelope exceeds its limit".into());
    }
    let txid = record["txid"].as_str().ok_or("Missing full-record txid")?;
    validate_record(record, txid)?;
    let mut payload = record.clone();
    let restore_hex = payload["raw"]["hex"].is_string()
        && payload["raw"]["decoded"]["hex"] == payload["raw"]["hex"];
    if restore_hex {
        payload["raw"]["decoded"]
            .as_object_mut()
            .ok_or("Invalid decoded transaction object")?
            .remove("hex");
    }
    let decoded = if codec == COMPACT_RECORD_CODEC {
        compact_codec::encode(&payload)?
    } else {
        canonical(&payload)?
    };
    let mut stored = Vec::with_capacity(RECORD_HEADER_BYTES + decoded.len().min(64 * 1024));
    stored.extend_from_slice(if codec == COMPACT_RECORD_CODEC {
        COMPACT_RECORD_MAGIC
    } else {
        RECORD_MAGIC
    });
    stored.extend_from_slice(&(decoded.len() as u32).to_le_bytes());
    stored.push(u8::from(restore_hex));
    stored.extend_from_slice(&[0; 3]);
    stored.extend(miniz_oxide::deflate::compress_to_vec_zlib(&decoded, 6));
    if stored.len() > MAX_ENCODED_RECORD_BYTES {
        return Err("Encoded global full-record envelope exceeds its bucket budget".into());
    }
    Ok(stored)
}

fn validate_record_header(stored: &[u8]) -> Result<usize, String> {
    if stored.len() <= RECORD_HEADER_BYTES
        || stored.len() > MAX_ENCODED_RECORD_BYTES
        || (&stored[..8] != RECORD_MAGIC && &stored[..8] != COMPACT_RECORD_MAGIC)
        || stored[12] & !1 != 0
        || stored[13..16] != [0; 3]
    {
        return Err("Invalid compressed global full-record header or length".into());
    }
    let length = u32::from_le_bytes(stored[8..12].try_into().unwrap()) as usize;
    let max_payload = if &stored[..8] == COMPACT_RECORD_MAGIC {
        compact_codec::MAX_PAYLOAD_BYTES
    } else {
        MAX_DECODED_RECORD_BYTES
    };
    if length == 0 || length > max_payload {
        return Err("Decoded global full-record length exceeds its limit".into());
    }
    Ok(length)
}

pub fn stored_record_codec(stored: &[u8]) -> Result<&'static str, String> {
    validate_record_header(stored)?;
    Ok(if &stored[..8] == COMPACT_RECORD_MAGIC {
        COMPACT_RECORD_CODEC
    } else {
        RECORD_CODEC
    })
}

pub fn decode_record(stored: &[u8], selected: &str) -> Result<Value, String> {
    decode_record_with_codec(stored, selected, stored_record_codec(stored)?)
}

pub fn decode_record_with_codec(
    stored: &[u8],
    selected: &str,
    codec: &str,
) -> Result<Value, String> {
    use miniz_oxide::inflate::{
        TINFLStatus,
        core::{DecompressorOxide, decompress, inflate_flags},
    };
    if !supported_record_codec(codec) || stored_record_codec(stored)? != codec {
        return Err("Global full-record codec differs from its publication".into());
    }
    let length = validate_record_header(stored)?;
    let mut decoded = vec![0; length];
    let (status, consumed, produced) = decompress(
        &mut DecompressorOxide::new(),
        &stored[RECORD_HEADER_BYTES..],
        &mut decoded,
        0,
        inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER
            | inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
    );
    if status != TINFLStatus::Done
        || consumed != stored.len() - RECORD_HEADER_BYTES
        || produced != length
    {
        return Err("Invalid, truncated, trailing or oversized compressed global record".into());
    }
    let mut record: Value = if codec == COMPACT_RECORD_CODEC {
        compact_codec::decode(&decoded)?
    } else {
        let record = serde_json::from_slice(&decoded).map_err(|error| error.to_string())?;
        if canonical(&record)? != decoded {
            return Err("Noncanonical compressed global full-record JSON".into());
        }
        record
    };
    if stored[12] == 1 {
        let hex = record["raw"]["hex"]
            .as_str()
            .ok_or("Missing deduplicated raw hex")?
            .to_owned();
        if record["raw"]["decoded"]
            .as_object_mut()
            .ok_or("Missing decoded transaction object")?
            .insert("hex".into(), Value::String(hex))
            .is_some()
        {
            return Err("Conflicting deduplicated raw hex".into());
        }
    }
    if canonical(&record)?.len() > MAX_DECODED_RECORD_BYTES {
        return Err("Restored global full-record envelope exceeds its limit".into());
    }
    validate_record(&record, selected)?;
    Ok(record)
}

/// Compressed-only publisher staging avoids retaining many 32 MiB envelopes.
pub struct EncodedEntry {
    pub txid: String,
    pub record_sha256: String,
    pub encoded: Vec<u8>,
}

pub fn encode_entry(record: &Value) -> Result<EncodedEntry, String> {
    encode_entry_with_codec(record, RECORD_CODEC)
}

pub fn encode_entry_with_codec(record: &Value, codec: &str) -> Result<EncodedEntry, String> {
    let encoded = encode_record_with_codec(record, codec)?;
    Ok(EncodedEntry {
        txid: record["txid"]
            .as_str()
            .ok_or("Missing full-record txid")?
            .to_owned(),
        record_sha256: digest(&canonical(record)?),
        encoded,
    })
}

pub fn encode_bucket(records: &[Value]) -> Result<Vec<u8>, String> {
    encode_bucket_refs(&records.iter().collect::<Vec<_>>())
}

pub fn encode_bucket_refs(records: &[&Value]) -> Result<Vec<u8>, String> {
    if records.len() > ROWS {
        return Err("Too many global bucket entries".into());
    }
    let entries = records
        .iter()
        .map(|record| encode_entry(record))
        .collect::<Result<Vec<_>, _>>()?;
    encode_bucket_entries(&entries)
}

/// Entries MUST originate from encode_entry; the decoder independently verifies
/// the selected record's canonical digest and wire identity after authentication.
pub fn encode_bucket_entries(entries: &[EncodedEntry]) -> Result<Vec<u8>, String> {
    encode_bucket_entries_with_codec(entries, RECORD_CODEC)
}

pub fn encode_bucket_entries_with_codec(
    entries: &[EncodedEntry],
    codec: &str,
) -> Result<Vec<u8>, String> {
    if !supported_record_codec(codec) {
        return Err("Unsupported global full-record codec".into());
    }
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    if entries.len() > ROWS {
        return Err("Too many global bucket entries".into());
    }
    let mut sorted = entries
        .iter()
        .map(|entry| Ok((hash_bytes(&entry.txid)?, entry)))
        .collect::<Result<Vec<_>, String>>()?;
    sorted.sort_unstable_by_key(|(txid, _)| *txid);
    let mut total = BUCKET_HEADER_BYTES;
    for (index, (txid, entry)) in sorted.iter().enumerate() {
        if index > 0 && sorted[index - 1].0 == *txid {
            return Err("Duplicate global bucket txid".into());
        }
        hash_bytes(&entry.record_sha256)?;
        if stored_record_codec(&entry.encoded)? != codec {
            return Err("Mixed global full-record codecs in bucket".into());
        }
        total = total
            .checked_add(ENTRY_HEADER_BYTES + entry.encoded.len())
            .filter(|&n| n <= MAX_BUCKET_BYTES)
            .ok_or("Global bucket exceeds its layer budget")?;
    }
    let mut bucket = Vec::with_capacity(total);
    bucket.extend_from_slice(BUCKET_MAGIC);
    bucket.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    bucket.extend_from_slice(&[0; 4]);
    for (txid, entry) in sorted {
        bucket.extend_from_slice(&txid);
        bucket.extend_from_slice(&hash_bytes(&entry.record_sha256)?);
        bucket.extend_from_slice(&(entry.encoded.len() as u32).to_le_bytes());
        bucket.extend_from_slice(&[0; 4]);
        bucket.extend_from_slice(&entry.encoded);
    }
    Ok(bucket)
}

/// Framing of EVERY entry is checked before decoding only the selected record.
/// Callers retrieving PIR rows must first authenticate and hash the whole bucket.
pub fn decode_bucket(bucket: &[u8], selected: &str) -> Result<Option<Value>, String> {
    decode_bucket_with_codec(bucket, selected, RECORD_CODEC)
}

pub fn decode_bucket_with_codec(
    bucket: &[u8],
    selected: &str,
    codec: &str,
) -> Result<Option<Value>, String> {
    if !supported_record_codec(codec) {
        return Err("Unsupported global full-record codec".into());
    }
    let selected_bytes = display_bytes(selected)?;
    if bucket.is_empty() {
        return Ok(None);
    }
    if bucket.len() < BUCKET_HEADER_BYTES
        || bucket.len() > MAX_BUCKET_BYTES
        || &bucket[..8] != BUCKET_MAGIC
        || bucket[12..16] != [0; 4]
    {
        return Err("Invalid global bucket header".into());
    }
    let count = u32::from_le_bytes(bucket[8..12].try_into().unwrap()) as usize;
    if count == 0 || count > ROWS {
        return Err("Invalid global bucket entry count".into());
    }
    let mut cursor = BUCKET_HEADER_BYTES;
    let mut previous: Option<[u8; 32]> = None;
    let mut matching = None;
    for _ in 0..count {
        let header_end = cursor
            .checked_add(ENTRY_HEADER_BYTES)
            .filter(|&end| end <= bucket.len())
            .ok_or("Truncated global bucket entry")?;
        let txid: [u8; 32] = bucket[cursor..cursor + 32].try_into().unwrap();
        if previous.is_some_and(|last| last >= txid) {
            return Err("Unsorted or duplicate global bucket txid".into());
        }
        previous = Some(txid);
        let length =
            u32::from_le_bytes(bucket[cursor + 64..cursor + 68].try_into().unwrap()) as usize;
        if length <= RECORD_HEADER_BYTES
            || length > MAX_ENCODED_RECORD_BYTES
            || bucket[cursor + 68..header_end] != [0; 4]
        {
            return Err("Invalid global bucket entry length or reserved bytes".into());
        }
        let end = header_end
            .checked_add(length)
            .filter(|&end| end <= bucket.len())
            .ok_or("Truncated global bucket record")?;
        if stored_record_codec(&bucket[header_end..end])? != codec {
            return Err("Global bucket record codec differs from its publication".into());
        }
        if txid == selected_bytes {
            matching = Some((
                header_end..end,
                <[u8; 32]>::try_from(&bucket[cursor + 32..cursor + 64]).unwrap(),
            ));
        }
        cursor = end;
    }
    if cursor != bucket.len() {
        return Err("Trailing bytes in global bucket".into());
    }
    let Some((range, commitment)) = matching else {
        return Ok(None);
    };
    let record = decode_record_with_codec(&bucket[range], selected, codec)?;
    if Sha256::digest(canonical(&record)?).as_slice() != commitment {
        return Err("Global full-record canonical digest mismatch".into());
    }
    Ok(Some(record))
}

fn leaf(row: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"ZBGL-LEAF-v1\0");
    hash.update(&row[..128]);
    hash.update(&row[AUTH_HEADER_BYTES..]);
    hash.finalize().into()
}

fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"ZBGL-NODE-v1\0");
    hash.update(left);
    hash.update(right);
    hash.finalize().into()
}

fn shape(layer: usize, layers: usize, bytes: usize) -> Result<usize, String> {
    if layers == 0
        || layers > MAX_LAYERS
        || layer >= layers
        || bytes > MAX_BUCKET_BYTES
        || bytes > layers * PAYLOAD_BYTES
    {
        return Err("Unsupported global layer or bucket shape".into());
    }
    Ok(bytes
        .saturating_sub(layer * PAYLOAD_BYTES)
        .min(PAYLOAD_BYTES))
}

/// A full layer is exactly 128 MiB. Merkle witnesses occupy the row's fixed
/// header; the leaf omits witnesses and includes all padded payload bytes.
pub fn build_layer(
    context_id: &str,
    layer: usize,
    layers: usize,
    buckets: &[Vec<u8>],
) -> Result<(Vec<u8>, String), String> {
    let context = hash_bytes(context_id)?;
    shape(layer, layers, 0)?;
    if buckets.len() != ROWS {
        return Err("Global layer requires exactly 2048 buckets".into());
    }
    for bucket in buckets {
        shape(layer, layers, bucket.len())?;
    }
    let mut database = vec![0; ROWS * ROW_BYTES];
    for (index, (row, bucket)) in database
        .chunks_exact_mut(ROW_BYTES)
        .zip(buckets)
        .enumerate()
    {
        let length = shape(layer, layers, bucket.len())?;
        row[..8].copy_from_slice(ROW_MAGIC);
        row[8..40].copy_from_slice(&context);
        row[40..44].copy_from_slice(&(layer as u32).to_le_bytes());
        row[44..48].copy_from_slice(&(index as u32).to_le_bytes());
        row[48..52].copy_from_slice(&(length as u32).to_le_bytes());
        row[52..56].copy_from_slice(&(layers as u32).to_le_bytes());
        row[56..88].copy_from_slice(&Sha256::digest(bucket));
        row[88..96].copy_from_slice(&(bucket.len() as u64).to_le_bytes());
        if length > 0 {
            let start = layer * PAYLOAD_BYTES;
            row[AUTH_HEADER_BYTES..AUTH_HEADER_BYTES + length]
                .copy_from_slice(&bucket[start..start + length]);
        }
    }
    let mut tree = vec![
        database
            .chunks_exact(ROW_BYTES)
            .map(leaf)
            .collect::<Vec<_>>(),
    ];
    for depth in 0..MERKLE_DEPTH {
        tree.push(
            tree[depth]
                .chunks_exact(2)
                .map(|pair| node(&pair[0], &pair[1]))
                .collect(),
        );
    }
    for (index, row) in database.chunks_exact_mut(ROW_BYTES).enumerate() {
        for (depth, level) in tree.iter().take(MERKLE_DEPTH).enumerate() {
            row[128 + depth * 32..160 + depth * 32].copy_from_slice(&level[(index >> depth) ^ 1]);
        }
    }
    Ok((database, hex::encode(tree[MERKLE_DEPTH][0])))
}

pub struct RowPiece {
    pub payload: Vec<u8>,
    pub bucket_bytes: usize,
    pub bucket_sha256: String,
}

pub fn verify_row(
    row: &[u8],
    context_id: &str,
    layer: usize,
    layers: usize,
    expected_row: usize,
    root: &str,
) -> Result<RowPiece, String> {
    let context = hash_bytes(context_id)?;
    let root = hash_bytes(root)?;
    if row.len() != ROW_BYTES
        || expected_row >= ROWS
        || &row[..8] != ROW_MAGIC
        || row[8..40] != context
        || row[96..128] != [0; 32]
        || row[480..512] != [0; 32]
    {
        return Err("Global row identity, length or reserved bytes mismatch".into());
    }
    let number = |start| u32::from_le_bytes(row[start..start + 4].try_into().unwrap()) as usize;
    let bytes = usize::try_from(u64::from_le_bytes(row[88..96].try_into().unwrap()))
        .map_err(|_| "Global bucket length exceeds this client")?;
    let length = shape(layer, layers, bytes)?;
    if number(40) != layer
        || number(44) != expected_row
        || number(48) != length
        || number(52) != layers
        || row[AUTH_HEADER_BYTES + length..].iter().any(|&b| b != 0)
        || bytes == 0 && row[56..88] != Sha256::digest([]).as_slice()[..]
    {
        return Err("Global row shape, bucket digest or padding mismatch".into());
    }
    let mut hash = leaf(row);
    for depth in 0..MERKLE_DEPTH {
        let sibling: [u8; 32] = row[128 + depth * 32..160 + depth * 32].try_into().unwrap();
        hash = if expected_row >> depth & 1 == 0 {
            node(&hash, &sibling)
        } else {
            node(&sibling, &hash)
        };
    }
    if hash != root {
        return Err("Global row Merkle authentication failed".into());
    }
    Ok(RowPiece {
        payload: row[AUTH_HEADER_BYTES..AUTH_HEADER_BYTES + length].to_vec(),
        bucket_bytes: bytes,
        bucket_sha256: hex::encode(&row[56..88]),
    })
}

fn identity_without(manifest: &Value, omitted: &[&str]) -> Result<Value, String> {
    let mut value = manifest
        .as_object()
        .ok_or("Invalid global manifest object")?
        .clone();
    for key in omitted {
        value.remove(*key);
    }
    Ok(Value::Object(value))
}

/// The pre-artifact context excludes roots/artifact hashes and the optional
/// post-artifact noise certificate. Final publication identity binds all of them.
pub fn manifest_context_id(manifest: &Value) -> Result<String, String> {
    Ok(digest(&canonical(&identity_without(
        manifest,
        &["contextId", "layers", "publicationId", "noiseCertificate"],
    )?)?))
}

pub fn manifest_id(manifest: &Value) -> Result<String, String> {
    Ok(digest(&canonical(&identity_without(
        manifest,
        &["publicationId"],
    )?)?))
}

fn object_keys(value: &Value, required: &[&str], optional: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("Expected global manifest object")?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("Missing or unsupported global manifest field".into());
    }
    Ok(())
}

fn summary(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 16 {
        return Err("Global source summary nesting exceeds its bound".into());
    }
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if ["txid", "txids", "catalogue", "catalog", "records"]
                    .contains(&key.to_ascii_lowercase().as_str())
                {
                    return Err("Global manifest must not contain a transaction catalogue".into());
                }
                summary(value, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                summary(value, depth + 1)?;
            }
        }
        _ => (),
    }
    Ok(())
}

fn manifest_hash(value: &Value) -> Result<&str, String> {
    let text = value.as_str().ok_or("Missing global manifest digest")?;
    hash_bytes(text)?;
    Ok(text)
}

pub fn validate_manifest(manifest: &Value) -> Result<TableProfile, String> {
    if canonical(manifest)?.len() > MAX_MANIFEST_BYTES {
        return Err("Global manifest exceeds its bound".into());
    }
    object_keys(
        manifest,
        &[
            "schema",
            "geometry",
            "table",
            "rows",
            "rowBytes",
            "payloadBytes",
            "layerCount",
            "hashAlgorithm",
            "recordCodec",
            "network",
            "sourceDigest",
            "sourceSummary",
            "scheme",
            "contextId",
            "layers",
            "publicationId",
        ],
        &["noiseCertificate"],
    )?;
    if manifest["schema"] != SCHEMA
        || manifest["geometry"] != GEOMETRY
        || manifest["table"] != TABLE
        || manifest["rows"].as_u64() != Some(ROWS as u64)
        || manifest["rowBytes"].as_u64() != Some(ROW_BYTES as u64)
        || manifest["payloadBytes"].as_u64() != Some(PAYLOAD_BYTES as u64)
        || manifest["hashAlgorithm"] != HASH_ALGORITHM
        || !manifest["recordCodec"]
            .as_str()
            .is_some_and(supported_record_codec)
        || manifest["network"] != "mainnet"
    {
        return Err("Unsupported global publication profile".into());
    }
    let count = manifest["layerCount"]
        .as_u64()
        .filter(|&n| n > 0 && n <= MAX_LAYERS as u64)
        .ok_or("Unsupported global publication layer count")? as usize;
    manifest_hash(&manifest["sourceDigest"])?;
    if !manifest["sourceSummary"].is_object()
        || canonical(&manifest["sourceSummary"])?.len() > MAX_SOURCE_SUMMARY_BYTES
    {
        return Err("Global source summary exceeds its bound".into());
    }
    summary(&manifest["sourceSummary"], 0)?;
    let profile = profile()?;
    if manifest["scheme"]
        != serde_json::to_value(&profile.scheme).map_err(|error| error.to_string())?
    {
        return Err("Global native scheme does not match the pinned profile".into());
    }
    let layers = manifest["layers"]
        .as_array()
        .filter(|layers| layers.len() == count)
        .ok_or("Global layer list differs from its fixed layer count")?;
    for (index, layer) in layers.iter().enumerate() {
        object_keys(
            layer,
            &[
                "index",
                "merkleRoot",
                "databaseSha256",
                "publicSha256",
                "preparedFiles",
            ],
            &[],
        )?;
        if layer["index"].as_u64() != Some(index as u64) {
            return Err("Unordered global layer index".into());
        }
        for key in ["merkleRoot", "databaseSha256", "publicSha256"] {
            manifest_hash(&layer[key])?;
        }
        let files = layer["preparedFiles"]
            .as_array()
            .filter(|files| files.len() == 2)
            .ok_or("Global layer needs two prepared native artifacts")?;
        let mut blocks = 0;
        for (part, file) in files.iter().enumerate() {
            object_keys(file, &["file", "count", "bytes", "sha256"], &[])?;
            let count = file["count"]
                .as_u64()
                .filter(|&n| n > 0 && n <= 16)
                .ok_or("Unsupported prepared native block count")?;
            let bytes = file["bytes"]
                .as_u64()
                .ok_or("Missing prepared native artifact bytes")?;
            if file["file"] != format!("prepared-{part:02}.bin")
                || bytes < PREPARED_HEADER_BYTES + count * profile.native.prepared_block_min_bytes()
                || bytes > PREPARED_HEADER_BYTES + count * profile.native.prepared_block_max_bytes()
            {
                return Err("Invalid prepared native filename or artifact size".into());
            }
            manifest_hash(&file["sha256"])?;
            blocks += count;
        }
        if blocks != profile.blocks() as u64 {
            return Err("Incomplete prepared native layer".into());
        }
    }
    if manifest_hash(&manifest["contextId"])? != manifest_context_id(manifest)?
        || manifest_hash(&manifest["publicationId"])? != manifest_id(manifest)?
    {
        return Err("Global manifest identity mismatch".into());
    }
    Ok(profile)
}

/// Receives the COMPLETE fixed bundle; authenticate every layer before testing
/// membership, then verify the whole encoded bucket and selected full record.
pub fn assemble_bucket(
    rows: &[Vec<u8>],
    manifest: &Value,
    selected: &str,
) -> Result<Option<Value>, String> {
    validate_manifest(manifest)?;
    let layers = manifest["layers"].as_array().unwrap();
    if rows.len() != layers.len() {
        return Err("Incomplete global response bundle".into());
    }
    let expected = key_row(selected)?;
    let context = manifest["contextId"].as_str().unwrap();
    let pieces = rows
        .iter()
        .zip(layers)
        .enumerate()
        .map(|(index, (row, layer))| {
            verify_row(
                row,
                context,
                index,
                layers.len(),
                expected,
                layer["merkleRoot"].as_str().unwrap(),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let first = &pieces[0];
    if pieces.iter().any(|piece| {
        piece.bucket_bytes != first.bucket_bytes || piece.bucket_sha256 != first.bucket_sha256
    }) {
        return Err("Global layers disagree about the authenticated bucket".into());
    }
    let mut bucket = Vec::with_capacity(first.bucket_bytes);
    for piece in &pieces {
        bucket.extend_from_slice(&piece.payload);
    }
    if bucket.len() != first.bucket_bytes || digest(&bucket) != first.bucket_sha256 {
        return Err("Global encoded bucket checksum mismatch".into());
    }
    decode_bucket_with_codec(&bucket, selected, manifest["recordCodec"].as_str().unwrap())
}

#[cfg(test)]
#[path = "global_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "global_codec_tests.rs"]
mod codec_tests;
