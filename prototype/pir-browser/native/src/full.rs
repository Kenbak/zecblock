//! Bounded, immutable full-record publications around the pinned upstream PIR.
use super::*;
use crate::full_record::{self, ChunkContext};
use std::collections::BTreeSet;

const SOURCE_SCHEMA: &str = "zecblock-private-tx-source-v1";
const RECORD_SCHEMA: &str = "zecblock-private-tx-record-v1";
const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_BATCH_CHUNKS: usize = 64;

struct Record {
    txid: String,
    height: u64,
    body: Vec<u8>,
    envelope: Value,
    legacy_bytes: usize,
    decoded_bytes: usize,
    sha256: String,
    rows: Vec<usize>,
}

struct Publication {
    manifest: Value,
    database: Vec<u8>,
    expected: BTreeMap<String, Value>,
}

fn unsigned(value: &Value, field: &str) -> Result<u64, String> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| format!("invalid {field}"))
}

fn hash(value: &Value, field: &str) -> Result<String, String> {
    let value = value.as_str().ok_or_else(|| format!("missing {field}"))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(format!("invalid {field}"));
    }
    Ok(value.to_owned())
}

fn checked_record(
    record: &Value,
    network: &Value,
    snapshot: &Value,
    coverage: &Value,
    compressed: bool,
) -> Result<Record, String> {
    let txid = hash(&record["txid"], "record txid")?;
    let detail = &record["detail"];
    let raw = &record["raw"];
    if !detail.is_object() || !raw.is_object() || detail["txid"] != txid {
        return Err("record detail identity is missing or inconsistent".into());
    }
    if detail["status"] != "confirmed" || detail["isCanonical"] != true {
        return Err("full publication accepts only confirmed canonical transactions".into());
    }
    let height = unsigned(&detail["blockHeight"], "transaction block height")?;
    let start = unsigned(&coverage["startHeight"], "coverage start")?;
    let end = unsigned(&coverage["endHeight"], "coverage end")?;
    if height < start || height > end {
        return Err("transaction height is outside declared coverage".into());
    }
    hash(&detail["blockHash"], "transaction block hash")?;
    let raw_hex = raw["hex"].as_str().ok_or("record raw hex is missing")?;
    let bytes = hex::decode(raw_hex).map_err(|_| "record raw hex is invalid")?;
    let parsed = TransactionView::parse_exact(&bytes).map_err(|e| e.to_string())?;
    if Txid(parsed.txid()).to_display_hex() != txid {
        return Err("record raw bytes do not match its txid".into());
    }
    if !raw["decoded"].is_object() || raw["decoded"].get("txid").is_some_and(|id| id != &txid) {
        return Err("record verbose decode identity is missing or inconsistent".into());
    }
    // Keep unavailable exact amounts unavailable; never manufacture values.
    for field in [
        "feeZat",
        "totalInputZat",
        "totalOutputZat",
        "valueBalanceZat",
        "valueBalanceSaplingZat",
        "valueBalanceOrchardZat",
        "valueBalanceIronwoodZat",
    ] {
        if let Some(value) = detail.get(field)
            && !value.is_null()
            && value.as_str().is_none_or(|s| {
                let digits = s.strip_prefix('-').unwrap_or(s);
                digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit())
            })
        {
            return Err(format!("{field} must be an exact integer string or null"));
        }
    }
    let mut envelope = json!({
        "schema": RECORD_SCHEMA, "network": network, "snapshot": snapshot,
        "coverage": coverage, "txid": txid, "detail": detail, "raw": raw,
    });
    if let Some(price) = record.get("price") {
        envelope["price"] = price.clone();
    }
    if let Some(observation) = record.get("source") {
        envelope["source"] = observation.clone();
    }
    full_record::validate_record(
        &envelope,
        &json!({"network": network, "snapshot": snapshot, "coverage": coverage}),
        &txid,
    )?;
    let original = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    let legacy_bytes = original.len();
    let body = if compressed {
        full_record::encode_record_for_storage(&envelope)?
    } else {
        original
    };
    let decoded_bytes = if compressed {
        u32::from_le_bytes(body[8..12].try_into().unwrap()) as usize
    } else {
        legacy_bytes
    };
    let sha256 = hex::encode(Sha256::digest(&body));
    Ok(Record {
        txid,
        height,
        body,
        envelope,
        legacy_bytes,
        decoded_bytes,
        sha256,
        rows: Vec::new(),
    })
}

