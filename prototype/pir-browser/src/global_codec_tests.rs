use super::*;
use serde_json::json;

fn fixture() -> (Value, String) {
    let originals: Vec<Value> = serde_json::from_str(include_str!(
        "../../../server/tests/fixtures/browser-transactions.json"
    ))
    .unwrap();
    let source = &originals[0];
    let txid = source["txid"].as_str().unwrap().to_owned();
    let record = json!({"schema":crate::full_record::RECORD_SCHEMA,"network":"mainnet",
        "snapshot":{"height":500_000,"hash":"11".repeat(32),"publishedAt":"2026-11-03T00:00:00Z"},
        "coverage":{"startHeight":419_200,"endHeight":419_200},"txid":txid,
        "detail":{"txid":txid,"status":"confirmed","isCanonical":true,"blockHeight":419_200,"blockHash":"22".repeat(32),"inputs":[],"outputs":[],"feeZat":"0"},
        "raw":{"txid":txid,"hex":source["hex"],"decoded":{"txid":txid,"hex":source["hex"]}},
        "unknownRpcFields":{"null":null,"emptyArray":[],"emptyObject":{},"exactZat":"-12345678901234567890"}});
    (record, txid)
}

fn number(out: &mut Vec<u8>, value: usize) {
    out.extend_from_slice(&(value as u32).to_le_bytes());
}

fn bytes(out: &mut Vec<u8>, data: &[u8]) {
    number(out, data.len());
    out.extend_from_slice(data);
}

fn stored(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut out = COMPACT_RECORD_MAGIC.to_vec();
    number(&mut out, payload.len());
    out.push(flags);
    out.extend_from_slice(&[0; 3]);
    out.extend(miniz_oxide::deflate::compress_to_vec_zlib(payload, 6));
    out
}

#[test]
fn compact_binary_json_preserves_every_value_case_number_and_unknown_field() {
    let raw = (0..=255_u8).collect::<Vec<_>>();
    let value: Value = serde_json::from_str(&format!(r#"{{"raw":{{"hex":"{}"}},"values":[null,false,true,-9223372036854775808,18446744073709551615,1.0,-0.0,1e-20,"","é漢字\n\t\u0000\"\\",[],{{}},"aAbBcC","{}","{}","00000000"],"missingVsNull":{{"present":null}}}}"#,
        hex::encode(&raw), hex::encode(&raw[17..155]), hex::encode_upper(&raw[17..155]))).unwrap();
    let encoded = compact_codec::encode(&value).unwrap();
    let decoded = compact_codec::decode(&encoded).unwrap();
    assert_eq!(decoded, value);
    assert_eq!(canonical(&decoded).unwrap(), canonical(&value).unwrap());
    assert_eq!(u32::from_le_bytes(encoded[..4].try_into().unwrap()), 256);
    assert!(decoded["missingVsNull"].get("missing").is_none());
    assert!(decoded["missingVsNull"]["present"].is_null());
    assert!(encoded.len() < canonical(&value).unwrap().len());
}

#[test]
fn compact_json_literal_fallback_bounds_tiny_number_overhead_losslessly() {
    let value = json!(vec![0; 1000]);
    let encoded = compact_codec::encode(&value).unwrap();
    assert_eq!(&encoded[..4], &[0; 4]);
    assert_eq!(encoded[4], 11);
    assert_eq!(encoded.len(), canonical(&value).unwrap().len() + 9);
    assert_eq!(compact_codec::decode(&encoded).unwrap(), value);
}

