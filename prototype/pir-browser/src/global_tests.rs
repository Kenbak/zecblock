use super::*;
use serde_json::json;

fn fixture() -> (Value, String) {
    let originals: Vec<Value> = serde_json::from_str(include_str!(
        "../../../server/tests/fixtures/browser-transactions.json"
    ))
    .unwrap();
    let source = &originals[0];
    let txid = source["txid"].as_str().unwrap().to_owned();
    let snapshot =
        json!({"height":500_000,"hash":"11".repeat(32),"publishedAt":"2026-11-02T00:00:00Z"});
    let coverage = json!({"startHeight":419_200,"endHeight":419_200,"blocks":[{"height":419_200,"hash":"22".repeat(32)}]});
    let envelope = json!({"schema":crate::full_record::RECORD_SCHEMA,"network":"mainnet","snapshot":snapshot,"coverage":coverage,"txid":txid,
        "detail":{"txid":txid,"status":"confirmed","isCanonical":true,"blockHeight":419_200,"blockHash":"22".repeat(32),"inputs":[],"outputs":[],"feeZat":"0","valueBalanceSaplingZat":null},
        "raw":{"txid":txid,"hex":source["hex"],"decoded":{"txid":txid,"hex":source["hex"]}},
        "source":{"authority":"global codec unit fixture; real transaction wire"},"price":{"available":false}});
    (envelope, txid)
}

fn stored_json(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut stored = RECORD_MAGIC.to_vec();
    stored.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    stored.push(flags);
    stored.extend([0; 3]);
    stored.extend(miniz_oxide::deflate::compress_to_vec_zlib(payload, 6));
    stored
}

fn manifest(roots: &[String]) -> Value {
    let profile = profile().unwrap();
    let layers = roots.iter().enumerate().map(|(index, root)| json!({
        "index":index,"merkleRoot":root,"databaseSha256":"33".repeat(32),"publicSha256":"44".repeat(32),
        "preparedFiles":(0..2).map(|part| json!({"file":format!("prepared-{part:02}.bin"),"count":16,
            "bytes":PREPARED_HEADER_BYTES + 16 * profile.native.prepared_block_planned_bytes(),"sha256":"55".repeat(32)})).collect::<Vec<_>>()
    })).collect::<Vec<_>>();
    let mut manifest = json!({"schema":SCHEMA,"geometry":GEOMETRY,"table":TABLE,"rows":ROWS,"rowBytes":ROW_BYTES,
        "payloadBytes":PAYLOAD_BYTES,"layerCount":roots.len(),"hashAlgorithm":HASH_ALGORITHM,"recordCodec":RECORD_CODEC,
        "network":"mainnet","sourceDigest":"66".repeat(32),"sourceSummary":{"recordCount":1},"scheme":profile.scheme,"layers":layers});
    manifest["contextId"] = json!(manifest_context_id(&manifest).unwrap());
    manifest["publicationId"] = json!(manifest_id(&manifest).unwrap());
    manifest
}

fn reidentify(manifest: &mut Value) {
    manifest["contextId"] = json!(manifest_context_id(manifest).unwrap());
    manifest["publicationId"] = json!(manifest_id(manifest).unwrap());
}

#[test]
fn global_profile_is_separate_and_preserves_pinned_crypto() {
    let profile = profile().unwrap();
    assert_eq!(profile.rows, ROWS);
    assert_eq!(profile.row_bytes, ROW_BYTES);
    assert_eq!(profile.scheme.request_bytes, 20_992);
    assert_eq!(profile.scheme.public_bytes, 360_448);
    assert_eq!(profile.scheme.response_bytes, 81_920);
    assert_eq!(profile.scheme.p_bits, 8);
    assert_eq!(profile.scheme.q_bits, 54);
    assert_eq!(profile.scheme.mask_bits, 22);
    assert_eq!(profile.scheme.query_bits, 28);
    assert_eq!(profile.scheme.response_bits, 10);
    assert_ne!(
        profile.scheme.query_mask_seed,
        crate::full_record::profile()
            .unwrap()
            .scheme
            .query_mask_seed
    );
    assert_eq!(
        crate::full_record::MAX_DECODED_RECORD_BYTES,
        8 * 1024 * 1024
    );
}