fn source_records(source: &Value) -> Result<&Vec<Value>, String> {
    if source["schema"] != SOURCE_SCHEMA || source["network"] != "mainnet" {
        return Err("unsupported full-record source schema or network".into());
    }
    let snapshot = &source["snapshot"];
    let coverage = &source["coverage"];
    if !snapshot.is_object() || !coverage.is_object() {
        return Err("snapshot and coverage must be explicit objects".into());
    }
    let anchor = unsigned(&snapshot["height"], "snapshot height")?;
    hash(&snapshot["hash"], "snapshot hash")?;
    if snapshot["publishedAt"].as_str().is_none_or(str::is_empty) {
        return Err("snapshot publishedAt is missing".into());
    }
    let start = unsigned(&coverage["startHeight"], "coverage start")?;
    let end = unsigned(&coverage["endHeight"], "coverage end")?;
    if start > end || end > anchor {
        return Err("invalid coverage/snapshot height boundaries".into());
    }
    let input = source["records"]
        .as_array()
        .ok_or("source records must be an array")?;
    if input.is_empty() || input.len() > full_record::ROWS {
        return Err("full publication must contain a bounded nonempty record set".into());
    }
    Ok(input)
}

fn records_for_source(source: &Value, compressed: bool) -> Result<Vec<Record>, String> {
    let input = source_records(source)?;
    let mut records = Vec::with_capacity(input.len());
    let mut decoded_total = 0_usize;
    for value in input {
        let record = checked_record(
            value,
            &source["network"],
            &source["snapshot"],
            &source["coverage"],
            compressed,
        )?;
        decoded_total = decoded_total
            .checked_add(record.legacy_bytes)
            .ok_or("Decoded aggregate size overflow")?;
        if decoded_total > MAX_TOTAL_DECODED_BYTES {
            return Err("Full publication exceeds its aggregate decoded capacity".into());
        }
        records.push(record);
    }
    records.sort_by(|a, b| a.txid.cmp(&b.txid));
    if records.windows(2).any(|pair| pair[0].txid == pair[1].txid) {
        return Err("duplicate source transaction ID".into());
    }
    Ok(records)
}

#[cfg(test)]
fn publication(source: &Value) -> Result<Publication, String> {
    publication_with_codec(source, true)
}

