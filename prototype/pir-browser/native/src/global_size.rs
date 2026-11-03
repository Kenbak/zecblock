//! Aggregate codec measurements only: no table preparation or serving writes.
use super::*;
use std::{fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt};

const MAX_INPUT: u64 = 128 * 1024 * 1024;

struct Totals {
    encoded: u64,
    maximum: usize,
    squares: u128,
    buckets: Vec<(usize, Vec<u64>, Vec<usize>)>,
}
impl Totals {
    fn new() -> Self {
        Self {
            encoded: 0,
            maximum: 0,
            squares: 0,
            buckets: [2048, 8192, 16384, 32768, 65536, 131072]
                .into_iter()
                .map(|rows| (rows, vec![0; rows], vec![0; rows]))
                .collect(),
        }
    }
    fn add(&mut self, txid: &str, size: usize) -> Result<(), String> {
        let mut hash = Sha256::new();
        hash.update(b"ZBGL-KEY-v1\0");
        hash.update(hex::decode(txid).map_err(|e| e.to_string())?);
        let digest = hash.finalize();
        let key = u64::from_le_bytes(digest[..8].try_into().unwrap());
        self.encoded += size as u64;
        self.maximum = self.maximum.max(size);
        self.squares += (size as u128) * (size as u128);
        for (rows, sizes, counts) in &mut self.buckets {
            let row = (key % *rows as u64) as usize;
            if counts[row] == 0 {
                sizes[row] = 16;
            }
            sizes[row] += 72 + size as u64;
            counts[row] += 1;
        }
        Ok(())
    }
    fn value(&self) -> Value {
        json!({"encodedBytes":self.encoded,"maxEncodedRecordBytes":self.maximum,
            "sumEncodedSquares":self.squares.to_string(),
            "candidateBuckets":self.buckets.iter().map(|(rows,sizes,counts)|json!({
                "rows":rows,"occupiedBuckets":counts.iter().filter(|&&n|n>0).count(),
                "framedBucketBytes":sizes.iter().sum::<u64>(),
                "maxBucketBytes":sizes.iter().copied().max().unwrap_or(0),
                "maxBucketRecords":counts.iter().copied().max().unwrap_or(0)
            })).collect::<Vec<_>>()})
    }
}

pub(super) fn measure_source(path: &Path) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    let info = file.metadata().map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() < 2 || info.len() > MAX_INPUT {
        return Err("Codec measurement requires a bounded ordinary source file".into());
    }
    let mut bytes = Vec::with_capacity(info.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != info.len() {
        return Err("Codec measurement source changed or exceeded its bound".into());
    }
    let result = measurement(&bytes)?;
    serde_json::to_writer(io::stdout().lock(), &result).map_err(|e| e.to_string())?;
    println!();
    Ok(())
}

