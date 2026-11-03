//! One opaque selection reused across every layer of a global publication.
use crate::{full_record, global_data, js_error};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zakura_pir_client::transparent::native::{NativeSecret, TableClientExt, TableProfile};

struct Pending {
    secret: NativeSecret,
    txid: String,
    row: usize,
}

/// All public layer hints are loaded before a private transaction ID is entered.
/// One fresh secret and encrypted selection apply to the whole fixed schedule.
#[wasm_bindgen]
pub struct GlobalPirBrowser {
    manifest: Value,
    publication_id: String,
    profile: TableProfile,
    public: Vec<u8>,
    layers: usize,
    pending: Option<Pending>,
}

#[wasm_bindgen]
impl GlobalPirBrowser {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str, public_setups: &[u8]) -> Result<GlobalPirBrowser, JsValue> {
        Self::from_publication(manifest_json, public_setups).map_err(js_error)
    }

    /// Upload only this encrypted query, once, with the public epoch identity.
    /// The server evaluates these unchanged bytes against every public layer.
    pub fn make_query(&mut self, txid: &str) -> Result<Vec<u8>, JsValue> {
        self.prepare_query(txid).map_err(js_error)
    }

    /// Accept the complete fixed response bundle before decrypting anything.
    /// All layer rows, including empty rows, authenticate before bucket lookup.
    /// Any decode attempt consumes the pending secret, including malformed input.
    pub fn decode_response(&mut self, bundle: &[u8]) -> Result<String, JsValue> {
        self.decode_bundle(bundle).map_err(js_error)
    }

    /// Discard the pending selection. This does not claim device memory erasure.
    pub fn cancel_query(&mut self) {
        self.pending = None;
    }

    #[wasm_bindgen(getter)]
    pub fn publication_id(&self) -> String {
        self.publication_id.clone()
    }
}

impl GlobalPirBrowser {
    fn from_publication(manifest_json: &str, public_setups: &[u8]) -> Result<Self, String> {
        if manifest_json.len() > global_data::MAX_MANIFEST_BYTES {
            return Err("Global manifest exceeds its bound".into());
        }
        let manifest: Value = serde_json::from_str(manifest_json).map_err(|e| e.to_string())?;
        // This derives the allowed profile locally and validates the publication
        // identity. No masks, seeds, or cryptographic parameters come from input.
        let profile = global_data::validate_manifest(&manifest)?;
        let layers = manifest["layerCount"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|&n| n > 0 && n <= global_data::MAX_LAYERS)
            .ok_or("Invalid global publication layer count")?;
        let expected = profile
            .scheme
            .public_bytes
            .checked_mul(layers)
            .ok_or("Global public setup length overflow")?;
        if public_setups.len() != expected {
            return Err("Global public setup bundle has the wrong length".into());
        }
        for (index, setup) in public_setups
            .chunks_exact(profile.scheme.public_bytes)
            .enumerate()
        {
            if manifest["layers"][index]["publicSha256"] != hex::encode(Sha256::digest(setup)) {
                return Err("Global public setup does not match its layer commitment".into());
            }
        }
        let publication_id = manifest["publicationId"]
            .as_str()
            .ok_or("Missing global publication identity")?
            .to_owned();
        Ok(Self {
            manifest,
            publication_id,
            profile,
            public: public_setups.to_vec(),
            layers,
            pending: None,
        })
    }

    fn prepare_query(&mut self, txid: &str) -> Result<Vec<u8>, String> {
        if self.pending.is_some() {
            return Err("Finish or cancel the pending global private query first".into());
        }
        let row = global_data::key_row(txid)?;
        let (secret, query) = self.profile.prepare(row)?;
        self.pending = Some(Pending {
            secret,
            txid: txid.to_ascii_lowercase(),
            row,
        });
        Ok(query)
    }

    fn decode_bundle(&mut self, bundle: &[u8]) -> Result<String, String> {
        let pending = self
            .pending
            .take()
            .ok_or("No pending global private query")?;
        self.decode_complete_bundle(pending, bundle, |secret, public, response| {
            self.profile.decode(secret, public, response)
        })
    }

