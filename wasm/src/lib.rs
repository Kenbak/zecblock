use wasm_bindgen::prelude::*;

// Zakura Common note decryption; preserve Orchard and Ironwood domain separation.
use zcash_note_encryption::{try_note_decryption, try_compact_note_decryption, batch, ShieldedOutput, EphemeralKeyBytes};
use orchard::{
    keys::{FullViewingKey, Scope, PreparedIncomingViewingKey},
    note_encryption::{OrchardDomain, IronwoodDomain, CompactAction},
    note::ExtractedNoteCommitment,
};
use zcash_address::unified::{Container, Encoding, Fvk, Ufvk, Address as UnifiedAddress, Receiver};

use serde::{Serialize, Deserialize};

// ---------------------------------------------------------------------------
// Bounded v5/v6 parsing via Zakura Common; extract Orchard and Ironwood outputs.
// ---------------------------------------------------------------------------

const ORCHARD_ENC_CIPHERTEXT_SIZE: usize = 580;
const MAX_TX_BYTES: usize = 2_000_000;
const MAX_COMPACT_OUTPUTS: usize = 4096;
const MAX_COMPACT_JSON_BYTES: usize = 4_000_000;

struct OrchardActionRaw {
    nullifier_bytes: [u8; 32],
    cmx_bytes: [u8; 32],
    epk_bytes: [u8; 32],
    enc_ciphertext: [u8; ORCHARD_ENC_CIPHERTEXT_SIZE],
    is_ironwood: bool,
}

impl ShieldedOutput<OrchardDomain, ORCHARD_ENC_CIPHERTEXT_SIZE> for OrchardActionRaw {
    fn ephemeral_key(&self) -> EphemeralKeyBytes { EphemeralKeyBytes(self.epk_bytes) }
    fn cmstar_bytes(&self) -> [u8; 32] { self.cmx_bytes }
    fn enc_ciphertext(&self) -> &[u8; ORCHARD_ENC_CIPHERTEXT_SIZE] { &self.enc_ciphertext }
}

impl ShieldedOutput<IronwoodDomain, ORCHARD_ENC_CIPHERTEXT_SIZE> for OrchardActionRaw {
    fn ephemeral_key(&self) -> EphemeralKeyBytes { EphemeralKeyBytes(self.epk_bytes) }
    fn cmstar_bytes(&self) -> [u8; 32] { self.cmx_bytes }
    fn enc_ciphertext(&self) -> &[u8; ORCHARD_ENC_CIPHERTEXT_SIZE] { &self.enc_ciphertext }
}

/// Parse exactly one complete transaction with the maintained Common parser.
/// This checks the wire encoding, fields and bundle shapes, not proofs/signatures
/// or chain membership. Never rewrite a consensus branch ID to bypass parsing.
fn parse_orchard_actions(data: &[u8]) -> Result<(Vec<OrchardActionRaw>, usize, usize), String> {
    use zcash_primitives::transaction::{Transaction, TxVersion};
    use zcash_protocol::consensus::BranchId;
    if data.len() > MAX_TX_BYTES { return Err("Transaction exceeds 2 MB limit".into()); }
    if data.len() < 8 { return Err("Transaction too short".into()); }
    let version = u32::from_le_bytes(data[..4].try_into().unwrap());
    if version == 0x8000_0004 {
        return Err("Sapling memo decryption is not supported by this decoder".into());
    }
    if version != 0x8000_0005 && version != 0x8000_0006 {
        return Err("Unsupported transaction version (expected v5 or v6)".into());
    }
    let mut remaining = data;
    // v5/v6 carry their own branch ID; the argument applies only to older versions.
    let tx = Transaction::read(&mut remaining, BranchId::Nu5)
        .map_err(|e| format!("Invalid transaction encoding: {e}"))?;
    if !remaining.is_empty() { return Err("Trailing transaction bytes".into()); }
    if !matches!(tx.version(), TxVersion::V5 | TxVersion::V6)
        || !tx.version().valid_in_branch(tx.consensus_branch_id()) {
        return Err("Transaction version is invalid for its consensus branch".into());
    }
    let mut actions = Vec::new();
    for (bundle, is_ironwood) in [(tx.orchard_bundle(), false), (tx.ironwood_bundle(), true)] {
        if let Some(bundle) = bundle {
            for action in bundle.actions().iter() {
                let encrypted = action.encrypted_note();
                actions.push(OrchardActionRaw {
                    nullifier_bytes: action.nullifier().to_bytes(),
                    cmx_bytes: action.cmx().to_bytes(),
                    epk_bytes: encrypted.epk_bytes,
                    enc_ciphertext: encrypted.enc_ciphertext,
                    is_ironwood,
                });
            }
        }
    }
    let (spends, outputs) = tx.sapling_bundle().map(|b|
        (b.shielded_spends().len(), b.shielded_outputs().len())).unwrap_or((0, 0));
    Ok((actions, spends, outputs))
}

