//! Loopback-only known-answer fixture service using pinned upstream native PIR.
//!
//! The small, sparse table deliberately has no production anonymity/capacity
//! claim. Query creation/decryption belongs to the browser, never this process.
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufRead, Write},
    path::Path,
};
use zakura_pir_protocol::transparent::{
    events::Txid,
    native::TableProfile,
    shard::{
        display::placement_row,
        txid::{self, DisplayEntry, DisplayFacts, DisplayOutput, Tag},
    },
};
use zakura_pir_query_server::{
    native::ProfileQueryExt as _, transparent::native::TableQueryExt as _,
};
use zakura_pir_server_core::native::{
    NativePreprocessed, ProfilePublicationExt as _, hint, preprocess,
};
use zcash_transaction_wire::TransactionView;

mod full;
#[path = "../../src/full_record.rs"]
pub mod full_record;
mod global;
#[path = "../../src/global.rs"]
pub mod global_data;
mod global_size;
mod matvec;

const SCHEMA: &str = "zecblock-private-tx-fixture-v1";
const GEOMETRY: &str = "fixture-2k";
const TABLE: &str = "txdirectory";
const ROWS: usize = 2048;
const ROW_BYTES: usize = 2048;
const UPSTREAM: &str = "a7c842fd4f16790ed6739346f44557a97065d242";
const IPIR: &str = "5ea080a3281a01c5459f585e0a1bbbde50ec2bd2";
const FIXTURES: &str = include_str!("../../../../server/tests/fixtures/browser-transactions.json");

#[derive(Deserialize)]
struct SourceFixture {
    key: String,
    network: String,
    height: u64,
    txid: String,
    hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogueEntry {
    txid: String,
    label: String,
    height: u64,
}

fn profile() -> Result<TableProfile, String> {
    TableProfile::new(SCHEMA, GEOMETRY, TABLE, ROWS as u64, ROW_BYTES as u32)
}

type FixtureData = (Vec<(Txid, DisplayEntry)>, Vec<CatalogueEntry>);

fn fixture_records() -> Result<FixtureData, String> {
    let source: Vec<SourceFixture> = serde_json::from_str(FIXTURES).map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    let mut catalogue = Vec::new();
    for fixture in source
        .into_iter()
        .filter(|f| f.network == "mainnet" && f.key.ends_with(":transparent"))
    {
        let raw = hex::decode(&fixture.hex).map_err(|e| e.to_string())?;
        let view = TransactionView::parse_exact(&raw).map_err(|e| e.to_string())?;
        let id = Txid(view.txid());
        if id.to_display_hex() != fixture.txid || !view.is_coinbase() {
            return Err("source fixture txid or coinbase mismatch".into());
        }
        let facts = DisplayFacts {
            txid: id,
            coinbase: true,
            fee: 0,
            has_shielded_components: view.has_shielded_components(),
            spent: Vec::new(),
            outputs: view
                .transparent_outputs()
                .iter()
                .map(|o| DisplayOutput {
                    value: u64::from(o.value),
                    script: o.script_pubkey.to_vec(),
                })
                .collect(),
        };
        records.push((id, facts.entry().map_err(|e| e.to_string())?));
        catalogue.push(CatalogueEntry {
            txid: fixture.txid,
            label: format!("Mainnet v{} coinbase fixture", view.version().number()),
            height: fixture.height,
        });
    }
    if records.len() != 3 {
        return Err("expected three checked mainnet coinbase fixtures".into());
    }
    Ok((records, catalogue))
}

fn database(records: &[(Txid, DisplayEntry)]) -> Result<Vec<u8>, String> {
    let mut grouped: BTreeMap<usize, Vec<DisplayEntry>> = BTreeMap::new();
    for (id, entry) in records {
        if entry.tag != Tag::of(id) {
            return Err("fixture tag mismatch".into());
        }
        let row = placement_row(&entry.tag, 0, 0, 0, ROWS as u64) as usize;
        grouped.entry(row).or_default().push(*entry);
    }
    let mut db = vec![0; ROWS * ROW_BYTES];
    for (row, entries) in grouped {
        let encoded = txid::encode_row(&entries, ROW_BYTES).map_err(|e| e.to_string())?;
        db[row * ROW_BYTES..(row + 1) * ROW_BYTES].copy_from_slice(&encoded);
    }
    Ok(db)
}

struct Evaluator {
    profile: TableProfile,
    database: Vec<u8>,
    blocks: Vec<NativePreprocessed>,
    public: Vec<u8>,
}

impl Evaluator {
    fn new(database: Vec<u8>) -> Result<Self, String> {
        Self::with_profile(database, profile()?)
    }