#[test]
fn compact_record_retains_wire_identity_context_and_duplicate_hex_presence() {
    let (original, txid) = fixture();
    for mode in 0..3 {
        let mut record = original.clone();
        if mode == 1 {
            record["raw"]["decoded"]
                .as_object_mut()
                .unwrap()
                .remove("hex");
        }
        if mode == 2 {
            record["raw"]["decoded"]["hex"] = json!("different unknown RPC metadata");
        }
        let v1 = encode_record(&record).unwrap();
        let v2 = encode_record_with_codec(&record, COMPACT_RECORD_CODEC).unwrap();
        assert_eq!(stored_record_codec(&v1).unwrap(), RECORD_CODEC);
        assert_eq!(stored_record_codec(&v2).unwrap(), COMPACT_RECORD_CODEC);
        assert_eq!(v1[12], v2[12]);
        assert_eq!(decode_record(&v2, &txid).unwrap(), record);
        assert_eq!(
            decode_record_with_codec(&v2, &txid, COMPACT_RECORD_CODEC).unwrap(),
            record
        );
        assert!(decode_record_with_codec(&v2, &txid, RECORD_CODEC).is_err());
        assert!(decode_record_with_codec(&v1, &txid, COMPACT_RECORD_CODEC).is_err());
        assert!(decode_record(&v2, &"ff".repeat(32)).is_err());
        assert_eq!(encode_record_with_codec(&record, RECORD_CODEC).unwrap(), v1);
    }
}

#[test]
fn compact_bucket_enforces_manifest_codec_even_for_absent_selection() {
    let (record, txid) = fixture();
    let entry = encode_entry_with_codec(&record, COMPACT_RECORD_CODEC).unwrap();
    let bucket = encode_bucket_entries_with_codec(&[entry], COMPACT_RECORD_CODEC).unwrap();
    assert_eq!(
        decode_bucket_with_codec(&bucket, &txid, COMPACT_RECORD_CODEC).unwrap(),
        Some(record.clone())
    );
    assert!(decode_bucket(&bucket, &txid).is_err());
    assert_eq!(
        decode_bucket_with_codec(&bucket, &"ff".repeat(32), COMPACT_RECORD_CODEC).unwrap(),
        None
    );
    let mut bad = bucket;
    bad[BUCKET_HEADER_BYTES + ENTRY_HEADER_BYTES..BUCKET_HEADER_BYTES + ENTRY_HEADER_BYTES + 8]
        .copy_from_slice(RECORD_MAGIC);
    assert!(decode_bucket_with_codec(&bad, &"ff".repeat(32), COMPACT_RECORD_CODEC).is_err());
    let v1 = encode_entry(&record).unwrap();
    assert!(encode_bucket_entries_with_codec(&[v1], COMPACT_RECORD_CODEC).is_err());
    let v2 = encode_entry_with_codec(&record, COMPACT_RECORD_CODEC).unwrap();
    assert!(encode_bucket_entries(&[v2]).is_err());
    let base = json!({"recordCodec":RECORD_CODEC,"sourceDigest":"22".repeat(32)});
    let compact = json!({"recordCodec":COMPACT_RECORD_CODEC,"sourceDigest":"22".repeat(32)});
    assert_ne!(
        manifest_context_id(&base).unwrap(),
        manifest_context_id(&compact).unwrap()
    );
}