#[derive(Serialize, Deserialize)]
pub struct DecryptedOutput {
    pub memo: String,
    pub amount: f64, // Amount in ZEC
}

#[derive(Serialize, Deserialize)]
pub struct UnifiedAddressComponents {
    pub network: String,
    pub has_transparent: bool,
    pub has_sapling: bool,
    pub has_orchard: bool,
    pub transparent_address: Option<String>,
    pub sapling_address: Option<String>,
}

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn test_wasm() -> String {
    "WASM module loaded successfully".to_string()
}

#[wasm_bindgen]
pub fn detect_key_type(viewing_key: &str) -> String {
    if viewing_key.len() > 4096 { return "unknown".into(); }
    match Ufvk::decode(viewing_key).map(|(network, _)| network) {
        Ok(zcash_protocol::consensus::NetworkType::Main) => "ufvk-mainnet",
        Ok(zcash_protocol::consensus::NetworkType::Test) => "ufvk-testnet",
        _ => "unknown",
    }.to_string()
}

/// Decode a unified address and return its component receivers
#[wasm_bindgen]
pub fn decode_unified_address(ua_string: &str) -> Result<String, String> {
    if ua_string.len() > 4096 { return Err("Unified address exceeds size limit".into()); }
    // Decode the unified address
    let (_network, ua) = UnifiedAddress::decode(ua_string)
        .map_err(|e| format!("Failed to decode unified address: {:?}", e))?;

    let is_mainnet = ua_string.starts_with("u1");

    let network_name = if is_mainnet { "mainnet" } else { "testnet" };

    let mut components = UnifiedAddressComponents {
        network: network_name.to_string(),
        has_transparent: false,
        has_sapling: false,
        has_orchard: false,
        transparent_address: None,
        sapling_address: None,
    };

    // Iterate through receivers
    for receiver in ua.items() {
        match receiver {
            Receiver::P2pkh(data) => {
                components.has_transparent = true;
                // Encode as t1 address (mainnet) or tm (testnet)
                let prefix: &[u8] = if is_mainnet { &[0x1C, 0xB8] } else { &[0x1D, 0x25] };
                let mut addr_bytes = prefix.to_vec();
                addr_bytes.extend_from_slice(&data);
                components.transparent_address = Some(bs58::encode(&addr_bytes).with_check().into_string());
            },
            Receiver::P2sh(data) => {
                components.has_transparent = true;
                // Encode as t3 address (mainnet) or t2 (testnet)
                let prefix: &[u8] = if is_mainnet { &[0x1C, 0xBD] } else { &[0x1C, 0xBA] };
                let mut addr_bytes = prefix.to_vec();
                addr_bytes.extend_from_slice(&data);
                components.transparent_address = Some(bs58::encode(&addr_bytes).with_check().into_string());
            },
            Receiver::Sapling(_) => {
                components.has_sapling = true;
                // Encoding a standalone Sapling address is unsupported here.
                // Keep the nullable field empty rather than fabricate an address.
            },
            Receiver::Orchard(_) => {
                components.has_orchard = true;
                // Orchard receivers can't be encoded as standalone addresses
            },
            _ => {
                // Unknown receiver type, skip
            }
        }
    }

    serde_json::to_string(&components)
        .map_err(|e| format!("JSON serialization failed: {:?}", e))
}

/// A scan owns two prepared incoming keys. Free the session after use.
#[wasm_bindgen]
pub struct ScanSession {
    prepared_ivks: Vec<PreparedIncomingViewingKey>,
}

#[derive(Serialize)]
struct MemoOutput {
    memo: String,
    amount: f64,
    amount_zatoshis: u64,
    output_index: usize,
    pool: &'static str,
}