    fn with_profile(database: Vec<u8>, profile: TableProfile) -> Result<Self, String> {
        let rows = profile.rows;
        let row_bytes = profile.row_bytes;
        if database.len() != rows * row_bytes {
            return Err("fixture database shape".into());
        }
        // Upstream publication primitives take column-major u8 coefficients.
        let mut columns = vec![0u8; database.len()];
        for row in 0..rows {
            for col in 0..row_bytes {
                columns[col * rows + row] = database[row * row_bytes + col];
            }
        }
        let prepared_hint = hint(&profile.masks, rows, profile.cols, |col| {
            &columns[col * rows..(col + 1) * rows]
        })?;
        let blocks = preprocess(&profile.setup, &prepared_hint)?;
        let public = profile.native.publish(&blocks)?;
        Ok(Self {
            profile,
            database,
            blocks,
            public,
        })
    }

    fn answer(&self, upload: &[u8]) -> Result<Vec<u8>, String> {
        let (keys, query) = self.profile.parse(upload)?;
        // This full linear scan is the same native-ring server intermediate
        // used by upstream roundtrip tests; it never decodes a selected row.
        let intermediate = matvec::multiply(&self.database, self.profile.row_bytes, &query);
        self.profile.native.pack(&self.blocks, &keys, &intermediate)
    }
}

fn prepare(dir: &Path) -> Result<(), String> {
    let (records, catalogue) = fixture_records()?;
    // Test oracle is kept outside the public setup/manifest. Its values come
    // from parsing the canonical raw fixture bytes, never a client echo.
    let expected: BTreeMap<String, Value> = records
        .iter()
        .map(|(id, entry)| {
            let outputs: Vec<Value> = entry.outputs.iter().enumerate().filter_map(|(index, output)| {
                output.map(|output| json!({
                    "index": index,
                    "valueZatoshis": output.value.to_string(),
                    "address": {"kind": output.address.kind, "hash": hex::encode(output.address.hash)},
                }))
            }).collect();
            (id.to_display_hex(), json!({
                "txid": id.to_display_hex(), "found": true,
                "coinbase": entry.coinbase,
                "feeZatoshis": entry.fee.to_string(),
                "inputCount": entry.input_count,
                "outputCount": entry.output_count,
                "outputs": outputs,
            }))
        })
        .collect();
    let db = database(&records)?;
    let evaluator = Evaluator::new(db)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let manifest = json!({
        "schema": SCHEMA, "geometry": GEOMETRY, "table": TABLE,
        "rows": ROWS, "rowBytes": ROW_BYTES, "placementSeed": 0, "shard": 0, "bucket": 0,
        "scheme": evaluator.profile.scheme,
        "publicSha256": hex::encode(Sha256::digest(&evaluator.public)),
        "databaseSha256": hex::encode(Sha256::digest(&evaluator.database)),
        "catalogue": catalogue,
        "upstream": { "walletLibraries": UPSTREAM, "ipirSp": IPIR },
        "scope": "Three pre-existing public mainnet coinbase fixtures; sparse local prototype, not a live chain index or production anonymity set. Limited upstream Display codec, not full transaction data."
    });
    fs::write(dir.join("database.bin"), &evaluator.database).map_err(|e| e.to_string())?;
    fs::write(dir.join("public.bin"), &evaluator.public).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        dir.join("expected.json"),
        serde_json::to_vec_pretty(&expected).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    eprintln!(
        "Prepared three checked coinbase fixtures with {}-byte queries and {}-byte replies",
        evaluator.profile.scheme.request_bytes, evaluator.profile.scheme.response_bytes
    );
    Ok(())
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    query: String,
}

fn serve(dir: &Path) -> Result<(), String> {
    let manifest: Value =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let db = fs::read(dir.join("database.bin")).map_err(|e| e.to_string())?;
    if manifest["databaseSha256"] != hex::encode(Sha256::digest(&db)) {
        return Err("fixture database checksum mismatch".into());
    }
    let profile = if manifest["schema"] == full_record::SCHEMA {
        full::validate_manifest(&manifest)?
    } else if manifest["schema"] == SCHEMA {
        profile()?
    } else {
        return Err("unsupported publication schema".into());
    };
    let evaluator = Evaluator::with_profile(db, profile)?;
    if manifest["publicSha256"] != hex::encode(Sha256::digest(&evaluator.public))
        || manifest["scheme"]
            != serde_json::to_value(&evaluator.profile.scheme).map_err(|e| e.to_string())?
    {
        return Err("fixture setup mismatch".into());
    }
    eprintln!("Fixture evaluator ready");
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request = serde_json::from_str::<Request>(&line);
        let reply = match request {
            Ok(request) => {
                // Only the fixed-size native encrypted query is admitted.
                let result = if request.query.len()
                    <= evaluator.profile.scheme.request_bytes.div_ceil(3) * 4
                {
                    B64.decode(&request.query)
                        .map_err(|_| "query encoding".to_string())
                        .and_then(|bytes| evaluator.answer(&bytes))
                } else {
                    Err("query length".into())
                };
                match result {
                    Ok(response) => json!({"id": request.id, "response": B64.encode(response)}),
                    Err(_) => json!({"id": request.id, "error": "Invalid encrypted fixture query"}),
                }
            }
            Err(_) => json!({"id": null, "error": "Invalid encrypted fixture query"}),
        };
        serde_json::to_writer(&mut stdout, &reply).map_err(|e| e.to_string())?;
        writeln!(&mut stdout).map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Explicit local CLI only: never used by the query protocol or HTTP service.
fn benchmark_matvec(dir: &Path, iterations: usize) -> Result<(), String> {
    let manifest: Value =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let profile = if manifest["schema"] == full_record::SCHEMA {
        full::validate_manifest(&manifest)?
    } else if manifest["schema"] == SCHEMA {
        profile()?
    } else {
        return Err("unsupported publication schema".into());
    };
    let database = fs::read(dir.join("database.bin")).map_err(|e| e.to_string())?;
    if profile.native.entry_bytes() != 1
        || database.len() != profile.rows * profile.row_bytes
        || manifest["databaseSha256"] != hex::encode(Sha256::digest(&database))
    {
        return Err("matrix benchmark requires a checksum-verified P8 database".into());
    }
    let query = matvec::benchmark_query(profile.rows);
    let result = matvec::benchmark(&database, profile.row_bytes, &query, iterations)?;
    serde_json::to_writer(io::stdout().lock(), &result).map_err(|e| e.to_string())?;
    println!();
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.as_slice() {
        [_, mode, dir] if mode == "prepare" => prepare(Path::new(dir)),
        [_, mode, source, dir, flag] if mode == "prepare-full" && flag == "--debug-oracle" => {
            full::prepare_full_debug(Path::new(source), Path::new(dir))
        }
        [_, mode, source, dir] if mode == "prepare-full" => {
            full::prepare_full(Path::new(source), Path::new(dir))
        }
        [_, mode, source, dir] if mode == "prepare-full-legacy" => {
            full::prepare_full_legacy(Path::new(source), Path::new(dir))
        }
        [_, mode, source] if mode == "plan-full" => full::plan_full(Path::new(source)),
        [_, mode, source] if mode == "plan-global" => global::plan_global(Path::new(source)),
        [_, mode, source] if mode == "plan-global-compact" => global::plan_global_compact(Path::new(source)),
        [_, mode, source] if mode == "measure-global" => global_size::measure_source(Path::new(source)),
        [_, mode, source, dir] if mode == "prepare-global" => {
            global::prepare_global(Path::new(source), Path::new(dir))
        }
        [_, mode, source, dir] if mode == "prepare-global-compact" => {
            global::prepare_global_compact(Path::new(source), Path::new(dir))
        }
        [_, mode, clean, dir, layer, row, offset] if mode == "prepare-global-poison-test" => {
            layer.parse::<usize>().and_then(|layer|row.parse::<usize>().map(|row|(layer,row)))
                .and_then(|(layer,row)|offset.parse::<usize>().map(|offset|(layer,row,offset)))
                .map_err(|_|"Invalid offline poison-test indices".to_owned())
                .and_then(|(layer,row,offset)|global::prepare_global_poison_test(Path::new(clean),Path::new(dir),layer,row,offset))
        }
        [_, mode, dir] if mode == "serve-global" => global::serve_global(Path::new(dir)),
        [_, mode, dir] if mode == "serve-global-cached" => global::serve_global_cached(Path::new(dir)),
        [_, mode, dir, options @ ..] if mode == "profile-global" => global::profile_global(Path::new(dir), options),
        [_, mode, dir] if mode == "benchmark-matvec" => benchmark_matvec(Path::new(dir), 15),
        [_, mode, dir, iterations] if mode == "benchmark-matvec" => iterations
            .parse::<usize>()
            .map_err(|_| "invalid benchmark iteration count".into())
            .and_then(|iterations| benchmark_matvec(Path::new(dir), iterations)),
        [_, mode, dir] if mode == "serve" => serve(Path::new(dir)),
        _ => Err("Usage: zecblock-pir-fixture prepare|serve <directory> | prepare-full <source.json> <directory> [--debug-oracle] | prepare-full-legacy <source.json> <directory> | plan-full <source.json> | plan-global|plan-global-compact|measure-global <source.json> | prepare-global|prepare-global-compact <source.json> <NEW-directory> | prepare-global-poison-test <clean-directory> <NEW-directory> <layer> <row> <payload-offset> | serve-global|serve-global-cached <directory> | profile-global <directory> [--mode baseline|cached|compare] [--layers N|all] [--iterations N] | benchmark-matvec <directory> [iterations]".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zakura_pir_client::transparent::native::TableClientExt as _;

    #[test]
    fn checked_chain_fixtures_roundtrip_through_actual_pir() {
        let (records, _) = fixture_records().unwrap();
        let evaluator = Evaluator::new(database(&records).unwrap()).unwrap();
        for (id, expected) in records {
            let selected = placement_row(&Tag::of(&id), 0, 0, 0, ROWS as u64) as usize;
            let (secret, upload) = evaluator.profile.prepare(selected).unwrap();
            let response = evaluator.answer(&upload).unwrap();
            let (keys, query) = evaluator.profile.parse(&upload).unwrap();
            let reference =
                matvec::column_strided(&evaluator.database, evaluator.profile.row_bytes, &query);
            assert_eq!(
                response,
                evaluator
                    .profile
                    .native
                    .pack(&evaluator.blocks, &keys, &reference)
                    .unwrap(),
                "same encrypted upload must produce byte-identical packed replies"
            );
            let decoded = evaluator
                .profile
                .decode(&secret, &evaluator.public, &response)
                .unwrap();
            let entry = txid::find_entry(&[decoded], &id, |tag| {
                placement_row(tag, 0, 0, 0, ROWS as u64) as usize == selected
            })
            .unwrap();
            assert_eq!(entry, Some(expected));
        }
        assert!(evaluator.answer(&[0; 10]).is_err());
    }

    #[test]
    #[ignore = "explicit offline archive benchmark; set PIR_MATVEC_BENCH_DIR"]
    fn archive_matrix_and_pack_timing() {
        use std::{hint::black_box, time::Instant};

        let directory = std::env::var("PIR_MATVEC_BENCH_DIR").unwrap();
        let dir = Path::new(&directory);
        let manifest: Value =
            serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        let database = fs::read(dir.join("database.bin")).unwrap();
        assert_eq!(
            manifest["databaseSha256"],
            hex::encode(Sha256::digest(&database))
        );
        let profile = full::validate_manifest(&manifest).unwrap();
        let evaluator = Evaluator::with_profile(database, profile).unwrap();
        assert_eq!(
            manifest["publicSha256"],
            hex::encode(Sha256::digest(&evaluator.public))
        );
        assert_eq!(
            manifest["scheme"],
            serde_json::to_value(&evaluator.profile.scheme).unwrap()
        );
        let mut results = Vec::new();
        // First, middle and reserved cover rows; fresh actual client ciphertext.
        for selected in [0, evaluator.profile.rows / 2, evaluator.profile.rows - 1] {
            let (secret, upload) = evaluator.profile.prepare(selected).unwrap();
            let mut timings = Vec::new();
            let mut expected_response = None;
            for baseline in [true, false, false, true] {
                let total_start = Instant::now();
                let (keys, query) = evaluator.profile.parse(black_box(&upload)).unwrap();
                let parse_ns = total_start.elapsed().as_nanos();
                let scan_start = Instant::now();
                let intermediate = if baseline {
                    matvec::column_strided(&evaluator.database, evaluator.profile.row_bytes, &query)
                } else {
                    matvec::multiply(&evaluator.database, evaluator.profile.row_bytes, &query)
                };
                let scan_ns = scan_start.elapsed().as_nanos();
                let pack_start = Instant::now();
                let response = evaluator
                    .profile
                    .native
                    .pack(&evaluator.blocks, &keys, &intermediate)
                    .unwrap();
                let pack_ns = pack_start.elapsed().as_nanos();
                let total_ns = total_start.elapsed().as_nanos();
                if let Some(expected) = &expected_response {
                    assert_eq!(&response, expected);
                } else {
                    expected_response = Some(response.clone());
                }
                let decoded = evaluator
                    .profile
                    .decode(&secret, &evaluator.public, &response)
                    .unwrap();
                assert_eq!(
                    decoded,
                    evaluator.database[selected * evaluator.profile.row_bytes
                        ..(selected + 1) * evaluator.profile.row_bytes]
                );
                timings.push(json!({ "baseline": baseline, "parseNs": parse_ns,
                    "scanNs": scan_ns, "packNs": pack_ns, "totalNs": total_ns }));
            }
            results.push(json!({"row": selected, "timings": timings}));
        }
        println!(
            "{}",
            json!({ "schema": "zecblock-pir-matvec-pack-benchmark-v1",
            "databaseSha256": manifest["databaseSha256"],
            "publicSha256": manifest["publicSha256"],
            "profile": evaluator.profile.scheme, "repliesByteIdentical": true,
            "decodedRowsMatchDatabase": true, "results": results,
            "timingScope": "parse + matrix scan + packing; excludes evaluator setup, client preparation/decryption and transport" })
        );
    }
}