#[test]
fn key_row_hashes_decoded_display_bytes_and_rejects_bad_ids() {
    let txid = "0123456789abcdef".repeat(4);
    let mut input = b"ZBGL-KEY-v1\0".to_vec();
    input.extend(hex::decode(&txid).unwrap());
    let hash = Sha256::digest(input);
    assert_eq!(
        key_row(&txid).unwrap(),
        (u64::from_le_bytes(hash[..8].try_into().unwrap()) % ROWS as u64) as usize
    );
    assert_eq!(
        key_row(&txid).unwrap(),
        key_row(&txid.to_ascii_uppercase()).unwrap()
    );
    for invalid in ["".to_owned(), "0".repeat(63), "g".repeat(64)] {
        assert!(key_row(&invalid).is_err());
    }
}

#[test]
fn self_contained_codec_preserves_all_context_and_duplicate_hex_presence() {
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
            record["raw"]["decoded"]["hex"] = json!("distinct verbose metadata");
        }
        let stored = encode_record(&record).unwrap();
        assert_eq!(stored[12], u8::from(mode == 0));
        assert_eq!(decode_record(&stored, &txid).unwrap(), record);
    }
    let stored = encode_record(&original).unwrap();
    assert!(decode_record(&stored, &"ff".repeat(32)).is_err());
    for path in ["network", "schema", "found", "publicationId"] {
        let mut bad = original.clone();
        bad[path] = json!("injected");
        assert!(encode_record(&bad).is_err(), "field {path}");
    }
    let mut bad = original.clone();
    bad["detail"]["txid"] = json!("ff".repeat(32));
    assert!(encode_record(&bad).is_err());
    let mut bad = original.clone();
    bad["raw"]["hex"] = json!("010203");
    assert!(encode_record(&bad).is_err());
    let mut bad = original;
    bad["coverage"]["startHeight"] = json!(419_201);
    assert!(encode_record(&bad).is_err());
}

#[test]
fn real_wire_record_above_eight_mib_roundtrips_without_relaxing_legacy_limit() {
    let (mut record, txid) = fixture();
    // A real fixture's wire bytes and txid are retained. Verbose RPC metadata
    // exercises the new envelope limit independently of transaction wire size.
    record["raw"]["decoded"]["verboseFixture"] = json!("x".repeat(9 * 1024 * 1024));
    assert!(canonical(&record).unwrap().len() > crate::full_record::MAX_DECODED_RECORD_BYTES);
    assert!(crate::full_record::encode_record_for_storage(&record).is_err());
    let stored = encode_record(&record).unwrap();
    assert_eq!(decode_record(&stored, &txid).unwrap(), record);
}