#[wasm_bindgen]
impl ScanSession {
    #[wasm_bindgen(constructor)]
    pub fn new(viewing_key: &str) -> Result<ScanSession, String> {
        if viewing_key.len() > 4096 { return Err("Viewing key exceeds size limit".into()); }
        // Step 1: Parse UFVK
        let (_network, ufvk) = Ufvk::decode(viewing_key)
            .map_err(|e| format!("UFVK decode failed: {:?}", e))?;

        // Step 2: Extract Orchard FVK
        let orchard_fvk_bytes = ufvk.items().iter().find_map(|fvk| {
            match fvk {
                Fvk::Orchard(data) => Some(*data),
                _ => None,
            }
        }).ok_or("No Orchard FVK found in UFVK")?;

        // Step 3: Parse FullViewingKey
        let fvk = FullViewingKey::from_bytes(&orchard_fvk_bytes)
            .ok_or("FVK parse failed")?;

        Ok(Self { prepared_ivks: [Scope::External, Scope::Internal].iter()
            .map(|scope| PreparedIncomingViewingKey::new(&fvk.to_ivk(*scope))).collect() })
    }

    /// Return every readable memo, with an index unique within the transaction.
    pub fn decrypt_memos(&self, tx_hex: &str) -> Result<String, String> {
        serde_json::to_string(&self.memo_outputs(tx_hex)?)
            .map_err(|e| e.to_string())
    }

    /// Fixed-width records: pool (0 unknown, 1 Orchard, 2 Ironwood),
    /// nullifier[32], cmx[32], epk[32], compact ciphertext[52].
    /// Returns matching record indices; no transaction identifiers cross the ABI.
    pub fn filter_compact(&self, bytes: &[u8]) -> Result<Vec<u32>, String> {
        Ok(self.filter_records(bytes)?.into_iter().map(|(index, _)| index as u32).collect())
    }
}

impl ScanSession {
    fn memo_outputs(&self, tx_hex: &str) -> Result<Vec<MemoOutput>, String> {
        // Step 4: Parse Orchard/Ironwood actions from v5 (ZIP-225) or v6 (ZIP-229) tx
        if tx_hex.len() > MAX_TX_BYTES * 2 { return Err("Transaction exceeds 2 MB limit".into()); }
        let tx_bytes = hex::decode(tx_hex)
            .map_err(|e| format!("Hex decode failed: {:?}", e))?;

        let (raw_actions, sapling_spends, sapling_outputs) = parse_orchard_actions(&tx_bytes)
            .map_err(|e| format!("TX parse: {}", e))?;

        if raw_actions.is_empty() {
            if sapling_spends > 0 || sapling_outputs > 0 {
                return Err("This transaction only contains Sapling shielded data. Sapling memo decryption isn't supported yet -- only Orchard and Ironwood transactions can be decrypted here.".to_string());
            }
            return Err("No Orchard bundle in transaction".to_string());
        }

        // Step 5: Try to decrypt all actions and collect valid outputs (memo + amount)
        let mut found_outputs = Vec::new();

        for (output_index, raw_action) in raw_actions.iter().enumerate() {
            let nullifier = orchard::note::Nullifier::from_bytes(&raw_action.nullifier_bytes)
                .into_option()
                .ok_or("Invalid nullifier in action")?;
            let cmx = ExtractedNoteCommitment::from_bytes(&raw_action.cmx_bytes)
                .into_option()
                .ok_or("Invalid cmx in action")?;

            let compact = CompactAction::from_parts(nullifier, cmx, raw_action.epk_bytes.into(), [0u8; 52]);

            for prepared_ivk in &self.prepared_ivks {

                // Use IronwoodDomain for Ironwood actions (lead byte 0x03),
                // OrchardDomain for Orchard actions (lead byte 0x02).
                let result = if raw_action.is_ironwood {
                    let domain = IronwoodDomain::for_compact_action(&compact);
                    try_note_decryption(&domain, prepared_ivk, raw_action)
                } else {
                    let domain = OrchardDomain::for_compact_action(&compact);
                    try_note_decryption(&domain, prepared_ivk, raw_action)
                };

                if let Some((note, _recipient, memo)) = result {
                    let memo_bytes = memo.as_slice();
                    let memo_len = memo_bytes.iter().position(|&b| b == 0).unwrap_or(memo_bytes.len());

                    if memo_len == 0 { break; }

                    if let Ok(memo_text) = String::from_utf8(memo_bytes[..memo_len].to_vec()) {
                        if !memo_text.trim().is_empty() {
                            let amount_zatoshis = note.value().inner();
                            let amount_zec = amount_zatoshis as f64 / 100_000_000.0;

                            found_outputs.push(MemoOutput {
                                output_index,
                                pool: if raw_action.is_ironwood { "ironwood" } else { "orchard" },
                                amount_zatoshis,
                                memo: memo_text,
                                amount: amount_zec,
                            });
                        }
                    }
                    break;
                }
            }
        }

        Ok(found_outputs)
    }

