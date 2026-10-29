//! Bounded, immutable full-record publications around the pinned upstream PIR.
use super::*;
use crate::full_record::{self, ChunkContext};
use std::collections::BTreeSet;

const SOURCE_SCHEMA: &str = "zecblock-private-tx-source-v1";
const RECORD_SCHEMA: &str = "zecblock-private-tx-record-v1";
const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;

struct Record {
    txid: String,
    height: u64,
    body: Vec<u8>,
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
    let body = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    let sha256 = hex::encode(Sha256::digest(&body));
    Ok(Record {
        txid,
        height,
        body,
        sha256,
        rows: Vec::new(),
    })
}

fn publication(source: &Value) -> Result<Publication, String> {
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
    let mut records = input
        .iter()
        .map(|record| checked_record(record, &source["network"], snapshot, coverage))
        .collect::<Result<Vec<_>, _>>()?;
    records.sort_by(|a, b| a.txid.cmp(&b.txid));
    if records.windows(2).any(|pair| pair[0].txid == pair[1].txid) {
        return Err("duplicate source transaction ID".into());
    }
    let chunk_count = records
        .iter()
        .map(|record| record.body.len().div_ceil(full_record::PAYLOAD_BYTES))
        .max()
        .ok_or("empty publication")?;
    if chunk_count
        .checked_mul(records.len())
        .is_none_or(|rows| rows > full_record::ROWS)
    {
        return Err("full publication does not fit its fixed padded table".into());
    }
    let mut catalogue = Vec::with_capacity(records.len());
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
    for (index, record) in records.iter_mut().enumerate() {
        record.rows = (index * chunk_count..(index + 1) * chunk_count).collect();
        catalogue.push(json!({
            "txid": record.txid, "height": record.height,
            "label": "Confirmed mainnet snapshot transaction",
            "rows": record.rows, "recordBytes": record.body.len(), "recordSha256": record.sha256,
        }));
        expected.insert(
            record.txid.clone(),
            serde_json::from_slice(&record.body).map_err(|e| e.to_string())?,
        );
    }
    let mut manifest = json!({
        "schema": full_record::SCHEMA, "geometry": full_record::GEOMETRY, "table": full_record::TABLE,
        "rows": full_record::ROWS, "rowBytes": full_record::ROW_BYTES,
        "payloadBytes": full_record::PAYLOAD_BYTES, "chunkCount": chunk_count,
        "network": source["network"], "snapshot": snapshot, "coverage": coverage,
        "catalogue": catalogue,
        "upstream": {"walletLibraries": UPSTREAM, "ipirSp": IPIR},
        "scope": "Bounded confirmed mainnet snapshot; publisher-supplied detail/verbose records. Fixed padded chunk queries; no live mempool or arbitrary historical coverage claim.",
    });
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
                count: chunk_count,
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
    if manifest["publicationId"] != full_record::publication_id(manifest)? {
        return Err("full manifest publication binding mismatch".into());
    }
    let count = unsigned(&manifest["chunkCount"], "chunk count")? as usize;
    let catalogue = manifest["catalogue"]
        .as_array()
        .ok_or("missing full catalogue")?;
    if count == 0 || count > full_record::ROWS || catalogue.is_empty() {
        return Err("invalid full catalogue shape".into());
    }
    let mut ids = BTreeSet::new();
    let mut rows = BTreeSet::new();
    for entry in catalogue {
        let txid = hash(&entry["txid"], "catalogue txid")?;
        if !ids.insert(txid) {
            return Err("duplicate catalogue txid".into());
        }
        hash(&entry["recordSha256"], "record checksum")?;
        let bytes = unsigned(&entry["recordBytes"], "record byte count")? as usize;
        if bytes == 0 || bytes.div_ceil(full_record::PAYLOAD_BYTES) > count {
            return Err("invalid full record byte count".into());
        }
        let allocation = entry["rows"]
            .as_array()
            .ok_or("missing record row allocation")?;
        if allocation.len() != count {
            return Err("inconsistent padded query count".into());
        }
        for row in allocation {
            let row = unsigned(row, "catalogue row")? as usize;
            if row >= full_record::ROWS || !rows.insert(row) {
                return Err("duplicate or out-of-range catalogue row".into());
            }
        }
    }
    Ok(profile)
}

pub(super) fn prepare_full(source_path: &Path, dir: &Path) -> Result<(), String> {
    if fs::metadata(source_path).map_err(|e| e.to_string())?.len() > MAX_SOURCE_BYTES {
        return Err("source publication exceeds local import limit".into());
    }
    let source: Value = serde_json::from_slice(&fs::read(source_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let publication = publication(&source)?;
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
    fs::write(
        dir.join("expected.json"),
        serde_json::to_vec_pretty(&publication.expected).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
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

    #[test]
    fn full_multi_chunk_records_roundtrip_actual_pir_with_uniform_padding() {
        let publication = publication(&source()).unwrap();
        let profile = validate_manifest(&publication.manifest).unwrap();
        let evaluator = Evaluator::with_profile(publication.database, profile).unwrap();
        let count = publication.manifest["chunkCount"].as_u64().unwrap() as usize;
        assert!(count > 1);
        for entry in publication.manifest["catalogue"].as_array().unwrap() {
            let mut assembled = Vec::new();
            for (index, row) in entry["rows"].as_array().unwrap().iter().enumerate() {
                let (secret, upload) = evaluator
                    .profile
                    .prepare(row.as_u64().unwrap() as usize)
                    .unwrap();
                let response = evaluator.answer(&upload).unwrap();
                let decoded = evaluator
                    .profile
                    .decode(&secret, &evaluator.public, &response)
                    .unwrap();
                let context = ChunkContext {
                    publication_id: publication.manifest["publicationId"].as_str().unwrap(),
                    txid: entry["txid"].as_str().unwrap(),
                    index,
                    count,
                    record_bytes: entry["recordBytes"].as_u64().unwrap() as usize,
                    record_sha256: entry["recordSha256"].as_str().unwrap(),
                };
                assembled.extend(full_record::decode_chunk(&context, &decoded).unwrap());
            }
            assert_eq!(
                hex::encode(Sha256::digest(&assembled)),
                entry["recordSha256"]
            );
            let body: Value = serde_json::from_slice(&assembled).unwrap();
            let result = full_record::result_envelope(
                body,
                publication.manifest["publicationId"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap(),
                publication.expected[entry["txid"].as_str().unwrap()]
            );
            assert_eq!(entry["rows"].as_array().unwrap().len(), count);
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
