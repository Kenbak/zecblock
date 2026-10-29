//! Local-only browser binding for the pinned upstream native PIR implementation.
//! This bounded fixture profile is not a production wallet-pir HTTP endpoint.
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zakura_pir_client::transparent::native::{NativeSecret, TableClientExt, TableProfile};
use zakura_pir_protocol::transparent::{
    events::Txid,
    shard::{
        display::placement_row,
        txid::{self, Address, Tag},
    },
};

const SCHEMA: &str = "zecblock-private-tx-fixture-v1";
const GEOMETRY: &str = "fixture-2k";
const ROWS: u64 = 2048;
const ROW_BYTES: u32 = 2048;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: String,
    geometry: String,
    table: String,
    rows: u64,
    row_bytes: u32,
    placement_seed: u32,
    shard: u64,
    bucket: u32,
    scheme: zakura_pir_protocol::transparent::native::NativeScheme,
    public_sha256: String,
}

struct Pending {
    secret: NativeSecret,
    txid: Txid,
    display_txid: String,
    row: u64,
}

/// One client of the fixed, locally published fixture table.
/// Secrets and row selection stay in WASM until a response is decoded or cancelled.
#[wasm_bindgen]
pub struct PirBrowser {
    profile: TableProfile,
    public: Vec<u8>,
    pending: Option<Pending>,
}

fn js_error(message: impl ToString) -> JsValue {
    JsValue::from_str(&message.to_string())
}

fn parse_txid(display: &str) -> Result<Txid, String> {
    if display.len() != 64 || !display.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Enter a 64-character hexadecimal transaction ID.".into());
    }
    let mut bytes: [u8; 32] = hex::decode(display)
        .map_err(|_| "Invalid transaction ID")?
        .try_into()
        .map_err(|_| "Invalid transaction ID")?;
    // Upstream Txid and Tag use serialized/internal order; URLs use display order.
    bytes.reverse();
    Ok(Txid(bytes))
}

fn address_json(address: Address) -> serde_json::Value {
    json!({"kind": address.kind, "hash": hex::encode(address.hash)})
}

#[wasm_bindgen]
impl PirBrowser {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str, public_setup: &[u8]) -> Result<PirBrowser, JsValue> {
        let manifest: Manifest = serde_json::from_str(manifest_json).map_err(js_error)?;
        // Parameters are pinned by this client, never chosen by an untrusted server.
        if manifest.schema != SCHEMA
            || manifest.geometry != GEOMETRY
            || manifest.table != "txdirectory"
            || manifest.rows != ROWS
            || manifest.row_bytes != ROW_BYTES
            || manifest.placement_seed != 0
            || manifest.shard != 0
            || manifest.bucket != 0
        {
            return Err(js_error("Unsupported fixture manifest"));
        }
        let profile = TableProfile::new(SCHEMA, GEOMETRY, "txdirectory", ROWS, ROW_BYTES)
            .map_err(js_error)?;
        if manifest.scheme != profile.scheme
            || public_setup.len() != profile.scheme.public_bytes
            || hex::encode(Sha256::digest(public_setup)) != manifest.public_sha256
        {
            return Err(js_error(
                "Fixture setup or profile does not match its manifest",
            ));
        }
        Ok(Self {
            profile,
            public: public_setup.to_vec(),
            pending: None,
        })
    }

    /// Generate a fresh upstream PIR key and encrypted selection with browser entropy.
    /// This returns only K_g plus the encrypted selection; no txid or row is framed.
    pub fn make_query(&mut self, display_txid: &str) -> Result<Vec<u8>, JsValue> {
        if self.pending.is_some() {
            return Err(js_error("Finish or cancel the pending private query first"));
        }
        let txid = parse_txid(display_txid).map_err(js_error)?;
        let row = placement_row(&Tag::of(&txid), 0, 0, 0, ROWS);
        let (secret, query) = self.profile.prepare(row as usize).map_err(js_error)?;
        self.pending = Some(Pending {
            secret,
            txid,
            display_txid: display_txid.to_ascii_lowercase(),
            row,
        });
        Ok(query)
    }

    /// Decode one packed upstream response and validate the canonical Display row.
    /// A failed response consumes the pending state; a retry must make a fresh query.
    pub fn decode_response(&mut self, response: &[u8]) -> Result<String, JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| js_error("No pending private query"))?;
        let row = self
            .profile
            .decode(&pending.secret, &self.public, response)
            .map_err(js_error)?;
        let entry = txid::find_entry(&[row], &pending.txid, |tag| {
            placement_row(tag, 0, 0, 0, ROWS) == pending.row
        })
        .map_err(js_error)?;
        let mut result = json!({
            "txid": pending.display_txid,
            "found": entry.is_some(),
            "scope": "Bounded local fixture; trusted publisher summary, not transaction authentication",
            "codec": txid::CODEC,
        });
        if let Some(entry) = entry {
            let outputs: Vec<_> = entry
                .outputs
                .iter()
                .enumerate()
                .filter_map(|(index, output)| {
                    output.map(|output| {
                        json!({
                            "index": index,
                            "valueZatoshis": output.value.to_string(),
                            "address": address_json(output.address),
                        })
                    })
                })
                .collect();
            let facts = json!({
                "coinbase": entry.coinbase,
                "hasShieldedComponents": entry.shielded_components,
                "feeZatoshis": entry.fee.to_string(),
                "inputCount": entry.input_count,
                "outputCount": entry.output_count,
                "moreThanTwoOutputs": entry.more_than_two_outputs(),
                "multipleSourceScripts": entry.multiple_source_scripts,
                "shieldedAndTransparentFunding": entry.shielded_and_transparent_funding,
                "completeDisplaySummary": entry.is_complete(),
                "source": address_json(entry.source),
                "outputs": outputs,
            });
            result
                .as_object_mut()
                .unwrap()
                .extend(facts.as_object().unwrap().clone());
        }
        serde_json::to_string(&result).map_err(js_error)
    }

    /// Drop pending state. This is not a claim of guaranteed memory erasure.
    pub fn cancel_query(&mut self) {
        self.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_display_order_is_reversed_for_upstream_tagging() {
        let display = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let txid = parse_txid(display).unwrap();
        assert_eq!(txid.0[0], 31);
        assert_eq!(txid.0[31], 0);
        assert!(parse_txid("not-a-transaction").is_err());
        assert!(parse_txid(&"g".repeat(64)).is_err());
    }
}