    fn filter_records(&self, bytes: &[u8]) -> Result<Vec<(usize, usize)>, String> {
        const RECORD_SIZE: usize = 149;
        if bytes.len() > MAX_COMPACT_OUTPUTS * RECORD_SIZE { return Err("Too many compact outputs (maximum 4096 per call)".into()); }
        if !bytes.len().is_multiple_of(RECORD_SIZE) { return Err("Invalid compact record length".into()); }
        let mut orchard = Vec::new();
        let mut ironwood = Vec::new();
        let mut orchard_indices = Vec::new();
        let mut ironwood_indices = Vec::new();
        for (index, record) in bytes.chunks_exact(RECORD_SIZE).enumerate() {
            let pool = record[0];
            if pool > 2 { return Err("Invalid compact pool".into()); }
            let nullifier = orchard::note::Nullifier::from_bytes(record[1..33].try_into().unwrap())
                .into_option().ok_or("Invalid nullifier")?;
            let cmx = ExtractedNoteCommitment::from_bytes(record[33..65].try_into().unwrap())
                .into_option().ok_or("Invalid CMX")?;
            let action = CompactAction::from_parts(nullifier, cmx,
                EphemeralKeyBytes(record[65..97].try_into().unwrap()), record[97..149].try_into().unwrap());
            if pool != 2 {
                orchard.push((OrchardDomain::for_compact_action(&action), action.clone()));
                orchard_indices.push(index);
            }
            if pool != 1 {
                ironwood.push((IronwoodDomain::for_compact_action(&action), action));
                ironwood_indices.push(index);
            }
        }
        let mut matches = std::collections::BTreeMap::new();
        for (index, result) in orchard_indices.into_iter().zip(batch::try_compact_note_decryption(&self.prepared_ivks, &orchard)) {
            if let Some((_, scope)) = result { matches.insert(index, scope); }
        }
        for (index, result) in ironwood_indices.into_iter().zip(batch::try_compact_note_decryption(&self.prepared_ivks, &ironwood)) {
            if let Some((_, scope)) = result { matches.entry(index).or_insert(scope); }
        }
        Ok(matches.into_iter().collect())
    }
}

/// Compatibility API: callers requesting one memo retain the original shape.
#[wasm_bindgen]
pub fn decrypt_memo(tx_hex: &str, viewing_key: &str) -> Result<String, String> {
    let session = ScanSession::new(viewing_key)?;
    let outputs = session.memo_outputs(tx_hex)?;
    let output = outputs.first().ok_or("No memo found or viewing key doesn't match any outputs.")?;
    serde_json::to_string(&DecryptedOutput { memo: output.memo.clone(), amount: output.amount })
        .map_err(|e| e.to_string())
}