fn publication_with_codec(source: &Value, compressed: bool) -> Result<Publication, String> {
    let snapshot = &source["snapshot"];
    let coverage = &source["coverage"];
    let mut records = records_for_source(source, compressed)?;
    let chunk_count = records
        .iter()
        .map(|record| record.body.len().div_ceil(full_record::PAYLOAD_BYTES))
        .max()
        .ok_or("empty publication")?;
    if chunk_count > MAX_BATCH_CHUNKS {
        return Err("full publication exceeds the fixed browser chunk budget".into());
    }
    let allocated_rows = records.iter().try_fold(0_usize, |total, record| {
        total.checked_add(record.body.len().div_ceil(full_record::PAYLOAD_BYTES))
    });
    // The final zero row is shared by every padding query. Each record owns
    // only its actual body rows, while every browser still sends chunk_count.
    let cover_row = full_record::ROWS - 1;
    if allocated_rows.is_none_or(|rows| rows > cover_row) {
        return Err("full publication does not fit its compact table and cover row".into());
    }
    let mut catalogue = Vec::with_capacity(records.len());
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
    let mut next_row = 0;
    for record in &mut records {
        let actual = record.body.len().div_ceil(full_record::PAYLOAD_BYTES);
        record.rows = (next_row..next_row + actual).collect();
        next_row += actual;
        catalogue.push(json!({
            "txid": record.txid, "height": record.height,
            "label": "Confirmed mainnet snapshot transaction",
            "rows": record.rows, "recordBytes": record.body.len(), "recordSha256": record.sha256,
        }));
        expected.insert(record.txid.clone(), std::mem::take(&mut record.envelope));
    }
    let mut manifest = json!({
        "schema": full_record::SCHEMA, "geometry": full_record::GEOMETRY, "table": full_record::TABLE,
        "rows": full_record::ROWS, "rowBytes": full_record::ROW_BYTES,
        "payloadBytes": full_record::PAYLOAD_BYTES, "chunkCount": chunk_count,
        "packing": "compact-v1", "coverRow": cover_row,
        "network": source["network"], "snapshot": snapshot, "coverage": coverage,
        "catalogue": catalogue,
        "upstream": {"walletLibraries": UPSTREAM, "ipirSp": IPIR},
        "scope": "Bounded confirmed mainnet snapshot; publisher-supplied detail/verbose records. Fixed padded chunk queries; no live mempool or arbitrary historical coverage claim.",
    });
    if compressed {
        manifest["recordCodec"] = json!(full_record::RECORD_CODEC);
    }
    let publication_id = full_record::publication_id(&manifest)?;
    manifest["publicationId"] = json!(publication_id);
    for envelope in expected.values_mut() {
        envelope["found"] = json!(true);
        envelope["publicationId"] = json!(publication_id);
    }
    let mut database = vec![0; full_record::ROWS * full_record::ROW_BYTES];
    for record in &records {
        for (index, row) in record.rows.iter().copied().enumerate() {
            let start = (index * full_record::PAYLOAD_BYTES).min(record.body.len());
            let end = (start + full_record::PAYLOAD_BYTES).min(record.body.len());
            let context = ChunkContext {
                publication_id: &publication_id,
                txid: &record.txid,
                index,
                count: record.rows.len(),
                record_bytes: record.body.len(),
                record_sha256: &record.sha256,
            };
            let encoded = full_record::encode_chunk(&context, &record.body[start..end])?;
            database[row * full_record::ROW_BYTES..(row + 1) * full_record::ROW_BYTES]
                .copy_from_slice(&encoded);
        }
    }
    Ok(Publication {
        manifest,
        database,
        expected,
    })
}

pub(super) fn validate_manifest(manifest: &Value) -> Result<TableProfile, String> {
    let profile = full_record::profile()?;
    for (field, expected) in [
        ("schema", json!(full_record::SCHEMA)),
        ("geometry", json!(full_record::GEOMETRY)),
        ("table", json!(full_record::TABLE)),
        ("rows", json!(full_record::ROWS)),
        ("rowBytes", json!(full_record::ROW_BYTES)),
        ("payloadBytes", json!(full_record::PAYLOAD_BYTES)),
    ] {
        if manifest[field] != expected {
            return Err("full manifest profile mismatch".into());
        }
    }
    let cover_row = full_record::packing_cover_row(manifest)?;
    if manifest["publicationId"] != full_record::publication_id(manifest)? {
        return Err("full manifest publication binding mismatch".into());
    }
    let count = unsigned(&manifest["chunkCount"], "chunk count")? as usize;
    let catalogue = manifest["catalogue"]
        .as_array()
        .ok_or("missing full catalogue")?;
    if count == 0 || count > MAX_BATCH_CHUNKS || catalogue.is_empty() {
        return Err("invalid full catalogue shape".into());
    }
    let mut ids = BTreeSet::new();
    let mut rows = BTreeSet::new();
    let mut maximum_actual = 0;
    for entry in catalogue {
        let txid = hash(&entry["txid"], "catalogue txid")?;
        if !ids.insert(txid) {
            return Err("duplicate catalogue txid".into());
        }
        hash(&entry["recordSha256"], "record checksum")?;
        let bytes = unsigned(&entry["recordBytes"], "record byte count")? as usize;
        let actual = bytes.div_ceil(full_record::PAYLOAD_BYTES);
        if bytes == 0 || actual > count {
            return Err("invalid full record byte count".into());
        }
        maximum_actual = maximum_actual.max(actual);
        let allocation = entry["rows"]
            .as_array()
            .ok_or("missing record row allocation")?;
        let expected_rows = if cover_row.is_some() { actual } else { count };
        if allocation.len() != expected_rows {
            return Err("inconsistent record row count for publication packing".into());
        }
        for row in allocation {
            let row = unsigned(row, "catalogue row")? as usize;
            if row >= full_record::ROWS || Some(row) == cover_row || !rows.insert(row) {
                return Err("duplicate or out-of-range catalogue row".into());
            }
        }
    }
    if let Some(cover_row) = cover_row
        && (maximum_actual != count || rows.len() > cover_row)
    {
        return Err("compact publication query maximum or cover capacity mismatch".into());
    }
    Ok(profile)
}