#[test]
fn compact_binary_rejects_truncation_trailing_bad_refs_tags_keys_and_numbers() {
    let value = json!({"hex":"aa".repeat(128),"unknown":[null,1,"hello"]});
    let good = compact_codec::encode(&value).unwrap();
    for length in 0..good.len() {
        assert!(
            compact_codec::decode(&good[..length]).is_err(),
            "length {length}"
        );
    }
    let mut trailing = good.clone();
    trailing.push(0);
    assert!(compact_codec::decode(&trailing).is_err());
    let mut cases = Vec::new();
    cases.push(vec![0, 0, 0, 0, 255]);
    let mut invalid_ref = Vec::new();
    bytes(&mut invalid_ref, &[1, 2, 3]);
    invalid_ref.push(9);
    number(&mut invalid_ref, u32::MAX as usize);
    number(&mut invalid_ref, 4);
    cases.push(invalid_ref);
    let mut oversized_length = vec![0; 4];
    oversized_length.push(4);
    number(&mut oversized_length, u32::MAX as usize);
    cases.push(oversized_length);
    for keys in [["a", "a"], ["b", "a"]] {
        let mut object = vec![0; 4];
        object.push(6);
        number(&mut object, 2);
        for key in keys {
            bytes(&mut object, key.as_bytes());
            object.push(0);
        }
        cases.push(object);
    }
    for text in ["01", "1e0", "+1", "NaN"] {
        let mut invalid_number = vec![0; 4];
        invalid_number.push(3);
        bytes(&mut invalid_number, text.as_bytes());
        cases.push(invalid_number);
    }
    let mut invalid_utf8 = vec![0; 4];
    invalid_utf8.push(4);
    bytes(&mut invalid_utf8, &[255]);
    cases.push(invalid_utf8);
    let mut noncanonical_hex_string = vec![0; 4];
    noncanonical_hex_string.push(4);
    bytes(
        &mut noncanonical_hex_string,
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    cases.push(noncanonical_hex_string);
    let mut nested_literal = vec![0; 4];
    nested_literal.push(5);
    number(&mut nested_literal, 1);
    nested_literal.push(11);
    bytes(&mut nested_literal, b"null");
    cases.push(nested_literal);
    for bad in cases {
        assert!(compact_codec::decode(&bad).is_err(), "bad {bad:?}");
    }
}

#[test]
fn compact_binary_accounts_expansion_before_allocating_repeated_raw_spans() {
    let mut bomb = Vec::new();
    bytes(&mut bomb, &vec![1; 4096]);
    bomb.push(5);
    number(&mut bomb, 5000);
    for _ in 0..5000 {
        bomb.push(9);
        number(&mut bomb, 0);
        number(&mut bomb, 4096);
    }
    assert!(
        compact_codec::decode(&bomb)
            .unwrap_err()
            .contains("oversized")
    );
    let mut deep = vec![0; 4];
    for _ in 0..130 {
        deep.push(5);
        number(&mut deep, 1);
    }
    deep.push(0);
    assert!(compact_codec::decode(&deep).is_err());
}

#[test]
fn compact_record_rejects_bad_headers_streams_lengths_and_restored_overflow() {
    let (record, txid) = fixture();
    let good = encode_record_with_codec(&record, COMPACT_RECORD_CODEC).unwrap();
    let mut cases = Vec::new();
    for offset in [0, 12, 13, good.len() - 1] {
        let mut bad = good.clone();
        bad[offset] ^= if offset == 12 { 2 } else { 1 };
        cases.push(bad);
    }
    for length in [
        0,
        compact_codec::MAX_PAYLOAD_BYTES as u32 + 1,
        u32::from_le_bytes(good[8..12].try_into().unwrap()) - 1,
        u32::from_le_bytes(good[8..12].try_into().unwrap()) + 1,
    ] {
        let mut bad = good.clone();
        bad[8..12].copy_from_slice(&length.to_le_bytes());
        cases.push(bad);
    }
    cases.push(good[..good.len() - 1].to_vec());
    let mut trailing = good.clone();
    trailing.push(0);
    cases.push(trailing);
    let mut concatenated = good.clone();
    concatenated.extend_from_slice(&good[16..]);
    cases.push(concatenated);
    for bad in cases {
        assert!(decode_record(&bad, &txid).is_err());
    }
    let mut conflict = record.clone();
    let body = compact_codec::encode(&conflict).unwrap();
    assert!(
        decode_record(&stored(&body, 1), &txid)
            .unwrap_err()
            .contains("Conflicting")
    );
    conflict["detail"]["tooLarge"] = json!("x".repeat(MAX_DECODED_RECORD_BYTES));
    assert!(encode_record_with_codec(&conflict, COMPACT_RECORD_CODEC).is_err());

    // The pre-restoration JSON fits exactly; restoring the duplicate raw hex
    // crosses the envelope limit and must still fail in the v2 decoder.
    let mut payload = record;
    payload["raw"]["decoded"]
        .as_object_mut()
        .unwrap()
        .remove("hex");
    payload["detail"]["padding"] = json!("");
    let base = canonical(&payload).unwrap().len();
    payload["detail"]["padding"] = json!("x".repeat(MAX_DECODED_RECORD_BYTES - base));
    let body = compact_codec::encode(&payload).unwrap();
    assert!(
        decode_record(&stored(&body, 1), &txid)
            .unwrap_err()
            .contains("Restored")
    );
}

#[test]
#[ignore = "opt-in local codec comparison; no PIR matrix preparation or services"]
fn compare_real_captured_records_without_pir_preprocessing() {
    use std::time::Instant;
    let source_path = std::env::var("GLOBAL_CODEC_SOURCE_PATH").unwrap_or_else(|_| {
        format!(
            "{}/../private-tx/.local/global-lab-evidence/source.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let source_bytes = std::fs::read(&source_path).unwrap();
    assert!(source_bytes.len() <= MAX_SOURCE_BYTES);
    let source: Value = serde_json::from_slice(&source_bytes).unwrap();
    let records = source["records"].as_array().unwrap();
    assert!(!records.is_empty() && records.len() <= ROWS);
    let mut rows = Vec::new();
    let mut buckets = [vec![0_usize; ROWS], vec![0_usize; ROWS]];
    let mut sums = [0_usize; 2];
    let mut elapsed = [0_u128; 2];
    for record in records {
        let txid = record["txid"].as_str().unwrap();
        let restored = canonical(record).unwrap();
        let row = key_row(txid).unwrap();
        let mut encoded = [0_usize; 2];
        for (index, codec) in [RECORD_CODEC, COMPACT_RECORD_CODEC].iter().enumerate() {
            let start = Instant::now();
            let entry = encode_entry_with_codec(record, codec).unwrap();
            let decoded = decode_record_with_codec(&entry.encoded, txid, codec).unwrap();
            assert_eq!(canonical(&decoded).unwrap(), restored);
            elapsed[index] += start.elapsed().as_micros();
            encoded[index] = entry.encoded.len();
            sums[index] += entry.encoded.len();
            if buckets[index][row] == 0 {
                buckets[index][row] = BUCKET_HEADER_BYTES;
            }
            buckets[index][row] += ENTRY_HEADER_BYTES + entry.encoded.len();
        }
        rows.push(json!({"txid":txid,"row":row,"restoredBytes":restored.len(),"rawWireBytes":record["raw"]["hex"].as_str().unwrap().len()/2,
            "canonicalSha256":digest(&restored),"v1EncodedBytes":encoded[0],"v2EncodedBytes":encoded[1],"canonicalRoundtripEqual":true}));
    }
    let profile = profile().unwrap();
    let summaries = [RECORD_CODEC, COMPACT_RECORD_CODEC].iter().enumerate().map(|(index, codec)| {
        let maximum = *buckets[index].iter().max().unwrap();
        let layers = maximum.div_ceil(PAYLOAD_BYTES);
        assert!(layers > 0 && layers <= MAX_LAYERS);
        json!({"codec":codec,"encodedRecordBytes":sums[index],"maximumBucketBytes":maximum,"layerCount":layers,
            "databaseBytes":layers as u64 * ROWS as u64 * ROW_BYTES as u64,"publicBytes":layers * profile.scheme.public_bytes,
            "replyBytes":layers * profile.scheme.response_bytes,"requestBytes":profile.scheme.request_bytes,
            "preparedPlannedBytes":layers as u64 * (2*PREPARED_HEADER_BYTES + profile.blocks() as u64*profile.native.prepared_block_planned_bytes()),
            "encodeAndRoundtripMicros":elapsed[index]})
    }).collect::<Vec<_>>();
    let report = json!({"schema":"zecblock-global-codec-comparison-v1","scope":"Local record encoding and full canonical/wire-identity roundtrip; no PIR matrix preprocessing, service or release acceptance",
        "runUnixMillis":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
        "platform":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH},
        "protocolSourceSha256":digest(include_bytes!("global.rs")),"codecSourceSha256":digest(include_bytes!("global_codec.rs")),
        "comparisonSourceSha256":digest(include_bytes!("global_codec_tests.rs")),
        "sourceSha256":digest(&source_bytes),"sourceBytes":source_bytes.len(),"recordCount":records.len(),"buildProfile":if cfg!(debug_assertions){"debug"}else{"release"},
        "records":rows,"codecs":summaries});
    let report_path = std::env::var("GLOBAL_CODEC_REPORT_PATH").unwrap_or_else(|_| {
        std::path::Path::new(&source_path)
            .with_file_name("compact-codec-comparison.json")
            .to_string_lossy()
            .into_owned()
    });
    std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    println!("reportPath={report_path}");
}