/// Decrypt a compact block output (from Lightwalletd)
/// This is MUCH faster than decrypt_memo because it doesn't need the full TX
#[wasm_bindgen]
pub fn decrypt_compact_output(
    nullifier_hex: &str,
    cmx_hex: &str,
    ephemeral_key_hex: &str,
    ciphertext_hex: &str,
    viewing_key: &str,
) -> Result<String, String> {
    if viewing_key.len() > 4096 { return Err("Viewing key exceeds size limit".into()); }
    for (field, bytes) in [(nullifier_hex, 32), (cmx_hex, 32), (ephemeral_key_hex, 32), (ciphertext_hex, 52)] {
        if field.len() != bytes * 2 { return Err("Invalid compact field length".into()); }
    }
    // Step 1: Parse UFVK
    let (_network, ufvk) = Ufvk::decode(viewing_key)
        .map_err(|e| format!("UFVK decode failed: {:?}", e))?;

    // Step 2: Extract Orchard FVK
    let orchard_fvk_bytes = ufvk.items().iter().find_map(|fvk| {
        match fvk {
            Fvk::Orchard(data) => Some(*data),
            _ => None,
        }
    }).ok_or("No Orchard FVK found in UFVK")?;

    // Step 3: Parse FullViewingKey
    let fvk = FullViewingKey::from_bytes(&orchard_fvk_bytes)
        .ok_or("FVK parse failed")?;

    // Step 4: Parse compact output data
    let nullifier_bytes = hex::decode(nullifier_hex)
        .map_err(|e| format!("Nullifier hex decode failed: {:?}", e))?;
    let cmx_bytes = hex::decode(cmx_hex)
        .map_err(|e| format!("CMX hex decode failed: {:?}", e))?;
    let ephemeral_key_bytes = hex::decode(ephemeral_key_hex)
        .map_err(|e| format!("Ephemeral key hex decode failed: {:?}", e))?;
    let ciphertext_bytes = hex::decode(ciphertext_hex)
        .map_err(|e| format!("Ciphertext hex decode failed: {:?}", e))?;

    // Step 5: Convert to proper types
    let nullifier_array: [u8; 32] = nullifier_bytes.try_into().map_err(|_| "Invalid nullifier length")?;
    let nullifier = orchard::note::Nullifier::from_bytes(&nullifier_array)
        .into_option()
        .ok_or("Invalid nullifier")?;

    let cmx_array: [u8; 32] = cmx_bytes.try_into().map_err(|_| "Invalid CMX length")?;
    let cmx = ExtractedNoteCommitment::from_bytes(&cmx_array)
        .into_option()
        .ok_or("Invalid CMX")?;

    let ephemeral_key_array: [u8; 32] = ephemeral_key_bytes.try_into().map_err(|_| "Invalid ephemeral key length")?;

    // Ciphertext should be 52 bytes for compact format
    if ciphertext_bytes.len() != 52 {
        return Err(format!("Invalid ciphertext length: expected 52, got {}", ciphertext_bytes.len()));
    }
    let ciphertext: [u8; 52] = ciphertext_bytes.try_into().unwrap();

    // Step 6: Create CompactAction with real nullifier
    let compact_action = CompactAction::from_parts(
        nullifier,
        cmx,
        ephemeral_key_array.into(),
        ciphertext,
    );

    // Step 7: Try to decrypt with both External and Internal scopes,
    // using both OrchardDomain (lead byte 0x02) and IronwoodDomain (0x03).
    for scope in [Scope::External, Scope::Internal] {
        let ivk = fvk.to_ivk(scope);
        let prepared_ivk = PreparedIncomingViewingKey::new(&ivk);

        let orchard_domain = OrchardDomain::for_compact_action(&compact_action);
        let ironwood_domain = IronwoodDomain::for_compact_action(&compact_action);

        let result = try_compact_note_decryption(&orchard_domain, &prepared_ivk, &compact_action)
            .or_else(|| try_compact_note_decryption(&ironwood_domain, &prepared_ivk, &compact_action));

        if let Some((note, _recipient)) = result {
            let amount_zatoshis = note.value().inner();
            let amount_zec = amount_zatoshis as f64 / 100_000_000.0;

            let output = DecryptedOutput {
                memo: "[Compact block - memo not available]".to_string(),
                amount: amount_zec,
            };

            return serde_json::to_string(&output)
                .map_err(|e| format!("JSON serialization failed: {:?}", e));
        }
    }

    Err("No memo found or viewing key doesn't match this output.".to_string())
}