#[test]
fn compressed_record_header_checksum_lengths_and_exact_consumption_are_enforced() {
    let (record, txid) = fixture();
    let good = encode_record(&record).unwrap();
    let mut cases = Vec::new();
    for offset in [0, 12, 13, good.len() - 1] {
        let mut bad = good.clone();
        bad[offset] ^= if offset == 12 { 2 } else { 1 };
        cases.push(bad);
    }
    for length in [
        0,
        MAX_DECODED_RECORD_BYTES as u32 + 1,
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
    let mut expansion = stored_json(&vec![b'x'; 100_000], 0);
    expansion[8..12].copy_from_slice(&32_u32.to_le_bytes());
    cases.push(expansion);
    for bad in cases {
        assert!(decode_record(&bad, &txid).is_err());
    }
    let mut noncanonical = b" ".to_vec();
    noncanonical.extend(canonical(&record).unwrap());
    assert!(
        decode_record(&stored_json(&noncanonical, 0), &txid)
            .unwrap_err()
            .contains("Noncanonical")
    );
    assert!(
        decode_record(&stored_json(&canonical(&record).unwrap(), 1), &txid)
            .unwrap_err()
            .contains("Conflicting")
    );
}

#[test]
fn full_restored_record_limit_is_enforced_before_compression_and_after_restoration() {
    let (mut record, txid) = fixture();
    record["detail"]["tooLarge"] = json!("x".repeat(MAX_DECODED_RECORD_BYTES));
    assert!(encode_record(&record).unwrap_err().contains("Restored"));
    let (mut payload, _) = fixture();
    payload["raw"]["decoded"]
        .as_object_mut()
        .unwrap()
        .remove("hex");
    // Construct a stored canonical payload which is just within the cap but
    // crosses it only when duplicate raw hex is restored.
    let base = canonical(&payload).unwrap().len();
    payload["detail"]["padding"] = json!("");
    let overhead = canonical(&payload).unwrap().len() - base;
    payload["detail"]["padding"] = json!("x".repeat(MAX_DECODED_RECORD_BYTES - base - overhead));
    let bytes = canonical(&payload).unwrap();
    assert_eq!(bytes.len(), MAX_DECODED_RECORD_BYTES);
    assert!(
        decode_record(&stored_json(&bytes, 1), &txid)
            .unwrap_err()
            .contains("Restored")
    );
}

#[test]
fn buckets_check_all_framing_sort_duplicates_and_selected_full_digest() {
    let (record, txid) = fixture();
    let entry = encode_entry(&record).unwrap();
    let bucket = encode_bucket_entries(&[entry]).unwrap();
    assert_eq!(decode_bucket(&bucket, &txid).unwrap(), Some(record.clone()));
    assert_eq!(decode_bucket(&[], &txid).unwrap(), None);
    assert_eq!(decode_bucket(&bucket, &"ff".repeat(32)).unwrap(), None);
    assert!(
        encode_bucket(&[record.clone(), record])
            .unwrap_err()
            .contains("Duplicate")
    );
    for offset in [0, 8, 12, 16 + 64, 16 + 68] {
        let mut bad = bucket.clone();
        bad[offset] ^= 1;
        assert!(decode_bucket(&bad, &txid).is_err(), "offset {offset}");
    }
    let mut bad = bucket.clone();
    bad[16 + 32] ^= 1;
    assert!(decode_bucket(&bad, &txid).unwrap_err().contains("digest"));
    let mut bad = bucket.clone();
    bad[16] ^= 1;
    let wrong = hex::encode(&bad[16..48]);
    assert!(decode_bucket(&bad, &wrong).is_err());
    let mut bad = bucket.clone();
    bad.push(0);
    assert!(
        decode_bucket(&bad, &"ff".repeat(32))
            .unwrap_err()
            .contains("Trailing")
    );
    // An unmatched valid first entry must not hide a malformed later entry.
    let mut bad = bucket.clone();
    bad[8..12].copy_from_slice(&2_u32.to_le_bytes());
    bad.extend_from_slice(&bucket[16..]);
    assert!(
        decode_bucket(&bad, &txid)
            .unwrap_err()
            .contains("duplicate")
    );
}

#[test]
fn global_manifest_is_strict_and_binds_context_roots_scheme_and_certificate() {
    let good = manifest(&["77".repeat(32)]);
    validate_manifest(&good).unwrap();
    for (key, value) in [
        ("rows", json!(4096)),
        ("layerCount", json!(0)),
        ("schema", json!("old")),
        ("network", json!("testnet")),
        ("catalogue", json!([])),
        ("recordCodec", json!(crate::full_record::RECORD_CODEC)),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        reidentify(&mut bad);
        assert!(validate_manifest(&bad).is_err(), "field {key}");
    }
    for key in ["contextId", "publicationId", "sourceDigest"] {
        let mut bad = good.clone();
        bad[key] = json!("A".repeat(64));
        assert!(validate_manifest(&bad).is_err());
    }
    let context = good["contextId"].clone();
    let mut cert = good.clone();
    cert["noiseCertificate"] = json!({"experimental":true});
    assert_eq!(
        manifest_context_id(&cert).unwrap(),
        context.as_str().unwrap()
    );
    assert_ne!(
        manifest_id(&cert).unwrap(),
        good["publicationId"].as_str().unwrap()
    );
    cert["publicationId"] = json!(manifest_id(&cert).unwrap());
    validate_manifest(&cert).unwrap();
    let mut changed = good.clone();
    changed["layers"][0]["merkleRoot"] = json!("88".repeat(32));
    assert_eq!(
        manifest_context_id(&changed).unwrap(),
        context.as_str().unwrap()
    );
    assert!(validate_manifest(&changed).is_err());
    for change in 0..8 {
        let mut bad = good.clone();
        match change {
            0 => bad["layers"][0]["preparedFiles"][0]["file"] = json!("../secret"),
            1 => bad["layers"][0]["preparedFiles"][0]["count"] = json!(17),
            2 => bad["layers"][0]["preparedFiles"][0]["bytes"] = json!(1),
            3 => bad["layers"][0]["index"] = json!(1),
            4 => bad["scheme"]["query_bits"] = json!(27),
            5 => bad["scheme"]["extra"] = json!(0),
            6 => bad["sourceSummary"]["catalogue"] = json!([]),
            _ => bad["sourceSummary"]["verbose"] = json!("x".repeat(MAX_SOURCE_SUMMARY_BYTES)),
        }
        reidentify(&mut bad);
        assert!(validate_manifest(&bad).is_err(), "change {change}");
    }
}

#[test]
fn actual_geometry_merkle_rows_bind_empty_payloads_identity_padding_and_witnesses() {
    let mut buckets = (0..ROWS).map(|_| Vec::new()).collect::<Vec<_>>();
    buckets[17] = b"abc".to_vec();
    let context = "99".repeat(32);
    // Layer 1 carries empty padding even for a nonempty bucket whose contents
    // already fit in layer 0. Its full bucket hash/length still remain bound.
    let (database, root) = build_layer(&context, 1, 2, &buckets).unwrap();
    assert_eq!(database.len(), 128 * 1024 * 1024);
    let row = &database[17 * ROW_BYTES..18 * ROW_BYTES];
    let piece = verify_row(row, &context, 1, 2, 17, &root).unwrap();
    assert!(piece.payload.is_empty());
    assert_eq!(piece.bucket_bytes, 3);
    assert_eq!(piece.bucket_sha256, digest(b"abc"));
    let empty = &database[..ROW_BYTES];
    assert_eq!(
        verify_row(empty, &context, 1, 2, 0, &root)
            .unwrap()
            .bucket_sha256,
        digest(&[])
    );
    assert!(verify_row(row, &context, 1, 2, 16, &root).is_err());
    assert!(verify_row(row, &context, 0, 2, 17, &root).is_err());
    assert!(verify_row(row, &context, 1, 3, 17, &root).is_err());
    assert!(verify_row(row, &"aa".repeat(32), 1, 2, 17, &root).is_err());
    for offset in [
        0,
        8,
        40,
        44,
        48,
        52,
        56,
        88,
        96,
        128,
        479,
        480,
        512,
        ROW_BYTES - 1,
    ] {
        let mut bad = row.to_vec();
        bad[offset] ^= 1;
        assert!(
            verify_row(&bad, &context, 1, 2, 17, &root).is_err(),
            "offset {offset}"
        );
    }
    let mut bad = empty.to_vec();
    bad[56] ^= 1;
    assert!(verify_row(&bad, &context, 1, 2, 0, &root).is_err());
}

#[test]
fn assemble_authenticates_matching_and_absent_rows_before_membership() {
    let (record, txid) = fixture();
    let mut metadata = manifest(&["00".repeat(32)]);
    let context = metadata["contextId"].as_str().unwrap().to_owned();
    let mut buckets = (0..ROWS).map(|_| Vec::new()).collect::<Vec<_>>();
    buckets[key_row(&txid).unwrap()] = encode_bucket(std::slice::from_ref(&record)).unwrap();
    let (database, root) = build_layer(&context, 0, 1, &buckets).unwrap();
    metadata["layers"][0]["merkleRoot"] = json!(root);
    metadata["publicationId"] = json!(manifest_id(&metadata).unwrap());
    let selected = key_row(&txid).unwrap();
    let selected_row = database[selected * ROW_BYTES..(selected + 1) * ROW_BYTES].to_vec();
    assert_eq!(
        assemble_bucket(std::slice::from_ref(&selected_row), &metadata, &txid).unwrap(),
        Some(record)
    );
    let absent = (0..1000)
        .map(|n| format!("{n:064x}"))
        .find(|id| key_row(id).unwrap() != selected)
        .unwrap();
    let absent_index = key_row(&absent).unwrap();
    let mut absent_row =
        database[absent_index * ROW_BYTES..(absent_index + 1) * ROW_BYTES].to_vec();
    assert_eq!(
        assemble_bucket(std::slice::from_ref(&absent_row), &metadata, &absent).unwrap(),
        None
    );
    absent_row[128] ^= 1;
    assert!(assemble_bucket(&[absent_row], &metadata, &absent).is_err());
    assert!(assemble_bucket(std::slice::from_ref(&selected_row), &metadata, &absent).is_err());
    assert!(assemble_bucket(&[], &metadata, &txid).is_err());

    // A row can have a valid Merkle proof yet promise the wrong whole-bucket
    // checksum. Recompute only its root from the existing witnesses to ensure
    // assembly independently enforces that checksum after row authentication.
    let mut wrong_digest = selected_row;
    wrong_digest[56] ^= 1;
    let mut hash = leaf(&wrong_digest);
    for depth in 0..MERKLE_DEPTH {
        let sibling = wrong_digest[128 + depth * 32..160 + depth * 32]
            .try_into()
            .unwrap();
        hash = if selected >> depth & 1 == 0 {
            node(&hash, &sibling)
        } else {
            node(&sibling, &hash)
        };
    }
    metadata["layers"][0]["merkleRoot"] = json!(hex::encode(hash));
    metadata["publicationId"] = json!(manifest_id(&metadata).unwrap());
    assert!(
        assemble_bucket(&[wrong_digest], &metadata, &txid)
            .unwrap_err()
            .contains("checksum")
    );
}