    fn decode_complete_bundle(
        &self,
        pending: Pending,
        bundle: &[u8],
        mut decode: impl FnMut(&NativeSecret, &[u8], &[u8]) -> Result<Vec<u8>, String>,
    ) -> Result<String, String> {
        let expected = self
            .profile
            .scheme
            .response_bytes
            .checked_mul(self.layers)
            .ok_or("Global response bundle length overflow")?;
        if bundle.len() != expected {
            return Err("Global response bundle has the wrong length".into());
        }
        let context = self.manifest["contextId"]
            .as_str()
            .ok_or("Missing global publication context")?;
        let mut rows = Vec::with_capacity(self.layers);
        let mut first_error = None;
        for (index, (response, public)) in bundle
            .chunks_exact(self.profile.scheme.response_bytes)
            .zip(self.public.chunks_exact(self.profile.scheme.public_bytes))
            .enumerate()
        {
            match decode(&pending.secret, public, response) {
                Ok(row) => {
                    let verified = self.manifest["layers"][index]["merkleRoot"]
                        .as_str()
                        .ok_or_else(|| "Missing global layer commitment".to_owned())
                        .and_then(|root| {
                            global_data::verify_row(
                                &row,
                                context,
                                index,
                                self.layers,
                                pending.row,
                                root,
                            )
                        });
                    if let Err(error) = verified {
                        first_error.get_or_insert(error);
                    }
                    rows.push(row);
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        // Do not let early decode/authentication failures skip later layer work.
        // Nothing is returned, matched, or decompressed until this loop finishes.
        if let Some(error) = first_error {
            return Err(error);
        }
        match global_data::assemble_bucket(&rows, &self.manifest, &pending.txid)? {
            Some(record) => full_record::result_envelope(record, &self.publication_id),
            None => serde_json::to_string(&json!({
                "found": false,
                "publicationId": self.publication_id,
            }))
            .map_err(|e| e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, sync::OnceLock};
    use zakura_pir_query_server::{
        native::ProfileQueryExt as _, transparent::native::TableQueryExt as _,
    };
    use zakura_pir_server_core::native::{
        NativePreprocessed, ProfilePublicationExt as _, hint, preprocess,
    };

    struct Fixture {
        manifest: Value,
        public: Vec<u8>,
        record: Value,
        selected_rows: Vec<Vec<u8>>,
        empty_rows: Vec<Vec<u8>>,
        colliding_absent: String,
        empty_absent: String,
    }

    impl Fixture {
        fn client(&self) -> GlobalPirBrowser {
            GlobalPirBrowser::from_publication(&self.manifest.to_string(), &self.public).unwrap()
        }

        fn decode_rows(
            &self,
            txid: &str,
            rows: &[Vec<u8>],
        ) -> (Result<String, String>, usize, usize) {
            let mut client = self.client();
            let query = client.prepare_query(txid).unwrap();
            let pending = client.pending.take().unwrap();
            let bundle = vec![0; client.layers * client.profile.scheme.response_bytes];
            let count = Cell::new(0);
            let result = client.decode_complete_bundle(pending, &bundle, |_, _, _| {
                let index = count.get();
                count.set(index + 1);
                Ok(rows[index].clone())
            });
            (result, count.get(), query.len())
        }
    }

    fn fixture() -> &'static Fixture {
        static DATA: OnceLock<Fixture> = OnceLock::new();
        DATA.get_or_init(|| {
            let source: Vec<Value> = serde_json::from_str(include_str!(
                "../../../server/tests/fixtures/browser-transactions.json"
            ))
            .unwrap();
            let txid = source[0]["txid"].as_str().unwrap();
            let selected = global_data::key_row(txid).unwrap();
            let padding: String = (0u32..2_000)
                .map(|n| hex::encode(Sha256::digest(n.to_le_bytes())))
                .collect();
            let record = json!({
                "schema": full_record::RECORD_SCHEMA,
                "network": "mainnet", "txid": txid,
                "snapshot": {"height": 500_000, "hash": "11".repeat(32), "publishedAt": "2026-11-02T00:00:00Z"},
                "coverage": {"startHeight": 419_200, "endHeight": 419_200, "complete": false},
                "detail": {"txid": txid, "status": "confirmed", "isCanonical": true, "blockHeight": 419_200,
                    "blockHash": "22".repeat(32), "inputs": [], "outputs": [], "feeZat": "0"},
                "raw": {"txid": txid, "hex": source[0]["hex"], "decoded": {"txid": txid, "hex": source[0]["hex"], "padding": padding}},
                "source": {"authority": "browser binding unit fixture", "available": true},
                "price": {"available": false, "usd": null},
            });
            let bucket = global_data::encode_bucket(std::slice::from_ref(&record)).unwrap();
            assert!(bucket.len() > global_data::PAYLOAD_BYTES);
            assert!(bucket.len() <= 2 * global_data::PAYLOAD_BYTES);
            let profile = global_data::profile().unwrap();
            let public: Vec<u8> = (0..2)
                .flat_map(|index| vec![index as u8; profile.scheme.public_bytes])
                .collect();
            let mut manifest = json!({
                "schema": global_data::SCHEMA, "geometry": global_data::GEOMETRY, "table": global_data::TABLE,
                "rows": global_data::ROWS, "rowBytes": global_data::ROW_BYTES, "payloadBytes": global_data::PAYLOAD_BYTES,
                "layerCount": 2, "hashAlgorithm": global_data::HASH_ALGORITHM, "recordCodec": global_data::RECORD_CODEC,
                "network": "mainnet", "sourceDigest": "33".repeat(32), "sourceSummary": {"fixture": true},
                "scheme": profile.scheme,
            });
            let context = global_data::manifest_context_id(&manifest).unwrap();
            manifest["contextId"] = json!(context);
            let mut buckets = vec![Vec::new(); global_data::ROWS];
            buckets[selected] = bucket;
            let mut colliding_absent = None;
            let mut empty_absent = None;
            for n in 0u64.. {
                let id = hex::encode(Sha256::digest(n.to_le_bytes()));
                if id == txid {
                    continue;
                }
                if global_data::key_row(&id).unwrap() == selected {
                    colliding_absent.get_or_insert(id);
                } else {
                    empty_absent.get_or_insert(id);
                }
                if colliding_absent.is_some() && empty_absent.is_some() {
                    break;
                }
            }
            let empty_absent = empty_absent.unwrap();
            let empty = global_data::key_row(&empty_absent).unwrap();
            let mut selected_rows = Vec::new();
            let mut empty_rows = Vec::new();
            let mut layers = Vec::new();
            for index in 0..2 {
                // Authentication uses the production 64KiB layout. Drop each
                // 128MiB plaintext database immediately; persist no artifacts.
                let (database, root) =
                    global_data::build_layer(&context, index, 2, &buckets).unwrap();
                selected_rows.push(
                    database[selected * global_data::ROW_BYTES
                        ..(selected + 1) * global_data::ROW_BYTES]
                        .to_vec(),
                );
                empty_rows.push(
                    database[empty * global_data::ROW_BYTES..(empty + 1) * global_data::ROW_BYTES]
                        .to_vec(),
                );
                let files: Vec<_> = (0..2)
                    .map(|part| json!({"file": format!("prepared-{part:02}.bin"), "count": 16,
                        "bytes": 16 + 16 * profile.native.prepared_block_planned_bytes(), "sha256": "44".repeat(32)}))
                    .collect();
                let setup = &public[index * profile.scheme.public_bytes
                    ..(index + 1) * profile.scheme.public_bytes];
                layers.push(json!({"index": index, "merkleRoot": root,
                    "databaseSha256": hex::encode(Sha256::digest(&database)),
                    "publicSha256": hex::encode(Sha256::digest(setup)), "preparedFiles": files}));
            }
            manifest["layers"] = json!(layers);
            manifest["publicationId"] = json!(global_data::manifest_id(&manifest).unwrap());
            Fixture {
                manifest,
                public,
                record,
                selected_rows,
                empty_rows,
                colliding_absent: colliding_absent.unwrap(),
                empty_absent,
            }
        })
    }

    #[test]
    fn constructor_rejects_profile_manifest_and_every_setup_tamper() {
        let f = fixture();
        assert!(GlobalPirBrowser::from_publication("{", &f.public).is_err());
        assert!(
            GlobalPirBrowser::from_publication(
                &" ".repeat(global_data::MAX_MANIFEST_BYTES + 1),
                &f.public,
            )
            .is_err()
        );
        assert_eq!(f.client().profile.scheme.request_bytes, 20_992);
        assert_eq!(f.client().profile.scheme.response_bytes, 81_920);
        assert_eq!(f.client().profile.scheme.public_bytes, 360_448);
        let mut profile = f.manifest.clone();
        profile["rowBytes"] = json!(2048);
        profile["contextId"] = json!(global_data::manifest_context_id(&profile).unwrap());
        profile["publicationId"] = json!(global_data::manifest_id(&profile).unwrap());
        assert!(GlobalPirBrowser::from_publication(&profile.to_string(), &f.public).is_err());
        for field in ["sourceDigest", "publicationId", "contextId"] {
            let mut bad = f.manifest.clone();
            bad[field] = json!("ff".repeat(32));
            assert!(GlobalPirBrowser::from_publication(&bad.to_string(), &f.public).is_err());
        }
        for layer in 0..2 {
            let mut bad = f.public.clone();
            bad[layer * 360_448 + 17] ^= 1;
            assert!(GlobalPirBrowser::from_publication(&f.manifest.to_string(), &bad).is_err());
        }
        for bad in [
            f.public[..f.public.len() - 1].to_vec(),
            [f.public.clone(), vec![0]].concat(),
        ] {
            assert!(GlobalPirBrowser::from_publication(&f.manifest.to_string(), &bad).is_err());
        }
    }

    #[test]
    fn authenticated_full_envelope_and_both_absence_paths_use_the_whole_schedule() {
        let f = fixture();
        let txid = f.record["txid"].as_str().unwrap();
        let (result, decoded, bytes) = f.decode_rows(&txid.to_ascii_uppercase(), &f.selected_rows);
        let mut expected = f.record.clone();
        expected["found"] = json!(true);
        expected["publicationId"] = f.manifest["publicationId"].clone();
        assert_eq!(
            serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
            expected
        );
        assert_eq!((decoded, bytes), (2, 20_992));
        for (absent, rows) in [
            (&f.colliding_absent, &f.selected_rows),
            (&f.empty_absent, &f.empty_rows),
        ] {
            let (result, decoded, bytes) = f.decode_rows(absent, rows);
            assert_eq!(
                serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
                json!({"found": false, "publicationId": f.manifest["publicationId"]})
            );
            assert_eq!((decoded, bytes), (2, 20_992));
        }
    }

    #[test]
    fn invalid_layers_never_short_circuit_other_decryptions_or_release_a_match() {
        let f = fixture();
        for txid in [
            f.record["txid"].as_str().unwrap(),
            &f.colliding_absent,
            &f.empty_absent,
        ] {
            let base = if txid == f.empty_absent {
                &f.empty_rows
            } else {
                &f.selected_rows
            };
            for index in 0..2 {
                let mut rows = base.clone();
                rows[index][0] ^= 1;
                let (result, decoded, _) = f.decode_rows(txid, &rows);
                assert!(result.is_err());
                assert_eq!(decoded, 2);
            }
        }
        let mut client = f.client();
        client
            .prepare_query(f.record["txid"].as_str().unwrap())
            .unwrap();
        let pending = client.pending.take().unwrap();
        let bundle = vec![0; 2 * client.profile.scheme.response_bytes];
        let count = Cell::new(0);
        let result = client.decode_complete_bundle(pending, &bundle, |_, _, _| {
            let index = count.get();
            count.set(index + 1);
            if index == 0 {
                Err("test decryption failure".into())
            } else {
                Ok(f.selected_rows[index].clone())
            }
        });
        assert!(result.is_err());
        assert_eq!(count.get(), 2);
    }

    #[test]
    fn malformed_bundle_and_cancel_consume_state_and_repeated_queries_are_fresh() {
        let f = fixture();
        let txid = f.record["txid"].as_str().unwrap();
        let mut client = f.client();
        assert!(client.prepare_query("invalid").is_err());
        assert!(client.pending.is_none());
        let first = client.prepare_query(txid).unwrap();
        assert!(client.prepare_query(txid).is_err());
        client.cancel_query();
        assert!(client.pending.is_none());
        let second = client.prepare_query(txid).unwrap();
        assert_ne!(first, second);
        assert!(client.decode_bundle(&[]).is_err());
        assert!(client.pending.is_none());
        assert!(client.decode_bundle(&[]).is_err());
        for difference in [-1isize, 1] {
            client.prepare_query(txid).unwrap();
            let bytes = (2 * client.profile.scheme.response_bytes)
                .checked_add_signed(difference)
                .unwrap();
            assert!(client.decode_bundle(&vec![0; bytes]).is_err());
            assert!(client.pending.is_none());
        }
        client.prepare_query(txid).unwrap();
        let mut invalid = vec![0; 2 * client.profile.scheme.response_bytes];
        invalid[0] = 255;
        assert!(client.decode_bundle(&invalid).is_err());
        assert!(client.pending.is_none());
    }

    struct SmallNativeLayer {
        database: Vec<u8>,
        blocks: Vec<NativePreprocessed>,
        public: Vec<u8>,
    }

    impl SmallNativeLayer {
        fn new(profile: &TableProfile, target: usize, byte: u8) -> Self {
            let mut database = vec![0; profile.rows * profile.row_bytes];
            for (index, entry) in database
                [target * profile.row_bytes..(target + 1) * profile.row_bytes]
                .iter_mut()
                .enumerate()
            {
                *entry = (index as u8).wrapping_add(byte);
            }
            let mut columns = vec![0; database.len()];
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
                database,
                blocks,
                public,
            }
        }

        fn answer(&self, profile: &TableProfile, query: &[u8]) -> Vec<u8> {
            let (keys, selection) = profile.parse(query).unwrap();
            let scan: Vec<_> = (0..profile.cols)
                .map(|col| {
                    selection
                        .iter()
                        .enumerate()
                        .fold(0u64, |sum, (row, &coefficient)| {
                            sum.wrapping_add(
                                u64::from(self.database[row * profile.row_bytes + col])
                                    .wrapping_mul(coefficient),
                            )
                        })
                        & (zakura_pir_protocol::native::Q - 1)
                })
                .collect();
            profile.native.pack(&self.blocks, &keys, &scan).unwrap()
        }
    }

    #[test]
    fn one_encrypted_query_and_secret_decrypt_two_independent_native_layers() {
        // Test only the query-reuse algebra at one packing block to avoid two
        // ~1GiB prepared production layers in a default laptop unit test. This
        // adapter is never accepted by the production manifest constructor.
        let mut profile = TableProfile::new(
            global_data::SCHEMA,
            global_data::GEOMETRY,
            global_data::TABLE,
            global_data::ROWS as u64,
            2048,
        )
        .unwrap();
        let production = global_data::profile().unwrap();
        // Upstream mask expansion also binds the column count. Reuse the exact
        // production masks in this test adapter instead of regenerating them
        // from the reduced row width.
        profile.masks.clone_from(&production.masks);
        assert!(profile.masks == production.masks);
        assert_eq!(profile.setup.id(), production.setup.id());
        assert_eq!(
            profile.scheme.request_bytes,
            production.scheme.request_bytes
        );
        let target = global_data::key_row(&"ab".repeat(32)).unwrap();
        let first = SmallNativeLayer::new(&profile, target, 19);
        let second = SmallNativeLayer::new(&profile, target, 137);
        assert_ne!(first.public, second.public);
        let (secret, query) = profile.prepare(target).unwrap();
        let first_response = first.answer(&profile, &query);
        let second_response = second.answer(&profile, &query);
        assert_ne!(first_response, second_response);
        for (layer, response) in [(&first, first_response), (&second, second_response)] {
            let decoded = profile.decode(&secret, &layer.public, &response).unwrap();
            assert_eq!(
                decoded,
                layer.database[target * profile.row_bytes..(target + 1) * profile.row_bytes]
            );
        }
    }
}