/// Batch filter compact outputs (MUCH FASTER!)
/// Takes JSON array of outputs and returns JSON array of matching indices
#[wasm_bindgen]
pub fn batch_filter_compact_outputs(
    outputs_json: &str,
    viewing_key: &str,
) -> Result<String, String> {
    // Parse JSON input: array of {nullifier, cmx, ephemeralKey, ciphertext, txid, height}
    #[derive(serde::Deserialize)]
    struct CompactOutput {
        #[serde(default)]
        pool: Option<String>,
        nullifier: String,
        cmx: String,
        ephemeral_key: String,
        ciphertext: String,
        txid: String,
        height: u64,
    }

    if outputs_json.len() > MAX_COMPACT_JSON_BYTES { return Err("Compact JSON exceeds 4 MB limit".into()); }
    let outputs: Vec<CompactOutput> = serde_json::from_str(outputs_json)
        .map_err(|e| format!("Failed to parse outputs JSON: {:?}", e))?;

    if outputs.len() > MAX_COMPACT_OUTPUTS { return Err("Too many compact outputs (maximum 4096 per call)".into()); }
    let session = ScanSession::new(viewing_key)?;
    let mut bytes = Vec::with_capacity(outputs.len() * 149);
    for output in &outputs {
        bytes.push(match output.pool.as_deref() {
            None => 0, Some("orchard") => 1, Some("ironwood") => 2,
            _ => return Err("Invalid compact pool".into()),
        });
        for (value, length) in [(&output.nullifier, 32), (&output.cmx, 32), (&output.ephemeral_key, 32), (&output.ciphertext, 52)] {
            if value.len() != length * 2 { return Err("Invalid compact field length".into()); }
            let decoded = hex::decode(value).map_err(|e| e.to_string())?;
            if decoded.len() != length { return Err("Invalid compact field length".into()); }
            bytes.extend_from_slice(&decoded);
        }
    }
    #[derive(Serialize)]
    struct Match { index: usize, txid: String, height: u64, scope: &'static str }
    let matches: Vec<_> = session.filter_records(&bytes)?.into_iter().map(|(index, scope)| Match {
        index, txid: outputs[index].txid.clone(), height: outputs[index].height,
        scope: if scope == 0 { "External" } else { "Internal" },
    }).collect();
    serde_json::to_string(&matches).map_err(|e| e.to_string())
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use orchard::{keys::SpendingKey, note::{NoteVersion, RandomSeed, Rho}, value::NoteValue, Note};
    use orchard::note_encryption::{OrchardNoteEncryption, IronwoodNoteEncryption};
    use zcash_note_encryption::Domain;

    fn fixture() -> (String, Vec<u8>, Vec<u8>) {
        fixture_for(zcash_protocol::consensus::BranchId::Nu6_3, true)
    }

    // Public deterministic test-only keys; proof/signature bytes are placeholders.
    // These are decryption/encoding fixtures, never consensus-valid transactions.
    fn fixture_for(branch: zcash_protocol::consensus::BranchId, v6: bool) -> (String, Vec<u8>, Vec<u8>) {
        let sk = SpendingKey::from_bytes([7; 32]).unwrap();
        let fvk = FullViewingKey::from(&sk);
        let key = Ufvk::try_from_items(vec![Fvk::Orchard(fvk.to_bytes())]).unwrap()
            .encode(&zcash_protocol::consensus::NetworkType::Main);
        let mut records = Vec::new();
        let mut raw_actions = Vec::new();
        for (index, (scope, version)) in [(Scope::External, NoteVersion::V2), (Scope::Internal, NoteVersion::V3)].into_iter().enumerate() {
            let rho = Rho::from_bytes(&[0; 32]).unwrap();
            let seed = RandomSeed::from_bytes([index as u8 + 1; 32], &rho).unwrap();
            let note = Note::from_parts(fvk.address_at(0u32, scope), NoteValue::from_raw(123 + index as u64), rho, seed, version).unwrap();
            let cmx = ExtractedNoteCommitment::from(note.commitment()).to_bytes();
            let mut memo = [0; 512];
            memo[..5].copy_from_slice(b"hello");
            let (epk, ciphertext) = if index == 0 {
                let enc = OrchardNoteEncryption::new(None, note, memo);
                (OrchardDomain::epk_bytes(enc.epk()).0, enc.encrypt_note_plaintext())
            } else {
                let enc = IronwoodNoteEncryption::new(None, note, memo);
                (IronwoodDomain::epk_bytes(enc.epk()).0, enc.encrypt_note_plaintext())
            };
            records.push(index as u8 + 1);
            records.extend_from_slice(&[0; 32]);
            records.extend_from_slice(&cmx);
            records.extend_from_slice(&epk);
            records.extend_from_slice(&ciphertext[..52]);
            let mut raw = vec![0; 64]; // cv, nullifier
            use orchard::primitives::redpallas::{SigningKey, VerificationKey, SpendAuth};
            let signing = SigningKey::<SpendAuth>::try_from([1; 32]).unwrap();
            let rk: [u8; 32] = VerificationKey::from(&signing).into();
            raw.extend_from_slice(&rk);
            raw.extend_from_slice(&cmx);
            raw.extend_from_slice(&epk);
            raw.extend_from_slice(&ciphertext);
            raw.extend_from_slice(&[0; 80]);
            raw_actions.push(raw);
        }
        let mut tx = vec![0; 20];
        tx[..4].copy_from_slice(&(if v6 { 0x8000_0006u32 } else { 0x8000_0005u32 }).to_le_bytes());
        tx[4..8].copy_from_slice(&(if v6 { zcash_protocol::constants::V6_VERSION_GROUP_ID } else { zcash_protocol::constants::V5_VERSION_GROUP_ID }).to_le_bytes());
        tx[8..12].copy_from_slice(&u32::from(branch).to_le_bytes());
        tx.extend_from_slice(&[0, 0, 0, 0]); // transparent, Sapling
        for raw in raw_actions.iter().take(if v6 { 2 } else { 1 }) {
            tx.push(1); // action count
            tx.extend_from_slice(raw);
            tx.push(3); // enable spends/outputs, no cross-address flag
            tx.extend_from_slice(&[0; 40]); // balance, anchor
            let proof_size = orchard::Proof::expected_proof_size(1);
            tx.push(253);
            tx.extend_from_slice(&(proof_size as u16).to_le_bytes());
            tx.extend(vec![0; proof_size]);
            tx.extend_from_slice(&[0; 128]); // action and binding signatures
        }
        (key, records, tx)
    }

    #[test]
    fn tagged_and_legacy_match_both_pools_and_scopes() {
        let (key, records, _) = fixture();
        let session = ScanSession::new(&key).unwrap();
        assert_eq!(session.filter_records(&records).unwrap(), vec![(0, 0), (1, 1)]);
        let mut legacy = records.clone();
        legacy[0] = 0; legacy[149] = 0;
        assert_eq!(session.filter_records(&legacy).unwrap(), vec![(0, 0), (1, 1)]);
        let mut wrong = records;
        wrong[0] = 2; wrong[149] = 1;
        assert!(session.filter_compact(&wrong).unwrap().is_empty());
    }

    #[test]
    fn multiple_memos_and_legacy_return_shape() {
        let (key, _, tx) = fixture();
        let session = ScanSession::new(&key).unwrap();
        let outputs = session.memo_outputs(&hex::encode(&tx)).unwrap();
        assert_eq!(outputs.len(), 2);
        assert_eq!((outputs[0].output_index, outputs[0].pool, outputs[0].amount_zatoshis), (0, "orchard", 123));
        assert_eq!((outputs[1].output_index, outputs[1].pool, outputs[1].amount_zatoshis), (1, "ironwood", 124));
        let legacy: serde_json::Value = serde_json::from_str(&decrypt_memo(&hex::encode(tx), &key).unwrap()).unwrap();
        assert_eq!(legacy.as_object().unwrap().len(), 2);
        assert_eq!(legacy["memo"], "hello");
    }

    #[test]
    fn malformed_records_and_nonmatching_key() {
        let (key, mut records, _) = fixture();
        let session = ScanSession::new(&key).unwrap();
        assert!(session.filter_compact(&records[..148]).is_err());
        records[0] = 3;
        assert!(session.filter_compact(&records).is_err());
        assert!(session.filter_compact(&[]).unwrap().is_empty());
        assert!(ScanSession::new("invalid").is_err());
        let other = FullViewingKey::from(&SpendingKey::from_bytes([8; 32]).unwrap());
        let other_key = Ufvk::try_from_items(vec![Fvk::Orchard(other.to_bytes())]).unwrap().encode(&zcash_protocol::consensus::NetworkType::Main);
        records[0] = 1;
        assert!(ScanSession::new(&other_key).unwrap().filter_compact(&records).unwrap().is_empty());
    }

    #[test]
    fn parses_real_versions_and_keeps_consensus_branch() {
        use zcash_protocol::consensus::BranchId;
        for (branch, v6) in [(BranchId::Nu5, false), (BranchId::Nu6_2, false),
            (BranchId::Nu6_3, false), (BranchId::Nu7, false),
            (BranchId::Nu6_3, true), (BranchId::Nu7, true)] {
            let (key, _, tx) = fixture_for(branch, v6);
            assert_eq!(u32::from_le_bytes(tx[8..12].try_into().unwrap()), u32::from(branch));
            let outputs = ScanSession::new(&key).unwrap().memo_outputs(&hex::encode(&tx)).unwrap();
            assert_eq!(outputs.len(), if v6 { 2 } else { 1 });
        }
    }

    #[test]
    fn public_zip244_vector_retains_expected_txid_and_complete_encoding() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../packages/zcash-decoder/test/fixtures/zip244.json")).unwrap();
        let bytes = hex::decode(fixture["tx"].as_str().unwrap()).unwrap();
        assert!(parse_orchard_actions(&bytes).is_ok());
        let tx = zcash_primitives::transaction::Transaction::read(&bytes[..], zcash_protocol::consensus::BranchId::Nu5).unwrap();
        assert_eq!(hex::encode(tx.txid().as_ref()), fixture["txid_bytes"]);
        let mut serialized = Vec::new(); tx.write(&mut serialized).unwrap();
        assert_eq!(bytes, serialized);
    }

    #[test]
    fn complete_sapling_only_transaction_reports_unsupported_pool() {
        use zcash_primitives::transaction::{Transaction, TransactionData, TxVersion};
        use zcash_protocol::consensus::BranchId;
        let public: serde_json::Value = serde_json::from_str(include_str!("../../packages/zcash-decoder/test/fixtures/zip244.json")).unwrap();
        let bytes = hex::decode(public["tx"].as_str().unwrap()).unwrap();
        let tx = Transaction::read(&bytes[..], BranchId::Nu5).unwrap();
        assert!(tx.sapling_bundle().is_some());
        let only_sapling = TransactionData::from_parts(TxVersion::V5, BranchId::Nu5,
            tx.lock_time(), tx.expiry_height(), tx.transparent_bundle().cloned(), None,
            tx.sapling_bundle().cloned(), None).freeze().unwrap();
        let mut encoded = Vec::new(); only_sapling.write(&mut encoded).unwrap();
        assert!(parse_orchard_actions(&encoded).unwrap().0.is_empty());
        let (key, _, _) = fixture();
        let error = ScanSession::new(&key).unwrap().memo_outputs(&hex::encode(encoded)).err().unwrap();
        assert!(error.contains("Sapling"));
    }

    #[test]
    fn rejects_malformed_wire_data_without_panicking() {
        let (_, _, tx) = fixture();
        for length in (0..tx.len()).step_by(17).chain(0..25).chain(tx.len()-128..tx.len()) {
            assert!(parse_orchard_actions(&tx[..length]).is_err(), "truncated at {length}");
        }
        let mut bad = tx.clone(); bad.push(0);
        assert!(parse_orchard_actions(&bad).is_err());
        for (offset, value) in [(0, 7), (4, 0), (8, 0xff)] {
            let mut bad = tx.clone(); bad[offset] = value;
            assert!(parse_orchard_actions(&bad).is_err());
        }
        for compact in [vec![253, 0, 0], vec![254, 0xff, 0xff, 0xff, 0xff], vec![255, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]] {
            let mut bad = tx[..20].to_vec(); bad.extend(compact);
            assert!(parse_orchard_actions(&bad).is_err());
        }
        let mut bad = tx; bad[24] = 253; bad.insert(25, 1); bad.insert(26, 0);
        assert!(parse_orchard_actions(&bad).is_err());
        assert!(parse_orchard_actions(&vec![0; MAX_TX_BYTES+1]).is_err());
    }

    #[test]
    fn sapling_receiver_has_no_fabricated_payment_address() {
        for network in [zcash_protocol::consensus::NetworkType::Main, zcash_protocol::consensus::NetworkType::Test] {
            let address = UnifiedAddress::try_from_items(vec![Receiver::Sapling([0; 43])]).unwrap().encode(&network);
            let decoded: serde_json::Value = serde_json::from_str(&decode_unified_address(&address).unwrap()).unwrap();
            assert_eq!(decoded["has_sapling"], true);
            assert!(decoded["sapling_address"].is_null());
        }
    }

    #[test]
    fn export_public_synthetic_fixture_when_requested() {
        if let Ok(path) = std::env::var("SCAN_FIXTURE_PATH") {
            let (key, records, tx) = fixture();
            let (_, _, v5) = fixture_for(zcash_protocol::consensus::BranchId::Nu5, false);
            let (_, _, nu7) = fixture_for(zcash_protocol::consensus::BranchId::Nu7, true);
            std::fs::write(path, serde_json::json!({ "key": key, "records": records, "tx": hex::encode(tx), "tx_v5": hex::encode(v5), "tx_nu7": hex::encode(nu7) }).to_string()).unwrap();
        }
    }
}
