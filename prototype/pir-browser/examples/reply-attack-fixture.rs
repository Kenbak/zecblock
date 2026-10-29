//! Offline test-only selective malformed-row fixture. Never a production CLI mode.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};
use zakura_pir_server_core::native::{ProfilePublicationExt as _, hint, preprocess};
use zecblock_pir_browser::full_record;

fn main() -> Result<(), String> {
    let args: Vec<_> = env::args().collect();
    let [_, input, output, txid, ordinal] = args.as_slice() else {
        return Err("Usage (offline tests only): reply-attack-fixture <clean-publication> <new-output> <target-txid> <chunk-ordinal>".into());
    };
    let input = Path::new(input);
    let output = Path::new(output);
    if output.exists() {
        return Err("Output must be a new test-only directory".into());
    }
    let ordinal: usize = ordinal.parse().map_err(|_| "Invalid chunk ordinal")?;
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(input.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if manifest["schema"] != full_record::SCHEMA
        || manifest["publicationId"] != full_record::publication_id(&manifest)?
    {
        return Err("Expected a bound full-record publication".into());
    }
    let entry = manifest["catalogue"]
        .as_array()
        .ok_or("Missing catalogue")?
        .iter()
        .find(|item| item["txid"].as_str() == Some(txid.as_str()))
        .ok_or("Target transaction not in catalogue")?;
    let row = entry["rows"]
        .get(ordinal)
        .and_then(Value::as_u64)
        .ok_or("Target chunk is outside the fixed batch")? as usize;
    let mut database = fs::read(input.join("database.bin")).map_err(|e| e.to_string())?;
    let profile = full_record::profile()?;
    if database.len() != profile.rows * profile.row_bytes
        || manifest["databaseSha256"] != hex::encode(Sha256::digest(&database))
        || row >= profile.rows
    {
        return Err("Clean database identity or shape mismatch".into());
    }
    database[row * profile.row_bytes] ^= 1; // Break only this row's envelope magic.
    let mut columns = vec![0u8; database.len()];
    for row in 0..profile.rows {
        for col in 0..profile.cols {
            columns[col * profile.rows + row] = database[row * profile.row_bytes + col];
        }
    }
    let prepared_hint = hint(&profile.masks, profile.rows, profile.cols, |col| {
        &columns[col * profile.rows..(col + 1) * profile.rows]
    })?;
    let blocks = preprocess(&profile.setup, &prepared_hint)?;
    let public = profile.native.publish(&blocks)?;
    manifest["databaseSha256"] = json!(hex::encode(Sha256::digest(&database)));
    manifest["publicSha256"] = json!(hex::encode(Sha256::digest(&public)));
    if manifest["publicationId"] != full_record::publication_id(&manifest)? {
        return Err("Test fixture unexpectedly changed committed catalogue or layout".into());
    }
    fs::create_dir_all(output).map_err(|e| e.to_string())?;
    for name in ["source.json", "expected.json"] {
        let source = input.join(name);
        if source.exists() {
            fs::copy(source, output.join(name)).map_err(|e| e.to_string())?;
        }
    }
    fs::write(output.join("database.bin"), database).map_err(|e| e.to_string())?;
    fs::write(output.join("public.bin"), public).map_err(|e| e.to_string())?;
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let receipt = json!({
        "testOnly": true, "targetTxid": txid, "chunkOrdinal": ordinal, "row": row,
        "publicationId": manifest["publicationId"], "publicSha256": manifest["publicSha256"],
        "databaseSha256": manifest["databaseSha256"],
        "attack": "One selected plaintext chunk has invalid magic; public setup recomputed over the poisoned database while original record commitments and publication identity remain unchanged.",
    });
    fs::write(
        output.join("attack-receipt.json"),
        serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    println!("{receipt}");
    Ok(())
}