fn measurement(bytes: &[u8]) -> Result<Value, String> {
    let source: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if source["schema"] != "zecblock-private-global-source-v1" || source["network"] != "mainnet" {
        return Err("Unsupported codec measurement source".into());
    }
    let records = source["records"]
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 2048)
        .ok_or("Codec measurement record count exceeds the source bound")?;
    let mut seen = std::collections::BTreeSet::new();
    let mut totals = [Totals::new(), Totals::new()];
    let mut decoded = 0u64;
    let mut largest_decoded = 0usize;
    let mut raw_bytes = 0u64;
    let started = std::time::Instant::now();
    for record in records {
        let txid = record["txid"].as_str().ok_or("Missing source txid")?;
        if !seen.insert(txid.to_ascii_lowercase()) {
            return Err("Duplicate source transaction".into());
        }
        let size = serde_json::to_vec(record).map_err(|e| e.to_string())?.len();
        decoded += size as u64;
        largest_decoded = largest_decoded.max(size);
        raw_bytes += record["raw"]["hex"]
            .as_str()
            .ok_or("Missing raw bytes")?
            .len() as u64
            / 2;
        for (i, codec) in [global_data::RECORD_CODEC, global_data::COMPACT_RECORD_CODEC]
            .iter()
            .enumerate()
        {
            let stored = global_data::encode_record_with_codec(record, codec)?;
            if global_data::decode_record_with_codec(&stored, txid, codec)? != *record {
                return Err("Codec measurement failed full-record value parity".into());
            }
            totals[i].add(txid, stored.len())?;
        }
    }
    let result = json!({"schema":"zecblock-private-global-codec-measurement-v1",
        "sourceRawFileSha256":hex::encode(Sha256::digest(bytes)),"sourceBytes":bytes.len(),
        "recordCount":records.len(),"decodedEnvelopeBytes":decoded,"maxDecodedEnvelopeBytes":largest_decoded,
        "rawWireBytes":raw_bytes,"roundTripValuesEqual":true,
        "codecs":{"v1":totals[0].value(),"v2":totals[1].value()},
        "codecNames":{"v1":global_data::RECORD_CODEC,"v2":global_data::COMPACT_RECORD_CODEC},
        "elapsedMs":started.elapsed().as_secs_f64()*1000.0,
        "scope":"Actual captured source and lossless codec round trips only. Candidate hash distributions are sample facts, not full-history maximum buckets, approved geometries or serving-size estimates. No PIR artifacts prepared."});
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> Value {
        let fixtures: Vec<Value> = serde_json::from_str(FIXTURES).unwrap();
        let records=fixtures.iter().filter(|fixture|fixture["network"]=="mainnet"
            && fixture["key"].as_str().unwrap().ends_with(":transparent")).take(2).enumerate().map(|(index,fixture)| {
                let height=fixture["height"].as_u64().unwrap();let txid=&fixture["txid"];
                json!({"schema":full_record::RECORD_SCHEMA,"network":"mainnet","txid":txid,
                    "snapshot":{"height":4_000_000+index as u64,"hash":"22".repeat(32),"publishedAt":"2026-11-03T00:00:00Z"},
                    "coverage":{"startHeight":height,"endHeight":height,"complete":false},
                    "detail":{"txid":txid,"status":"confirmed","isCanonical":true,"blockHeight":height,"blockHash":"11".repeat(32),
                        "inputs":[],"outputs":[],"feeZat":if index==0 {Value::Null} else {json!("0")}},
                    "raw":{"txid":txid,"hex":fixture["hex"],"decoded":{"txid":txid,"hex":fixture["hex"],"unknownRpcField":null}},
                    "unknownCapture":{"negative":"-12345678901234567890","unicode":"é漢字","caseSensitiveHex":"aAbBcC","empty":[]}})
            }).collect::<Vec<_>>();
        json!({"schema":"zecblock-private-global-source-v1","network":"mainnet","records":records})
    }

    #[test]
    fn real_fixture_measurements_match_codec_framing_and_lossless_round_trips() {
        let source = source();
        let bytes = serde_json::to_vec_pretty(&source).unwrap();
        let report = measurement(&bytes).unwrap();
        let records = source["records"].as_array().unwrap();
        assert_eq!(report["recordCount"], 2);
        assert_eq!(report["roundTripValuesEqual"], true);
        assert_eq!(report["sourceBytes"], bytes.len());
        assert_eq!(
            report["sourceRawFileSha256"],
            hex::encode(Sha256::digest(&bytes))
        );
        assert_eq!(
            report["decodedEnvelopeBytes"],
            records
                .iter()
                .map(|record| serde_json::to_vec(record).unwrap().len())
                .sum::<usize>()
        );
        assert_eq!(
            report["maxDecodedEnvelopeBytes"],
            records
                .iter()
                .map(|record| serde_json::to_vec(record).unwrap().len())
                .max()
                .unwrap()
        );
        assert_eq!(
            report["rawWireBytes"],
            records
                .iter()
                .map(|record| hex::decode(record["raw"]["hex"].as_str().unwrap())
                    .unwrap()
                    .len())
                .sum::<usize>()
        );
        for (name, codec) in [
            ("v1", global_data::RECORD_CODEC),
            ("v2", global_data::COMPACT_RECORD_CODEC),
        ] {
            let entries = records
                .iter()
                .map(|record| global_data::encode_entry_with_codec(record, codec).unwrap())
                .collect::<Vec<_>>();
            let sizes = entries
                .iter()
                .map(|entry| entry.encoded.len())
                .collect::<Vec<_>>();
            for (record, entry) in records.iter().zip(&entries) {
                let decoded =
                    global_data::decode_record_with_codec(&entry.encoded, &entry.txid, codec)
                        .unwrap();
                assert_eq!(&decoded, record);
                assert_eq!(
                    serde_json::to_vec(&decoded).unwrap(),
                    serde_json::to_vec(record).unwrap()
                );
                assert_eq!(decoded["raw"]["decoded"]["hex"], record["raw"]["hex"]);
            }
            let measured = &report["codecs"][name];
            assert_eq!(report["codecNames"][name], codec);
            assert_eq!(measured["encodedBytes"], sizes.iter().sum::<usize>());
            assert_eq!(
                measured["maxEncodedRecordBytes"],
                *sizes.iter().max().unwrap()
            );
            assert_eq!(
                measured["sumEncodedSquares"],
                sizes
                    .iter()
                    .map(|&size| (size as u128).pow(2))
                    .sum::<u128>()
                    .to_string()
            );
            // Compare the 2k candidate against actual codec framing rather
            // than repeating Totals' bucket-header accounting formula.
            let mut grouped: BTreeMap<usize, Vec<global_data::EncodedEntry>> = BTreeMap::new();
            for entry in entries {
                grouped
                    .entry(global_data::key_row(&entry.txid).unwrap())
                    .or_default()
                    .push(entry);
            }
            let framed = grouped
                .values()
                .map(|entries| {
                    global_data::encode_bucket_entries_with_codec(entries, codec).unwrap()
                })
                .collect::<Vec<_>>();
            let candidate = &measured["candidateBuckets"][0];
            assert_eq!(candidate["rows"], 2048);
            assert_eq!(candidate["occupiedBuckets"], grouped.len());
            assert_eq!(
                candidate["framedBucketBytes"],
                framed.iter().map(Vec::len).sum::<usize>()
            );
            assert_eq!(
                candidate["maxBucketBytes"],
                framed.iter().map(Vec::len).max().unwrap()
            );
            assert_eq!(
                candidate["maxBucketRecords"],
                grouped.values().map(Vec::len).max().unwrap()
            );
        }
        let compact = measurement(&serde_json::to_vec(&source).unwrap()).unwrap();
        assert_eq!(compact["codecs"], report["codecs"]);
        assert_ne!(
            compact["sourceRawFileSha256"],
            report["sourceRawFileSha256"]
        );
        let text = serde_json::to_string(&report).unwrap();
        for record in records {
            assert!(!text.contains(record["txid"].as_str().unwrap()));
        }
    }

    #[test]
    fn candidate_bucket_collisions_charge_one_header_and_preserve_maxima() {
        // Independently fixed SHA256-domain collision modulo 131072. Every
        // smaller candidate is a power-of-two divisor and shares this bucket.
        let mut totals = Totals::new();
        totals
            .add(
                "000000000000000000000000000000000000000000000000000000000000005e",
                100,
            )
            .unwrap();
        totals
            .add(
                "00000000000000000000000000000000000000000000000000000000000000e5",
                200,
            )
            .unwrap();
        let report = totals.value();
        assert_eq!(report["encodedBytes"], 300);
        assert_eq!(report["maxEncodedRecordBytes"], 200);
        assert_eq!(report["sumEncodedSquares"], "50000");
        assert_eq!(report["candidateBuckets"].as_array().unwrap().len(), 6);
        for candidate in report["candidateBuckets"].as_array().unwrap() {
            assert_eq!(candidate["occupiedBuckets"], 1);
            assert_eq!(candidate["maxBucketRecords"], 2);
            assert_eq!(candidate["framedBucketBytes"], 460);
            assert_eq!(candidate["maxBucketBytes"], 460);
        }
    }

    #[test]
    fn measurement_rejects_duplicates_wrong_identity_and_invalid_source_contracts() {
        let original = source();
        let mut duplicate = original.clone();
        duplicate["records"][1] = duplicate["records"][0].clone();
        assert!(
            measurement(&serde_json::to_vec(&duplicate).unwrap())
                .unwrap_err()
                .contains("Duplicate")
        );
        duplicate["records"][1]["txid"] = json!(
            duplicate["records"][0]["txid"]
                .as_str()
                .unwrap()
                .to_ascii_uppercase()
        );
        assert!(
            measurement(&serde_json::to_vec(&duplicate).unwrap())
                .unwrap_err()
                .contains("Duplicate")
        );
        let mut invalid = original.clone();
        invalid["records"][0]["raw"]["hex"] = original["records"][1]["raw"]["hex"].clone();
        assert!(measurement(&serde_json::to_vec(&invalid).unwrap()).is_err());
        for field in ["schema", "network"] {
            let mut invalid = original.clone();
            invalid[field] = json!("unsupported");
            assert!(measurement(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        for records in [
            json!([]),
            json!({}),
            json!(vec![original["records"][0].clone(); 2049]),
        ] {
            let mut invalid = original.clone();
            invalid["records"] = records;
            assert!(measurement(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        let mut invalid = original;
        invalid["records"][0]["detail"]["feeZat"] = json!(0);
        assert!(measurement(&serde_json::to_vec(&invalid).unwrap()).is_err());
        assert!(measurement(b"{broken").is_err());
    }

    #[test]
    fn source_file_reader_rejects_symlinks_directories_and_oversized_sparse_inputs() {
        use std::{
            os::unix::fs::symlink,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "global-size-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let source = root.join("source.json");
        fs::write(&source, b"{}").unwrap();
        symlink(&source, root.join("link.json")).unwrap();
        assert!(measure_source(&root.join("link.json")).is_err());
        assert!(measure_source(&root).is_err());
        let oversized = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(root.join("oversized.json"))
            .unwrap();
        oversized.set_len(MAX_INPUT + 1).unwrap();
        assert!(measure_source(&root.join("oversized.json")).is_err());
        fs::write(&source, b"{").unwrap();
        assert!(measure_source(&source).is_err());
    }
}