fn read_source(source_path: &Path) -> Result<Value, String> {
    use std::io::Read;
    let file = fs::File::open(source_path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_SOURCE_BYTES {
        return Err("source publication exceeds local import limit".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err("source publication exceeds local import limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn plan(source: &Value) -> Result<Value, String> {
    let input = source_records(source)?;
    let mut ids = BTreeSet::new();
    let (mut chunks, mut payload_rows, mut max_encoded, mut max_decoded) =
        (0_usize, 0_usize, 0_usize, 0_usize);
    let (mut encoded_total, mut decoded_total, mut legacy_total) = (0_usize, 0_usize, 0_usize);
    // Only one expanded record is retained at a time, including candidates
    // whose aggregate does not fit and must be split by the coordinator.
    for value in input {
        let record = checked_record(
            value,
            &source["network"],
            &source["snapshot"],
            &source["coverage"],
            true,
        )?;
        if !ids.insert(record.txid.clone()) {
            return Err("duplicate source transaction ID".into());
        }
        let actual = record.body.len().div_ceil(full_record::PAYLOAD_BYTES);
        chunks = chunks.max(actual);
        payload_rows += actual;
        max_encoded = max_encoded.max(record.body.len());
        max_decoded = max_decoded.max(record.decoded_bytes);
        encoded_total += record.body.len();
        decoded_total += record.decoded_bytes;
        legacy_total += record.legacy_bytes;
    }
    let reason = if legacy_total > MAX_TOTAL_DECODED_BYTES {
        Some("decoded-aggregate")
    } else if chunks > MAX_BATCH_CHUNKS {
        Some("chunk-budget")
    } else if payload_rows >= full_record::ROWS {
        Some("table-rows")
    } else {
        None
    };
    Ok(json!({
        "schema":"zecblock-private-tx-plan-v1","recordCodec":full_record::RECORD_CODEC,
        "packing":"compact-v1","rows":full_record::ROWS,"rowBytes":full_record::ROW_BYTES,
        "payloadBytes":full_record::PAYLOAD_BYTES,"records":input.len(),
        "payloadRows":payload_rows,"coverRows":1,"totalRows":payload_rows+1,
        "chunkCount":chunks,"maxRecordBytes":max_encoded,"maxDecodedRecordBytes":max_decoded,
        "recordBytesTotal":encoded_total,"decodedBytesTotal":decoded_total,
        "legacyRecordBytesTotal":legacy_total,"decodedAggregateLimit":MAX_TOTAL_DECODED_BYTES,
        "fits":reason.is_none(),"capacityReason":reason,
    }))
}

pub(super) fn plan_full(source_path: &Path) -> Result<(), String> {
    let result = plan(&read_source(source_path)?)?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}

pub(super) fn prepare_full(source_path: &Path, dir: &Path) -> Result<(), String> {
    prepare_full_with_codec(source_path, dir, true, false)
}

pub(super) fn prepare_full_debug(source_path: &Path, dir: &Path) -> Result<(), String> {
    prepare_full_with_codec(source_path, dir, true, true)
}

pub(super) fn prepare_full_legacy(source_path: &Path, dir: &Path) -> Result<(), String> {
    prepare_full_with_codec(source_path, dir, false, true)
}

fn prepare_full_with_codec(
    source_path: &Path,
    dir: &Path,
    compressed: bool,
    debug_oracle: bool,
) -> Result<(), String> {
    let source = read_source(source_path)?;
    let mut publication = publication_with_codec(&source, compressed)?;
    // No plaintext debug-oracle retention in ordinary publications.
    if !debug_oracle {
        publication.expected.clear();
    }
    drop(source);
    let profile = validate_manifest(&publication.manifest)?;
    let evaluator = Evaluator::with_profile(publication.database, profile)?;
    let mut manifest = publication.manifest;
    manifest["scheme"] =
        serde_json::to_value(&evaluator.profile.scheme).map_err(|e| e.to_string())?;
    manifest["publicSha256"] = json!(hex::encode(Sha256::digest(&evaluator.public)));
    manifest["databaseSha256"] = json!(hex::encode(Sha256::digest(&evaluator.database)));
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("database.bin"), evaluator.database).map_err(|e| e.to_string())?;
    fs::write(dir.join("public.bin"), evaluator.public).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if debug_oracle {
        let expected =
            serde_json::to_vec_pretty(&publication.expected).map_err(|e| e.to_string())?;
        if expected.len() > MAX_SOURCE_BYTES as usize {
            return Err("Debug oracle exceeds its file budget".into());
        }
        fs::write(dir.join("expected.json"), expected).map_err(|e| e.to_string())?;
    }
    eprintln!(
        "Prepared {} full records, {} padded queries each, {}-byte queries and {}-byte replies",
        manifest["catalogue"].as_array().unwrap().len(),
        manifest["chunkCount"],
        evaluator.profile.scheme.request_bytes,
        evaluator.profile.scheme.response_bytes
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zakura_pir_client::transparent::native::TableClientExt as _;

    fn source() -> Value {
        let fixtures: Vec<SourceFixture> = serde_json::from_str(FIXTURES).unwrap();
        let records: Vec<Value> = fixtures.into_iter().filter(|record| record.network == "mainnet" && record.key.ends_with(":transparent"))
            .take(2).enumerate().map(|(index, record)| json!({
                "txid": record.txid,
                "detail": {"txid": record.txid, "blockHeight": record.height, "blockHash": "11".repeat(32),
                    "status":"confirmed", "isCanonical":true, "feeZat":"0", "inputs":[],"outputs":[],
                    "fixturePadding": "x".repeat(index * 15_000)},
                "raw": {"hex":record.hex,"decoded":{"txid":record.txid}},
            })).collect();
        json!({"schema":SOURCE_SCHEMA,"network":"mainnet",
            "snapshot":{"height":4_000_000,"hash":"22".repeat(32),"publishedAt":"2026-10-28T00:00:00Z"},
            "coverage":{"startHeight":0,"endHeight":4_000_000,"complete":false},"records":records})
    }

    fn assert_actual_pir_roundtrip(publication: Publication) {
        let profile = validate_manifest(&publication.manifest).unwrap();
        let evaluator = Evaluator::with_profile(publication.database, profile).unwrap();
        let count = publication.manifest["chunkCount"].as_u64().unwrap() as usize;
        let cover_row = full_record::packing_cover_row(&publication.manifest).unwrap();
        assert!(count > 1);
        assert_eq!(evaluator.profile.scheme.request_bytes, 20_992);
        assert_eq!(evaluator.profile.scheme.response_bytes, 10_240);
        for entry in publication.manifest["catalogue"].as_array().unwrap() {
            let allocation = entry["rows"].as_array().unwrap();
            let record_count = allocation.len();
            let mut assembled = Vec::new();
            // Prepare and answer the complete uniform batch before decoding.
            let queries: Vec<_> = (0..count)
                .map(|index| {
                    let row = allocation
                        .get(index)
                        .map(|row| row.as_u64().unwrap() as usize)
                        .or(cover_row)
                        .unwrap();
                    let (secret, upload) = evaluator.profile.prepare(row).unwrap();
                    assert_eq!(upload.len(), evaluator.profile.scheme.request_bytes);
                    (index, secret, upload)
                })
                .collect();
            let replies: Vec<_> = queries
                .iter()
                .map(|(_, _, upload)| evaluator.answer(upload).unwrap())
                .collect();
            assert_eq!(queries.len(), count);
            assert_eq!(replies.len(), count);
            for ((index, secret, _), response) in queries.into_iter().zip(replies) {
                assert_eq!(response.len(), evaluator.profile.scheme.response_bytes);
                let decoded = evaluator
                    .profile
                    .decode(&secret, &evaluator.public, &response)
                    .unwrap();
                if index >= record_count {
                    assert!(cover_row.is_some());
                    assert_eq!(decoded.len(), full_record::ROW_BYTES);
                    assert!(decoded.iter().all(|byte| *byte == 0));
                    continue;
                }
                let context = ChunkContext {
                    publication_id: publication.manifest["publicationId"].as_str().unwrap(),
                    txid: entry["txid"].as_str().unwrap(),
                    index,
                    count: record_count,
                    record_bytes: entry["recordBytes"].as_u64().unwrap() as usize,
                    record_sha256: entry["recordSha256"].as_str().unwrap(),
                };
                assembled.extend(full_record::decode_chunk(&context, &decoded).unwrap());
            }
            assert_eq!(
                hex::encode(Sha256::digest(&assembled)),
                entry["recordSha256"]
            );
            let body = full_record::decode_record_from_storage(
                &assembled,
                &publication.manifest,
                entry["txid"].as_str().unwrap(),
            )
            .unwrap();
            let result = full_record::result_envelope(
                body,
                publication.manifest["publicationId"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap(),
                publication.expected[entry["txid"].as_str().unwrap()]
            );
        }
    }

    #[test]
    fn source_file_reader_bounds_import_and_rejects_invalid_json() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "zecblock-source-{}-{nonce}.json",
            std::process::id()
        ));
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_SOURCE_BYTES + 1).unwrap();
        assert!(read_source(&path).unwrap_err().contains("import limit"));
        drop(file);
        fs::write(&path, b"{not-json}").unwrap();
        assert!(read_source(&path).is_err());
        let value = json!({"local":"bounded reader fixture"});
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(read_source(&path).unwrap(), value);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn compact_records_roundtrip_actual_pir_with_fixed_cover_queries() {
        let publication = publication_with_codec(&source(), false).unwrap();
        let manifest = &publication.manifest;
        assert_eq!(manifest["packing"], "compact-v1");
        assert_eq!(manifest["coverRow"], full_record::ROWS - 1);
        let count = manifest["chunkCount"].as_u64().unwrap() as usize;
        let entries = manifest["catalogue"].as_array().unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry["rows"].as_array().unwrap().len() < count)
        );
        let allocated: Vec<_> = entries
            .iter()
            .flat_map(|entry| {
                entry["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row.as_u64().unwrap() as usize)
            })
            .collect();
        assert_eq!(allocated, (0..allocated.len()).collect::<Vec<_>>());
        assert!(allocated.len() < entries.len() * count);
        assert!(
            publication.database[(full_record::ROWS - 1) * full_record::ROW_BYTES..]
                .iter()
                .all(|byte| *byte == 0)
        );
        assert_actual_pir_roundtrip(publication);
    }

    fn legacy_publication() -> Publication {
        let mut publication = publication_with_codec(&source(), false).unwrap();
        publication
            .manifest
            .as_object_mut()
            .unwrap()
            .remove("packing");
        publication
            .manifest
            .as_object_mut()
            .unwrap()
            .remove("coverRow");
        let count = publication.manifest["chunkCount"].as_u64().unwrap() as usize;
        for (index, entry) in publication.manifest["catalogue"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            entry["rows"] = json!((index * count..(index + 1) * count).collect::<Vec<_>>());
        }
        let id = full_record::publication_id(&publication.manifest).unwrap();
        publication.manifest["publicationId"] = json!(id);
        publication.database.fill(0);
        for entry in publication.manifest["catalogue"].as_array().unwrap() {
            let txid = entry["txid"].as_str().unwrap();
            let mut body = publication.expected[txid].clone();
            body.as_object_mut().unwrap().remove("found");
            body.as_object_mut().unwrap().remove("publicationId");
            let bytes = serde_json::to_vec(&body).unwrap();
            assert_eq!(hex::encode(Sha256::digest(&bytes)), entry["recordSha256"]);
            for (index, row) in entry["rows"].as_array().unwrap().iter().enumerate() {
                let start = (index * full_record::PAYLOAD_BYTES).min(bytes.len());
                let end = (start + full_record::PAYLOAD_BYTES).min(bytes.len());
                let context = ChunkContext {
                    publication_id: &id,
                    txid,
                    index,
                    count,
                    record_bytes: bytes.len(),
                    record_sha256: entry["recordSha256"].as_str().unwrap(),
                };
                let row = row.as_u64().unwrap() as usize;
                let encoded = full_record::encode_chunk(&context, &bytes[start..end]).unwrap();
                publication.database
                    [row * full_record::ROW_BYTES..(row + 1) * full_record::ROW_BYTES]
                    .copy_from_slice(&encoded);
            }
            publication.expected.get_mut(txid).unwrap()["publicationId"] = json!(id);
        }
        publication
    }

    #[test]
    fn legacy_padded_manifest_loads_and_roundtrips_actual_pir() {
        let publication = legacy_publication();
        assert!(publication.manifest.get("packing").is_none());
        assert!(publication.manifest.get("coverRow").is_none());
        assert!(validate_manifest(&publication.manifest).is_ok());
        assert_actual_pir_roundtrip(publication);
    }

    fn synthetic_source(count: usize, padding: usize) -> Value {
        // Structurally valid v1 coinbase encodings with distinct scripts are
        // synthetic capacity fixtures, not claims about confirmed chain data.
        let records: Vec<_> = (0..count).map(|index| {
            let mut raw = 1_u32.to_le_bytes().to_vec();
            raw.push(1); raw.extend([0; 32]); raw.extend(u32::MAX.to_le_bytes());
            raw.push(4); raw.extend((index as u32).to_le_bytes()); raw.extend(u32::MAX.to_le_bytes());
            raw.push(1); raw.extend(1_u64.to_le_bytes()); raw.push(1); raw.push(0x51); raw.extend(0_u32.to_le_bytes());
            let view = TransactionView::parse_exact(&raw).unwrap();
            let txid = Txid(view.txid()).to_display_hex();
            json!({"txid":txid,"detail":{"txid":txid,"blockHeight":1,"blockHash":"11".repeat(32),
                "status":"confirmed","isCanonical":true,"feeZat":"0","inputs":[],"outputs":[],"fixturePadding":"x".repeat(padding)},
                "raw":{"hex":hex::encode(raw),"decoded":{"txid":txid}}})
        }).collect();
        json!({"schema":SOURCE_SCHEMA,"network":"mainnet",
            "snapshot":{"height":4_000_000,"hash":"22".repeat(32),"publishedAt":"2026-10-28T00:00:00Z"},
            "coverage":{"startHeight":0,"endHeight":4_000_000,"complete":false},"records":records})
    }

    #[test]
    fn compressed_full_source_roundtrips_actual_pir_and_preserves_duplicate_hex() {
        let mut source = source();
        let padding = (0_u32..600)
            .map(|n| hex::encode(Sha256::digest(n.to_le_bytes())))
            .collect::<String>();
        source["records"][1]["detail"]["fixturePadding"] = json!(padding);
        for record in source["records"].as_array_mut().unwrap() {
            record["raw"]["decoded"]["hex"] = record["raw"]["hex"].clone();
        }
        let planned = plan(&source).unwrap();
        assert_eq!(planned["fits"], true);
        assert!(
            planned["recordBytesTotal"].as_u64().unwrap()
                < planned["legacyRecordBytesTotal"].as_u64().unwrap()
        );
        let publication = publication(&source).unwrap();
        assert_eq!(
            publication.manifest["recordCodec"],
            full_record::RECORD_CODEC
        );
        assert_actual_pir_roundtrip(publication);
    }

    #[test]
    fn planner_reports_whole_set_and_decoded_aggregate_capacity_without_omission() {
        let source = synthetic_source(full_record::ROWS, 0);
        let planned = plan(&source).unwrap();
        assert_eq!(planned["records"], full_record::ROWS);
        assert_eq!(planned["fits"], false);
        assert_eq!(planned["capacityReason"], "table-rows");
        let mut source = synthetic_source(600, 0);
        source["coverage"]["capacity_fixture"] = json!("x".repeat(128 * 1024));
        let planned = plan(&source).unwrap();
        assert_eq!(planned["records"], 600);
        assert_eq!(planned["fits"], false);
        assert_eq!(planned["capacityReason"], "decoded-aggregate");
        assert!(
            planned["legacyRecordBytesTotal"].as_u64().unwrap() > MAX_TOTAL_DECODED_BYTES as u64
        );
        assert!(
            publication(&source)
                .err()
                .unwrap()
                .contains("aggregate decoded capacity")
        );
    }

    #[test]
    fn compact_capacity_reserves_cover_and_rejects_whole_set_overflow() {
        let prepared = publication(&synthetic_source(full_record::ROWS - 1, 0)).unwrap();
        assert_eq!(prepared.manifest["chunkCount"], 1);
        assert_eq!(
            prepared.manifest["catalogue"].as_array().unwrap().len(),
            full_record::ROWS - 1
        );
        assert!(validate_manifest(&prepared.manifest).is_ok());
        assert!(publication(&synthetic_source(full_record::ROWS, 0)).is_err());
        assert!(
            publication(&synthetic_source(
                1,
                full_record::MAX_DECODED_RECORD_BYTES + 1
            ))
            .is_err()
        );
    }

    #[test]
    fn compact_load_rejects_cover_overlap_bad_actual_counts_and_query_maximum() {
        let good = publication_with_codec(&source(), false).unwrap().manifest;
        for mutate in 0..6 {
            let mut bad = good.clone();
            match mutate {
                0 => bad["catalogue"][0]["rows"][0] = json!(full_record::ROWS - 1),
                1 => bad["catalogue"][1]["rows"][0] = bad["catalogue"][0]["rows"][0].clone(),
                2 => bad["catalogue"][0]["rows"] = json!([]),
                3 => bad["chunkCount"] = json!(bad["chunkCount"].as_u64().unwrap() + 1),
                4 => bad["coverRow"] = json!(full_record::ROWS - 2),
                _ => bad["chunkCount"] = json!(MAX_BATCH_CHUNKS + 1),
            }
            if let Ok(id) = full_record::publication_id(&bad) {
                bad["publicationId"] = json!(id);
            }
            assert!(
                validate_manifest(&bad).is_err(),
                "invalid compact layout case {mutate}"
            );
        }
    }

    #[test]
    fn import_rejects_wrong_raw_identity_duplicates_noncanonical_and_bad_allocation() {
        let good = source();
        for mutate in 0..4 {
            let mut bad = good.clone();
            match mutate {
                0 => bad["records"][0]["raw"]["hex"] = json!("00"),
                1 => bad["records"][1] = bad["records"][0].clone(),
                2 => bad["records"][0]["detail"]["isCanonical"] = json!(false),
                _ => bad["records"][0]["detail"]["feeZat"] = json!(0.5),
            }
            assert!(publication(&bad).is_err());
        }
        let mut manifest = publication(&good).unwrap().manifest;
        manifest["catalogue"][0]["rows"][0] = json!(full_record::ROWS);
        manifest["publicationId"] = json!(full_record::publication_id(&manifest).unwrap());
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn publication_keeps_declared_time_without_claiming_wallclock_freshness() {
        let mut source = source();
        source["snapshot"]["publishedAt"] = json!("2001-01-01T00:00:00Z");
        source["records"][0]["source"] = json!({"authority":"test fixture observation"});
        let publication = publication(&source).unwrap();
        assert_eq!(
            publication.manifest["snapshot"]["publishedAt"],
            source["snapshot"]["publishedAt"]
        );
        let entry = publication
            .expected
            .values()
            .find(|record| record.get("source").is_some())
            .unwrap();
        assert_eq!(entry["source"]["authority"], "test fixture observation");
    }

    #[test]
    fn import_rejects_a_record_that_disagrees_with_the_same_height_snapshot() {
        let mut source = source();
        source["records"].as_array_mut().unwrap().truncate(1);
        let height = source["records"][0]["detail"]["blockHeight"].clone();
        source["snapshot"]["height"] = height.clone();
        source["coverage"]["startHeight"] = height.clone();
        source["coverage"]["endHeight"] = height;
        source["snapshot"]["hash"] = source["records"][0]["detail"]["blockHash"].clone();
        assert!(publication(&source).is_ok());
        source["snapshot"]["hash"] = json!("22".repeat(32));
        assert!(publication(&source).is_err());
    }
}
