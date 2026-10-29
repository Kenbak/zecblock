use super::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::OnceLock};
use zakura_pir_query_server::{
    native::ProfileQueryExt as _, transparent::native::TableQueryExt as _,
};
use zakura_pir_server_core::native::{
    NativePreprocessed, ProfilePublicationExt as _, hint, preprocess,
};

struct Evaluator {
    profile: TableProfile,
    database: Vec<u8>,
    blocks: Vec<NativePreprocessed>,
    public: Vec<u8>,
}
impl Evaluator {
    fn new(database: Vec<u8>) -> Self {
        let profile = full_record::profile().unwrap();
        let mut columns = vec![0u8; database.len()];
        for row in 0..profile.rows {
            for col in 0..profile.cols {
                columns[col * profile.rows + row] = database[row * profile.row_bytes + col];
            }
        }
        let h = hint(&profile.masks, profile.rows, profile.cols, |col| {
            &columns[col * profile.rows..(col + 1) * profile.rows]
        })
        .unwrap();
        let blocks = preprocess(&profile.setup, &h).unwrap();
        let public = profile.native.publish(&blocks).unwrap();
        Self {
            profile,
            database,
            blocks,
            public,
        }
    }
    fn answer(&self, upload: &[u8]) -> Vec<u8> {
        let (keys, query) = self.profile.parse(upload).unwrap();
        let scan: Vec<_> = (0..self.profile.cols)
            .map(|col| {
                query
                    .iter()
                    .enumerate()
                    .fold(0u64, |sum, (row, &coefficient)| {
                        sum.wrapping_add(
                            u64::from(self.database[row * self.profile.row_bytes + col])
                                .wrapping_mul(coefficient),
                        )
                    })
                    & (zakura_pir_protocol::native::Q - 1)
            })
            .collect();
        self.profile
            .native
            .pack(&self.blocks, &keys, &scan)
            .unwrap()
    }
}
struct Fixture {
    manifest: Value,
    evaluator: Evaluator,
    records: BTreeMap<String, Value>,
}
impl Fixture {
    fn client(&self) -> FullPirBrowser {
        FullPirBrowser::new(&self.manifest.to_string(), &self.evaluator.public).unwrap()
    }
    fn expected(&self, txid: &str) -> Value {
        serde_json::from_str(
            &full_record::result_envelope(
                self.records[txid].clone(),
                self.manifest["publicationId"].as_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn poisoned(&self, txid: &str, ordinal: usize) -> Self {
        let entry = self.manifest["catalogue"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["txid"] == txid)
            .unwrap();
        let row = entry["rows"][ordinal].as_u64().unwrap() as usize;
        self.poisoned_row(row)
    }
    fn poisoned_row(&self, row: usize) -> Self {
        let mut db = self.evaluator.database.clone();
        db[row * full_record::ROW_BYTES] ^= 1;
        let evaluator = Evaluator::new(db);
        let mut manifest = self.manifest.clone();
        manifest["publicSha256"] = json!(hex::encode(Sha256::digest(&evaluator.public)));
        manifest["databaseSha256"] = json!(hex::encode(Sha256::digest(&evaluator.database)));
        assert_eq!(
            manifest["publicationId"],
            full_record::publication_id(&manifest).unwrap()
        );
        Self {
            manifest,
            evaluator,
            records: self.records.clone(),
        }
    }
}
fn fixture() -> &'static Fixture {
    static DATA: OnceLock<Fixture> = OnceLock::new();
    DATA.get_or_init(|| {
        let original: Vec<Value> = serde_json::from_str(include_str!("../../../server/tests/fixtures/browser-transactions.json")).unwrap();
        let sources: Vec<_> = original.iter().filter(|v| v["network"] == "mainnet" && v["key"].as_str().unwrap().ends_with(":transparent")).take(2).collect();
        let heights: Vec<_> = sources.iter().map(|v| v["height"].as_u64().unwrap()).collect();
        let block_hash = "42".repeat(32);
        let snapshot = json!({"height": heights.iter().max().unwrap(), "hash": block_hash, "publishedAt": "2026-10-29T00:00:00Z"});
        let coverage = json!({"startHeight": heights.iter().min().unwrap(), "endHeight": heights.iter().max().unwrap()});
        let mut records = BTreeMap::new();
        for source in sources {
            let record = json!({
                "schema": full_record::RECORD_SCHEMA, "network": "mainnet", "snapshot": snapshot, "coverage": coverage,
                "txid": source["txid"],
                "detail": {"txid":source["txid"],"status":"confirmed","isCanonical":true,"blockHeight":source["height"],"blockHash":block_hash,"inputs":[],"outputs":[],"feeZat":"0"},
                "raw": {"hex":source["hex"],"decoded":{"txid":source["txid"],"synthetic_test_padding":"x".repeat(full_record::PAYLOAD_BYTES * 2)}},
            });
            records.insert(source["txid"].as_str().unwrap().to_string(), record);
        }
        let count = records.values().map(|record| serde_json::to_vec(record).unwrap().len().div_ceil(full_record::PAYLOAD_BYTES)).max().unwrap();
        assert!(count >= 3);
        let catalogue: Vec<_> = records.iter().enumerate().map(|(index,(txid,record))| {
            let bytes = serde_json::to_vec(record).unwrap();
            json!({"txid":txid,"rows":(index*count..(index+1)*count).collect::<Vec<_>>(),"recordBytes":bytes.len(),"recordSha256":hex::encode(Sha256::digest(bytes))})
        }).collect();
        let mut manifest = json!({"schema":full_record::SCHEMA,"geometry":full_record::GEOMETRY,"table":full_record::TABLE,"rows":full_record::ROWS,"rowBytes":full_record::ROW_BYTES,"payloadBytes":full_record::PAYLOAD_BYTES,"chunkCount":count,"network":"mainnet","snapshot":snapshot,"coverage":coverage,"catalogue":catalogue});
        let id = full_record::publication_id(&manifest).unwrap();
        manifest["publicationId"] = json!(id);
        let mut database = vec![0;full_record::ROWS*full_record::ROW_BYTES];
        for entry in manifest["catalogue"].as_array().unwrap() {
            let txid=entry["txid"].as_str().unwrap();let body=serde_json::to_vec(&records[txid]).unwrap();
            for index in 0..count {
                let context=full_record::ChunkContext {publication_id:&id,txid,index,count,record_bytes:body.len(),record_sha256:entry["recordSha256"].as_str().unwrap()};
                let start=(index*full_record::PAYLOAD_BYTES).min(body.len());let end=(start+full_record::PAYLOAD_BYTES).min(body.len());
                let row=entry["rows"][index].as_u64().unwrap() as usize;
                database[row*full_record::ROW_BYTES..(row+1)*full_record::ROW_BYTES].copy_from_slice(&full_record::encode_chunk(&context,&body[start..end]).unwrap());
            }
        }
        let evaluator=Evaluator::new(database);
        manifest["scheme"]=serde_json::to_value(&evaluator.profile.scheme).unwrap();
        manifest["publicSha256"]=json!(hex::encode(Sha256::digest(&evaluator.public)));
        Fixture {manifest,evaluator,records}
    })
}
fn prepare_batch(client: &mut FullPirBrowser, txid: &str) -> Vec<Vec<u8>> {
    let count = client.begin_lookup(txid).unwrap() as usize;
    (0..count)
        .map(|index| client.generate_chunk_query(index).unwrap())
        .collect()
}
#[test]
fn staged_batch_matches_full_record_and_releases_only_the_last_reply() {
    let f = fixture();
    let txid = f.records.keys().next().unwrap();
    let mut client = f.client();
    let queries = prepare_batch(&mut client, txid);
    let state = client.lookup.as_ref().unwrap();
    assert_eq!(state.next_query, queries.len());
    assert!(state.secrets.iter().all(Option::is_some));
    let responses: Vec<_> = queries
        .iter()
        .map(|query| f.evaluator.answer(query))
        .collect();
    let mut result = None;
    for (index, response) in responses.iter().enumerate() {
        let next = client.decode_batch_response(response).unwrap();
        if index + 1 < responses.len() {
            assert!(next.is_none());
        } else {
            result = next;
        }
    }
    assert_eq!(
        serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
        f.expected(txid)
    );
    assert!(client.lookup.is_none());
}
#[test]
fn premature_decode_duplicate_generation_and_cancel_discard_pending_state() {
    let f = fixture();
    let txid = f.records.keys().next().unwrap();
    let mut client = f.client();
    client.begin_lookup(txid).unwrap();
    let query = client.generate_chunk_query(0).unwrap();
    let response = f.evaluator.answer(&query);
    assert!(
        client
            .decode_batch_response(&response)
            .unwrap_err()
            .contains("complete fixed query batch")
    );
    assert!(client.lookup.is_none());
    client.begin_lookup(txid).unwrap();
    client.generate_chunk_query(0).unwrap();
    assert!(client.generate_chunk_query(0).is_err());
    assert!(client.lookup.is_none());
    client.begin_lookup(txid).unwrap();
    client.generate_chunk_query(0).unwrap();
    client.cancel_query();
    assert!(client.lookup.is_none());
    assert!(client.generate_chunk_query(0).is_err());
    assert!(client.decode_batch_response(&response).is_err());
}
#[test]
fn selectively_poisoned_first_middle_and_last_replies_cannot_gate_query_generation() {
    let clean = fixture();
    let mut ids = clean.records.keys();
    let affected = ids.next().unwrap();
    let unaffected = ids.next().unwrap();
    let count = clean.manifest["chunkCount"].as_u64().unwrap() as usize;
    for ordinal in [0, count / 2, count - 1] {
        let poisoned = clean.poisoned(affected, ordinal);
        let mut client = poisoned.client();
        let queries = prepare_batch(&mut client, affected);
        assert_eq!(queries.len(), count);
        let responses: Vec<_> = queries
            .iter()
            .map(|q| poisoned.evaluator.answer(q))
            .collect();
        let mut rejected = false;
        for (index, response) in responses.iter().enumerate() {
            let result = client.decode_batch_response(response);
            if index < ordinal {
                assert!(result.unwrap().is_none());
            } else {
                assert!(result.is_err());
                rejected = true;
                break;
            }
        }
        assert!(rejected);
        assert!(client.lookup.is_none());
        let queries = prepare_batch(&mut client, unaffected);
        let responses: Vec<_> = queries
            .iter()
            .map(|q| poisoned.evaluator.answer(q))
            .collect();
        let mut decoded = None;
        for response in responses {
            decoded = client.decode_batch_response(&response).unwrap();
        }
        assert_eq!(
            serde_json::from_str::<Value>(&decoded.unwrap()).unwrap(),
            clean.expected(unaffected)
        );
    }
}
#[test]
fn invalid_reply_order_and_malformed_reply_clear_all_retained_keys() {
    let f = fixture();
    let txid = f.records.keys().next().unwrap();
    let mut client = f.client();
    let queries = prepare_batch(&mut client, txid);
    let wrong = f.evaluator.answer(&queries[1]);
    assert!(client.decode_batch_response(&wrong).is_err());
    assert!(client.lookup.is_none());
    let _ = prepare_batch(&mut client, txid);
    assert!(client.decode_batch_response(&[0; 3]).is_err());
    assert!(client.lookup.is_none());
}
#[test]
fn batch_limit_bounds_coefficient_and_transport_payload_allocations() {
    assert_eq!(batch_chunk_count(&json!(MAX_BATCH_CHUNKS)).unwrap(), 64);
    for invalid in [json!(0), json!(65), json!(2048), json!(-1), Value::Null] {
        assert!(batch_chunk_count(&invalid).is_err());
    }
    let p = full_record::profile().unwrap();
    assert_eq!(
        MAX_BATCH_CHUNKS * zakura_pir_protocol::native::D * std::mem::size_of::<u64>(),
        1_048_576
    );
    assert_eq!(MAX_BATCH_CHUNKS * p.scheme.request_bytes, 1_343_488);
    assert_eq!(MAX_BATCH_CHUNKS * p.scheme.response_bytes, 655_360);
    assert_eq!(MAX_BATCH_CHUNKS * full_record::PAYLOAD_BYTES, 516_096);
}

fn compact_fixture() -> &'static Fixture {
    static DATA: OnceLock<Fixture> = OnceLock::new();
    DATA.get_or_init(|| {
        let legacy = fixture();
        let mut records = legacy.records.clone();
        records.values_mut().next().unwrap()["raw"]["decoded"]
            .as_object_mut().unwrap().remove("synthetic_test_padding");
        let count = records.values().map(|r| serde_json::to_vec(r).unwrap().len().div_ceil(full_record::PAYLOAD_BYTES)).max().unwrap();
        let mut next_row = 0;
        let catalogue: Vec<_> = records.iter().map(|(txid, record)| {
            let body = serde_json::to_vec(record).unwrap();
            let actual = body.len().div_ceil(full_record::PAYLOAD_BYTES);
            let rows: Vec<_> = (next_row..next_row + actual).collect();
            next_row += actual;
            json!({"txid":txid,"rows":rows,"recordBytes":body.len(),"recordSha256":hex::encode(Sha256::digest(body))})
        }).collect();
        let mut manifest = legacy.manifest.clone();
        manifest["packing"] = json!("compact-v1");
        manifest["coverRow"] = json!(full_record::ROWS - 1);
        manifest["chunkCount"] = json!(count);
        manifest["catalogue"] = json!(catalogue);
        let id = full_record::publication_id(&manifest).unwrap();
        manifest["publicationId"] = json!(id);
        let mut database = vec![0; full_record::ROWS * full_record::ROW_BYTES];
        for entry in manifest["catalogue"].as_array().unwrap() {
            let txid=entry["txid"].as_str().unwrap();
            let body=serde_json::to_vec(&records[txid]).unwrap();
            let actual=entry["rows"].as_array().unwrap().len();
            for index in 0..actual {
                let context=full_record::ChunkContext {publication_id:&id,txid,index,count:actual,record_bytes:body.len(),record_sha256:entry["recordSha256"].as_str().unwrap()};
                let start=index*full_record::PAYLOAD_BYTES;
                let end=(start+full_record::PAYLOAD_BYTES).min(body.len());
                let row=entry["rows"][index].as_u64().unwrap() as usize;
                database[row*full_record::ROW_BYTES..(row+1)*full_record::ROW_BYTES].copy_from_slice(&full_record::encode_chunk(&context,&body[start..end]).unwrap());
            }
        }
        let evaluator=Evaluator::new(database);
        manifest["publicSha256"]=json!(hex::encode(Sha256::digest(&evaluator.public)));
        manifest["databaseSha256"]=json!(hex::encode(Sha256::digest(&evaluator.database)));
        Fixture { manifest,evaluator,records }
    })
}

#[test]
fn compact_different_record_sizes_keep_global_schedule_and_roundtrip() {
    let f = compact_fixture();
    let count = f.manifest["chunkCount"].as_u64().unwrap() as usize;
    let lengths: Vec<_> = f.manifest["catalogue"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["rows"].as_array().unwrap().len())
        .collect();
    assert!(lengths.iter().min().unwrap() < lengths.iter().max().unwrap());
    for txid in f.records.keys() {
        let mut client = f.client();
        let queries = prepare_batch(&mut client, txid);
        assert_eq!(queries.len(), count);
        assert!(
            queries
                .iter()
                .all(|q| q.len() == f.evaluator.profile.scheme.request_bytes)
        );
        let replies: Vec<_> = queries.iter().map(|q| f.evaluator.answer(q)).collect();
        let mut decoded = None;
        for (index, reply) in replies.iter().enumerate() {
            decoded = client.decode_batch_response(reply).unwrap();
            if index + 1 < count {
                assert!(decoded.is_none());
            }
        }
        assert_eq!(
            serde_json::from_str::<Value>(&decoded.unwrap()).unwrap(),
            f.expected(txid)
        );
    }
}

#[test]
fn compact_actual_and_cover_corruption_cannot_change_generated_request_schedule() {
    let clean = compact_fixture();
    let short = clean.records.keys().next().unwrap();
    let long = clean.records.keys().nth(1).unwrap();
    let count = clean.manifest["chunkCount"].as_u64().unwrap() as usize;
    let actual_row = clean.manifest["catalogue"][0]["rows"][0].as_u64().unwrap() as usize;
    for row in [actual_row, full_record::ROWS - 1] {
        let poisoned = clean.poisoned_row(row);
        let mut client = poisoned.client();
        let queries = prepare_batch(&mut client, short);
        assert_eq!(queries.len(), count);
        // Simulate collecting the full fixed transport schedule before decode.
        let replies: Vec<_> = queries
            .iter()
            .map(|q| poisoned.evaluator.answer(q))
            .collect();
        assert_eq!(replies.len(), count);
        let mut rejected = false;
        for reply in replies {
            match client.decode_batch_response(&reply) {
                Ok(None) => {}
                Ok(Some(_)) => panic!("Corrupt compact batch returned data"),
                Err(_) => {
                    rejected = true;
                    break;
                }
            }
        }
        assert!(rejected);
        assert!(client.lookup.is_none());
        // Long records do not select the shared cover, or the short record row.
        let queries = prepare_batch(&mut client, long);
        assert_eq!(queries.len(), count);
        let replies: Vec<_> = queries
            .iter()
            .map(|q| poisoned.evaluator.answer(q))
            .collect();
        let mut result = None;
        for reply in replies {
            result = client.decode_batch_response(&reply).unwrap();
        }
        assert_eq!(
            serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
            clean.expected(long)
        );
    }
}

#[test]
fn compact_layout_and_optional_identity_are_strict_without_changing_legacy_hashes() {
    let legacy = &fixture().manifest;
    let original = full_record::publication_identity(legacy).unwrap();
    assert!(original.get("packing").is_none());
    assert!(original.get("coverRow").is_none());
    assert_eq!(
        hex::encode(Sha256::digest(serde_json::to_vec(&original).unwrap())),
        legacy["publicationId"]
    );
    let compact = &compact_fixture().manifest;
    assert_eq!(full_record::packing_cover_row(compact).unwrap(), Some(2047));
    assert_eq!(
        full_record::publication_identity(compact).unwrap()["packing"],
        "compact-v1"
    );
    let count = compact["chunkCount"].as_u64().unwrap() as usize;
    for mutate in [0, 1, 2, 3, 4] {
        let mut invalid = compact.clone();
        match mutate {
            0 => invalid["catalogue"][0]["rows"] = json!([2047]),
            1 => invalid["catalogue"][0]["rows"] = json!([]),
            2 => invalid["catalogue"][0]["rows"] = invalid["catalogue"][1]["rows"].clone(),
            3 => {
                invalid["catalogue"][0]["recordBytes"] =
                    json!(full_record::PAYLOAD_BYTES * count + 1)
            }
            _ => invalid["catalogue"][0]["recordSha256"] = json!("bad"),
        }
        assert!(validate_full_catalogue(&invalid, count, Some(2047)).is_err());
    }
    assert!(validate_full_catalogue(compact, count + 1, Some(2047)).is_err());
    for (packing, cover) in [
        (json!("future"), json!(2047)),
        (json!("compact-v1"), json!(0)),
        (Value::Null, json!(2047)),
    ] {
        let mut invalid = compact.clone();
        invalid["packing"] = packing;
        invalid["coverRow"] = cover;
        assert!(full_record::publication_identity(&invalid).is_err());
    }
    let mut invalid = legacy.clone();
    invalid["coverRow"] = json!(2047);
    assert!(full_record::publication_identity(&invalid).is_err());
}
