use super::*;

fn fixture() -> (Value, Value, String) {
    let originals: Vec<Value> = serde_json::from_str(include_str!(
        "../../../server/tests/fixtures/browser-transactions.json"
    ))
    .unwrap();
    let source = &originals[0];
    let txid = source["txid"].as_str().unwrap().to_owned();
    let snapshot =
        json!({"height":500_000,"hash":"11".repeat(32),"publishedAt":"2026-11-02T00:00:00Z"});
    let coverage = json!({"startHeight":419_200,"endHeight":419_200,"blocks":[{"height":419_200,"hash":"22".repeat(32)}]});
    let manifest = json!({"schema":SCHEMA,"geometry":GEOMETRY,"table":TABLE,"rows":ROWS,"rowBytes":ROW_BYTES,"payloadBytes":PAYLOAD_BYTES,"chunkCount":1,"network":"mainnet","snapshot":snapshot,"coverage":coverage,"catalogue":[],"packing":"compact-v1","coverRow":2047,"recordCodec":RECORD_CODEC});
    let envelope = json!({"schema":RECORD_SCHEMA,"network":"mainnet","snapshot":snapshot,"coverage":coverage,"txid":txid,
        "detail":{"txid":txid,"status":"confirmed","isCanonical":true,"blockHeight":419_200,"blockHash":"22".repeat(32),"inputs":[],"outputs":[],"feeZat":"0","valueBalanceSaplingZat":null},
        "raw":{"txid":txid,"hex":source["hex"],"decoded":{"txid":txid,"hex":source["hex"],"padding":"x".repeat(12_000)}},
        "source":{"authority":"codec unit fixture"},"price":{"available":false}});
    (envelope, manifest, txid)
}
fn stored_json(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut stored = STORED_MAGIC.to_vec();
    stored.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    stored.push(flags);
    stored.extend([0; 3]);
    stored.extend(miniz_oxide::deflate::compress_to_vec_zlib(payload, 6));
    stored
}
#[test]
fn compressed_codec_restores_full_result_and_duplicate_hex_presence_exactly() {
    let (original, manifest, txid) = fixture();
    for mode in 0..3 {
        let mut envelope = original.clone();
        if mode == 1 {
            envelope["raw"]["decoded"]
                .as_object_mut()
                .unwrap()
                .remove("hex");
        }
        if mode == 2 {
            envelope["raw"]["decoded"]["hex"] = json!("different metadata retained verbatim");
        }
        let stored = encode_record_for_storage(&envelope).unwrap();
        assert!(stored.len() < serde_json::to_vec(&envelope).unwrap().len() / 2);
        assert_eq!(stored[12], u8::from(mode == 0));
        assert_eq!(
            decode_record_from_storage(&stored, &manifest, &txid).unwrap(),
            envelope
        );
    }
}
#[test]
fn legacy_codec_and_identity_remain_unchanged_and_new_codec_is_bound() {
    let (envelope, mut manifest, txid) = fixture();
    manifest.as_object_mut().unwrap().remove("recordCodec");
    let legacy_id = publication_id(&manifest).unwrap();
    let bytes = serde_json::to_vec(&envelope).unwrap();
    assert_eq!(
        decode_record_from_storage(&bytes, &manifest, &txid).unwrap(),
        envelope
    );
    manifest["recordCodec"] = json!(RECORD_CODEC);
    assert_ne!(publication_id(&manifest).unwrap(), legacy_id);
    manifest["recordCodec"] = json!("unknown");
    assert!(publication_id(&manifest).is_err());
}
#[test]
fn compressed_header_stream_checksum_truncation_and_trailing_bytes_fail_closed() {
    let (envelope, manifest, txid) = fixture();
    let good = encode_record_for_storage(&envelope).unwrap();
    let mut cases = Vec::new();
    for (offset, byte) in [(0, b'X'), (12, 2), (13, 1)] {
        let mut bad = good.clone();
        bad[offset] = byte;
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
    let mut bad = good.clone();
    *bad.last_mut().unwrap() ^= 1;
    cases.push(bad);
    cases.push(good[..good.len() - 1].to_vec());
    let mut trailing = good.clone();
    trailing.push(0);
    cases.push(trailing);
    let mut concatenated = good.clone();
    concatenated.extend_from_slice(&good[STORED_HEADER..]);
    cases.push(concatenated);
    for bad in cases {
        assert!(decode_record_from_storage(&bad, &manifest, &txid).is_err());
    }
}
#[test]
fn compressed_reserved_context_noncanonical_json_and_expansion_bounds_are_rejected() {
    let (envelope, manifest, txid) = fixture();
    let mut payload = envelope.clone();
    for name in ["schema", "network", "snapshot", "coverage"] {
        payload.as_object_mut().unwrap().remove(name);
    }
    payload["network"] = json!("injected");
    let bytes = stored_json(&serde_json::to_vec(&payload).unwrap(), 0);
    assert!(
        decode_record_from_storage(&bytes, &manifest, &txid)
            .unwrap_err()
            .contains("reserved shared context")
    );
    payload.as_object_mut().unwrap().remove("network");
    let mut noncanonical = b" ".to_vec();
    noncanonical.extend(serde_json::to_vec(&payload).unwrap());
    assert!(
        decode_record_from_storage(&stored_json(&noncanonical, 0), &manifest, &txid)
            .unwrap_err()
            .contains("Noncanonical")
    );
    // A valid compressed stream that expands beyond its declared allocation.
    let mut expansion = stored_json(&vec![b'x'; 1_000_000], 0);
    expansion[8..12].copy_from_slice(&32_u32.to_le_bytes());
    assert!(
        decode_record_from_storage(&expansion, &manifest, &txid)
            .unwrap_err()
            .contains("oversized")
    );
    let mut huge = envelope;
    huge["detail"]["tooLarge"] = json!("x".repeat(MAX_DECODED_RECORD_BYTES));
    assert!(encode_record_for_storage(&huge).is_err());
}
#[test]
fn compressed_context_comes_only_from_manifest_and_raw_binding_is_retained() {
    let (envelope, manifest, txid) = fixture();
    let stored = encode_record_for_storage(&envelope).unwrap();
    assert!(decode_record_from_storage(&stored, &manifest, &"f".repeat(64)).is_err());
    let mut wrong = manifest.clone();
    wrong["network"] = json!("testnet");
    assert!(decode_record_from_storage(&stored, &wrong, &txid).is_err());
    let mut wrong = manifest;
    wrong["coverage"]["startHeight"] = json!(419_201);
    assert!(decode_record_from_storage(&stored, &wrong, &txid).is_err());
}

#[test]
fn encoded_budget_rejects_incompressible_records_even_below_decoded_limit() {
    let (mut envelope, _, _) = fixture();
    let text = (0_u32..20_000)
        .map(|n| hex::encode(Sha256::digest(n.to_le_bytes())))
        .collect::<String>();
    envelope["detail"]["capacity_fixture"] = json!(text);
    assert!(
        encode_record_for_storage(&envelope)
            .unwrap_err()
            .contains("chunk budget")
    );
}
