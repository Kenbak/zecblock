//! Compact binary explorer transaction record: the fields `/api/tx/:txid`
//! serves from PostgreSQL (transaction row, transparent inputs and outputs),
//! without raw transaction bytes. Shared by the native builder and clients.
//!
//! Integers are LEB128 varints (signed values zigzag). Hashes are 32 raw
//! bytes of their hex form. Standard t1/t3 addresses are stored as their
//! 20-byte hash and re-encoded with base58check; anything else is kept raw.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const RECORD_VERSION: u8 = 1;
const P2PKH: [u8; 2] = [0x1c, 0xb8];
const P2SH: [u8; 2] = [0x1c, 0xbd];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Input {
    pub index: u32,
    pub prev_txid: Option<[u8; 32]>,
    pub prev_vout: Option<u32>,
    pub address: Option<String>,
    pub value: Option<i64>,
    pub coinbase: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Output {
    pub index: u32,
    pub value: Option<i64>,
    pub address: Option<String>,
    pub spent: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Record {
    pub txid: [u8; 32],
    pub height: u32,
    pub tx_index: Option<u32>,
    pub block_hash: [u8; 32],
    pub block_time: u64,
    pub size: Option<u32>,
    pub version: Option<i64>,
    pub locktime: Option<i64>,
    pub expiry_height: Option<i64>,
    pub fee: Option<i64>,
    pub total_input: Option<i64>,
    pub total_output: Option<i64>,
    pub value_balance: Option<i64>,
    pub value_balance_sapling: Option<i64>,
    pub value_balance_orchard: Option<i64>,
    pub value_balance_ironwood: Option<i64>,
    pub is_coinbase: bool,
    pub has_sapling: bool,
    pub has_orchard: bool,
    pub has_ironwood: bool,
    pub has_sprout: bool,
    pub orchard_actions: u32,
    pub ironwood_actions: u32,
    pub sapling_spend_count: u32,
    pub sapling_output_count: u32,
    pub vin_count: Option<u32>,
    pub vout_count: Option<u32>,
    pub orchard_anchor: Option<[u8; 32]>,
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
}

// ---- varints -------------------------------------------------------------

fn put(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_signed(out: &mut Vec<u8>, value: i64) {
    put(out, ((value << 1) ^ (value >> 63)) as u64);
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, String> {
        let byte = *self.bytes.get(self.at).ok_or("truncated record")?;
        self.at += 1;
        Ok(byte)
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(len).filter(|&end| end <= self.bytes.len()).ok_or("truncated record")?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }
    fn hash(&mut self) -> Result<[u8; 32], String> {
        Ok(self.take(32)?.try_into().unwrap())
    }
    fn var(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("varint too long".into())
    }
    fn var32(&mut self) -> Result<u32, String> {
        u32::try_from(self.var()?).map_err(|_| "varint exceeds u32".into())
    }
    fn signed(&mut self) -> Result<i64, String> {
        let raw = self.var()?;
        Ok(((raw >> 1) as i64) ^ -((raw & 1) as i64))
    }
}

// ---- base58check t-addresses ----------------------------------------------

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn checksum(payload: &[u8]) -> [u8; 4] {
    let digest = Sha256::digest(Sha256::digest(payload));
    digest[..4].try_into().unwrap()
}

fn base58_encode(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for &byte in bytes {
        let mut carry = u32::from(byte);
        for digit in digits.iter_mut() {
            carry += u32::from(*digit) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat_n('1', zeros));
    out.extend(digits.iter().rev().map(|&d| ALPHABET[d as usize] as char));
    out
}

fn base58_decode(text: &str) -> Option<Vec<u8>> {
    let zeros = text.bytes().take_while(|&b| b == b'1').count();
    let mut bytes: Vec<u8> = Vec::new();
    for c in text.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c)? as u32;
        for byte in bytes.iter_mut() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev());
    Some(out)
}

/// 1 = t1 (P2PKH), 2 = t3 (P2SH), with the 20-byte hash; None keeps the string.
fn compact_address(address: &str) -> Option<(u8, [u8; 20])> {
    let decoded = base58_decode(address)?;
    if decoded.len() != 26 || checksum(&decoded[..22]) != decoded[22..] {
        return None;
    }
    let kind = match [decoded[0], decoded[1]] {
        P2PKH => 1,
        P2SH => 2,
        _ => return None,
    };
    let hash: [u8; 20] = decoded[2..22].try_into().unwrap();
    // Only canonical encodings are compacted, so decoding reproduces the input.
    (expand_address(kind, &hash) == address).then_some((kind, hash))
}

fn expand_address(kind: u8, hash: &[u8; 20]) -> String {
    let mut payload = Vec::with_capacity(26);
    payload.extend_from_slice(if kind == 1 { &P2PKH } else { &P2SH });
    payload.extend_from_slice(hash);
    let sum = checksum(&payload);
    payload.extend_from_slice(&sum);
    base58_encode(&payload)
}

fn put_address(out: &mut Vec<u8>, address: &str) -> u8 {
    match compact_address(address) {
        Some((kind, hash)) => {
            out.extend_from_slice(&hash);
            kind
        }
        None => {
            put(out, address.len() as u64);
            out.extend_from_slice(address.as_bytes());
            0
        }
    }
}

fn read_address(reader: &mut Reader, kind: u8) -> Result<String, String> {
    if kind == 0 {
        let len = reader.var()? as usize;
        String::from_utf8(reader.take(len)?.to_vec()).map_err(|_| "address is not UTF-8".into())
    } else {
        Ok(expand_address(kind, &reader.take(20)?.try_into().unwrap()))
    }
}

// ---- record ----------------------------------------------------------------

const OPTIONALS: usize = 15;

impl Record {
    fn optionals(&self) -> [Option<i64>; OPTIONALS] {
        [
            self.tx_index.map(i64::from),
            self.size.map(i64::from),
            self.version,
            self.locktime,
            self.expiry_height,
            self.fee,
            self.total_input,
            self.total_output,
            self.value_balance,
            self.value_balance_sapling,
            self.value_balance_orchard,
            self.value_balance_ironwood,
            self.vin_count.map(i64::from),
            self.vout_count.map(i64::from),
            self.orchard_anchor.map(|_| 0),
        ]
    }

    /// Encodes everything except the txid, which the row tag and the client's
    /// own lookup key already carry.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(160);
        out.push(RECORD_VERSION);
        let optionals = self.optionals();
        let presence = optionals.iter().enumerate().fold(0u16, |bits, (i, v)| bits | (u16::from(v.is_some()) << i));
        out.extend_from_slice(&presence.to_le_bytes());
        put(&mut out, u64::from(self.height));
        put(&mut out, self.block_time);
        out.extend_from_slice(&self.block_hash);
        for value in optionals[..OPTIONALS - 1].iter().flatten() {
            put_signed(&mut out, *value);
        }
        if let Some(anchor) = &self.orchard_anchor {
            out.extend_from_slice(anchor);
        }
        out.push(
            u8::from(self.is_coinbase)
                | u8::from(self.has_sapling) << 1
                | u8::from(self.has_orchard) << 2
                | u8::from(self.has_ironwood) << 3
                | u8::from(self.has_sprout) << 4,
        );
        for count in [self.orchard_actions, self.ironwood_actions, self.sapling_spend_count, self.sapling_output_count] {
            put(&mut out, u64::from(count));
        }
        put(&mut out, self.inputs.len() as u64);
        for input in &self.inputs {
            let at = out.len();
            out.push(0);
            put(&mut out, u64::from(input.index));
            let mut kind = 0u8;
            if let Some(prev) = &input.prev_txid {
                kind |= 1;
                out.extend_from_slice(prev);
            }
            if let Some(vout) = input.prev_vout {
                kind |= 2;
                put(&mut out, u64::from(vout));
            }
            if let Some(address) = &input.address {
                kind |= 4 | put_address(&mut out, address) << 5;
            }
            if let Some(value) = input.value {
                kind |= 8;
                put_signed(&mut out, value);
            }
            if let Some(coinbase) = &input.coinbase {
                kind |= 16;
                put(&mut out, coinbase.len() as u64);
                out.extend_from_slice(coinbase);
            }
            out[at] = kind;
        }
        put(&mut out, self.outputs.len() as u64);
        for output in &self.outputs {
            let at = out.len();
            out.push(0);
            put(&mut out, u64::from(output.index));
            let mut kind = u8::from(output.spent) << 2;
            if let Some(value) = output.value {
                kind |= 1;
                put_signed(&mut out, value);
            }
            if let Some(address) = &output.address {
                kind |= 2 | put_address(&mut out, address) << 5;
            }
            out[at] = kind;
        }
        out
    }

    /// The record with only its first inputs and outputs, as many as fit in
    /// `max` bytes. `vin_count`/`vout_count` keep the full counts, so a reader
    /// knows the lists were cut. Never shorter than the zero-list form.
    pub fn preview(&self, max: usize) -> Vec<u8> {
        let mut cut = self.clone();
        cut.vin_count = Some(self.vin_count.unwrap_or(self.inputs.len() as u32));
        cut.vout_count = Some(self.vout_count.unwrap_or(self.outputs.len() as u32));
        let encode = |keep: usize, cut: &mut Record| {
            cut.inputs = self.inputs[..keep.min(self.inputs.len())].to_vec();
            cut.outputs = self.outputs[..keep.min(self.outputs.len())].to_vec();
            cut.encode()
        };
        let (mut low, mut high) = (0, self.inputs.len().max(self.outputs.len()));
        while low < high {
            let mid = (low + high + 1) / 2;
            if encode(mid, &mut cut).len() <= max { low = mid } else { high = mid - 1 }
        }
        encode(low, &mut cut)
    }

    pub fn decode(txid: [u8; 32], bytes: &[u8]) -> Result<Self, String> {
        let mut r = Reader { bytes, at: 0 };
        if r.byte()? != RECORD_VERSION {
            return Err("unsupported record version".into());
        }
        let presence = u16::from_le_bytes([r.byte()?, r.byte()?]);
        let height = r.var32()?;
        let block_time = r.var()?;
        let block_hash = r.hash()?;
        let mut values = [None; OPTIONALS - 1];
        for (i, slot) in values.iter_mut().enumerate() {
            if presence & (1 << i) != 0 {
                *slot = Some(r.signed()?);
            }
        }
        let as_u32 = |v: Option<i64>| v.map(|v| u32::try_from(v).map_err(|_| "field exceeds u32")).transpose();
        let orchard_anchor = if presence & (1 << (OPTIONALS - 1)) != 0 { Some(r.hash()?) } else { None };
        let flags = r.byte()?;
        let mut counts = [0u32; 4];
        for count in &mut counts {
            *count = r.var32()?;
        }
        let mut record = Record {
            txid,
            height,
            tx_index: as_u32(values[0])?,
            block_hash,
            block_time,
            size: as_u32(values[1])?,
            version: values[2],
            locktime: values[3],
            expiry_height: values[4],
            fee: values[5],
            total_input: values[6],
            total_output: values[7],
            value_balance: values[8],
            value_balance_sapling: values[9],
            value_balance_orchard: values[10],
            value_balance_ironwood: values[11],
            is_coinbase: flags & 1 != 0,
            has_sapling: flags & 2 != 0,
            has_orchard: flags & 4 != 0,
            has_ironwood: flags & 8 != 0,
            has_sprout: flags & 16 != 0,
            orchard_actions: counts[0],
            ironwood_actions: counts[1],
            sapling_spend_count: counts[2],
            sapling_output_count: counts[3],
            vin_count: as_u32(values[12])?,
            vout_count: as_u32(values[13])?,
            orchard_anchor,
            inputs: Vec::new(),
            outputs: Vec::new(),
        };
        for _ in 0..r.var()? {
            let kind = r.byte()?;
            let mut input = Input { index: r.var32()?, ..Input::default() };
            if kind & 1 != 0 {
                input.prev_txid = Some(r.hash()?);
            }
            if kind & 2 != 0 {
                input.prev_vout = Some(r.var32()?);
            }
            if kind & 4 != 0 {
                input.address = Some(read_address(&mut r, kind >> 5)?);
            }
            if kind & 8 != 0 {
                input.value = Some(r.signed()?);
            }
            if kind & 16 != 0 {
                let len = r.var()? as usize;
                input.coinbase = Some(r.take(len)?.to_vec());
            }
            record.inputs.push(input);
        }
        for _ in 0..r.var()? {
            let kind = r.byte()?;
            let mut output = Output { index: r.var32()?, spent: kind & 4 != 0, ..Output::default() };
            if kind & 1 != 0 {
                output.value = Some(r.signed()?);
            }
            if kind & 2 != 0 {
                output.address = Some(read_address(&mut r, kind >> 5)?);
            }
            record.outputs.push(output);
        }
        if r.at != bytes.len() {
            return Err("trailing record bytes".into());
        }
        Ok(record)
    }

    /// The same field names and exact zatoshi strings as `/api/tx/:txid`.
    /// Confirmations need the reader's current tip, so the caller adds them.
    pub fn to_json(&self) -> Value {
        let zat = |v: Option<i64>| v.map(|v| v.to_string());
        let coinbase = self.inputs.iter().find_map(|i| i.coinbase.as_ref());
        json!({
            "txid": hex::encode(self.txid),
            "blockHeight": self.height,
            "blockHash": hex::encode(self.block_hash),
            "blockTime": self.block_time,
            "status": "confirmed",
            "size": self.size,
            "version": self.version,
            "locktime": self.locktime,
            "expiryHeight": self.expiry_height,
            "txIndex": self.tx_index,
            "feeZat": zat(self.fee),
            "totalInputZat": zat(self.total_input),
            "totalOutputZat": zat(self.total_output),
            "valueBalanceZat": zat(self.value_balance),
            "valueBalanceSaplingZat": zat(self.value_balance_sapling),
            "valueBalanceOrchardZat": zat(self.value_balance_orchard),
            "valueBalanceIronwoodZat": zat(self.value_balance_ironwood),
            "isCoinbase": self.is_coinbase,
            "hasSapling": self.has_sapling,
            "hasOrchard": self.has_orchard,
            "hasIronwood": self.has_ironwood,
            "hasSprout": self.has_sprout,
            "orchardActions": self.orchard_actions,
            "ironwoodActions": self.ironwood_actions,
            "saplingSpendCount": self.sapling_spend_count,
            "saplingOutputCount": self.sapling_output_count,
            "vinCount": self.vin_count,
            "voutCount": self.vout_count,
            "orchardAnchor": self.orchard_anchor.map(hex::encode),
            "inputs": self.inputs.iter().map(|i| json!({
                "vout_index": i.index,
                "prev_txid": i.prev_txid.map(hex::encode),
                "prev_vout": i.prev_vout,
                "address": i.address,
                "value": zat(i.value),
            })).collect::<Vec<_>>(),
            "outputs": self.outputs.iter().map(|o| json!({
                "vout_index": o.index,
                "address": o.address,
                "value": zat(o.value),
                "spent": o.spent,
            })).collect::<Vec<_>>(),
            "inputCount": self.inputs.len(),
            "outputCount": self.outputs.len(),
            "coinbaseHex": coinbase.map(hex::encode),
        })
    }
}

// ---- export parsing -----------------------------------------------------------

fn hash_field(field: &str) -> Result<[u8; 32], String> {
    hex::decode(field).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| format!("bad hash {field}"))
}

fn null(field: &str) -> Option<&str> {
    (field != "\\N" && !field.is_empty()).then_some(field)
}

fn opt<T: std::str::FromStr>(field: &str) -> Result<Option<T>, String> {
    null(field).map(|f| f.parse().map_err(|_| format!("bad number {f}"))).transpose()
}

fn flag(field: &str) -> bool {
    field == "t"
}

/// Parses one line of the replica export (see `chunk.sql`).
pub fn parse_export_line(line: &str) -> Result<Record, String> {
    let f: Vec<&str> = line.split('\t').collect();
    if f.len() != 30 {
        return Err(format!("expected 30 columns, found {}", f.len()));
    }
    let mut record = Record {
        txid: hash_field(f[0])?,
        height: f[1].parse().map_err(|_| "bad height")?,
        tx_index: opt(f[2])?,
        block_hash: hash_field(f[3])?,
        block_time: f[4].parse().map_err(|_| "bad block time")?,
        size: opt(f[5])?,
        version: opt(f[6])?,
        locktime: opt(f[7])?,
        expiry_height: opt(f[8])?,
        fee: opt(f[9])?,
        total_input: opt(f[10])?,
        total_output: opt(f[11])?,
        value_balance: opt(f[12])?,
        value_balance_sapling: opt(f[13])?,
        value_balance_orchard: opt(f[14])?,
        value_balance_ironwood: opt(f[15])?,
        is_coinbase: flag(f[16]),
        has_sapling: flag(f[17]),
        has_orchard: flag(f[18]),
        has_ironwood: flag(f[19]),
        has_sprout: flag(f[20]),
        orchard_actions: opt(f[21])?.unwrap_or(0),
        ironwood_actions: opt(f[22])?.unwrap_or(0),
        sapling_spend_count: opt(f[23])?.unwrap_or(0),
        sapling_output_count: opt(f[24])?.unwrap_or(0),
        vin_count: opt(f[25])?,
        vout_count: opt(f[26])?,
        orchard_anchor: null(f[27]).map(hash_field).transpose()?,
        inputs: Vec::new(),
        outputs: Vec::new(),
    };
    if let Some(items) = null(f[28]) {
        for item in items.split('\u{1e}') {
            let p: Vec<&str> = item.split('\u{1f}').collect();
            if p.len() != 6 {
                return Err("bad input item".into());
            }
            record.inputs.push(Input {
                index: p[0].parse().map_err(|_| "bad input index")?,
                prev_txid: null(p[1]).map(hash_field).transpose()?,
                prev_vout: opt(p[2])?,
                address: null(p[3]).map(str::to_owned),
                value: opt(p[4])?,
                coinbase: null(p[5]).map(|c| hex::decode(c).map_err(|_| "bad coinbase hex")).transpose()?,
            });
        }
    }
    if let Some(items) = null(f[29]) {
        for item in items.split('\u{1e}') {
            let p: Vec<&str> = item.split('\u{1f}').collect();
            if p.len() != 4 {
                return Err("bad output item".into());
            }
            record.outputs.push(Output {
                index: p[0].parse().map_err(|_| "bad output index")?,
                value: opt(p[1])?,
                address: null(p[2]).map(str::to_owned),
                spent: p[3] == "1",
            });
        }
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_round_trip_and_compact() {
        for address in ["t1Zu7BQydS88AirjzuJ53Xng9JmdtCuappB", "t1aTey5i7FzJQ2FC238SomgzMfbZxXBWPMX"] {
            let (kind, hash) = compact_address(address).expect("standard address compacts");
            assert_eq!(expand_address(kind, &hash), address);
        }
        assert!(compact_address("t1Zu7BQydS88AirjzuJ53Xng9JmdtCuappC").is_none());
        assert!(compact_address("not-an-address").is_none());
    }

    #[test]
    fn record_round_trips_with_nulls_inputs_outputs_and_coinbase() {
        let line = [
            "ab".repeat(32).as_str(), "3400551", "7", &"cd".repeat(32), "1760000000", "835", "5", "0", "3400591",
            "10000", "\\N", "200000", "-5000", "0", "-5000", "\\N", "f", "t", "t", "f", "f", "2", "0", "1", "2", "1", "2",
            &"ef".repeat(32),
            &format!("0\u{1f}{}\u{1f}3\u{1f}t1Zu7BQydS88AirjzuJ53Xng9JmdtCuappB\u{1f}210000\u{1f}\u{1e}1\u{1f}\u{1f}\u{1f}\u{1f}\u{1f}0401", "12".repeat(32)),
            "0\u{1f}100000\u{1f}t1aTey5i7FzJQ2FC238SomgzMfbZxXBWPMX\u{1f}1\u{1e}1\u{1f}100000\u{1f}weird-script\u{1f}0",
        ]
        .join("\t");
        let record = parse_export_line(&line).unwrap();
        assert_eq!(record.total_input, None);
        assert_eq!(record.value_balance_sapling, Some(0));
        let decoded = Record::decode(record.txid, &record.encode()).unwrap();
        assert_eq!(decoded, record);
        let json = decoded.to_json();
        assert_eq!(json["valueBalanceZat"], "-5000");
        assert_eq!(json["inputs"][0]["address"], "t1Zu7BQydS88AirjzuJ53Xng9JmdtCuappB");
        assert_eq!(json["outputs"][1]["address"], "weird-script");
        assert_eq!(json["coinbaseHex"], "0401");
    }

    #[test]
    fn preview_keeps_counts_and_fits() {
        let output = |index| Output { index, value: Some(1_000 + i64::from(index)), address: Some("t1aTey5i7FzJQ2FC238SomgzMfbZxXBWPMX".into()), spent: false };
        let record = Record { txid: [7; 32], height: 1, block_hash: [9; 32], block_time: 2, outputs: (0..500).map(output).collect(), ..Default::default() };
        let full = record.encode();
        let preview = record.preview(1_024);
        assert!(preview.len() <= 1_024 && preview.len() < full.len());
        let decoded = Record::decode(record.txid, &preview).unwrap();
        assert_eq!(decoded.vout_count, Some(500));
        assert!(!decoded.outputs.is_empty() && decoded.outputs.len() < 500);
        assert_eq!(decoded.outputs[..], record.outputs[..decoded.outputs.len()]);
        assert!(Record::decode(record.txid, &record.preview(1)).unwrap().outputs.is_empty());
    }

    #[test]
    fn bucket_entries_span_rows_and_previews_point_to_overflow() {
        use layout::*;
        let mut bucket = vec![0u8; 2 * PAYLOAD];
        let (a, b) = ([1u8; 32], [2u8; 32]);
        let first = vec![5u8; PAYLOAD];
        let second = preview_body(70_000, 40_000, b"cut");
        let mut at = BUCKET_HEADER;
        for (txid, body, flag) in [(a, &first, 0), (b, &second, PREVIEW_FLAG)] {
            bucket[at..at + TAG].copy_from_slice(&txid[..TAG]);
            bucket[at + TAG..at + ENTRY_HEADER].copy_from_slice(&(body.len() as u16 | flag).to_le_bytes());
            bucket[at + ENTRY_HEADER..at + ENTRY_HEADER + body.len()].copy_from_slice(body);
            at += ENTRY_HEADER + body.len();
        }
        bucket[..2].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(find(&bucket, &a).unwrap(), Entry::Inline(first));
        assert_eq!(find(&bucket, &b).unwrap(), Entry::Preview { preview: b"cut".to_vec(), start: 70_000, len: 40_000 });
        assert_eq!(find(&bucket, &[3u8; 32]).unwrap(), Entry::Absent);
        assert_eq!(overflow_rows(70_000, 40_000), 4..=6);
        assert_eq!(padded_rows(3), 4);
    }

    #[test]
    fn row_proofs_verify_and_reject_tampering() {
        use layout::*;
        let rows = 5;
        let payloads: Vec<Vec<u8>> = (0..rows).map(|r| vec![r as u8 + 1; PAYLOAD]).collect();
        let levels = merkle_levels(payloads.iter().enumerate().map(|(r, p)| leaf("main", 2, r as u32, p)).collect());
        let root = levels.last().unwrap()[0];
        for (r, payload) in payloads.iter().enumerate() {
            let mut row = payload.clone();
            row.extend(path(&levels, r));
            assert_eq!(verify_row("main", 2, r as u32, &row, &root, depth(rows)).unwrap(), &payload[..]);
            assert!(verify_row("main", 3, r as u32, &row, &root, depth(rows)).is_err());
            assert!(verify_row("overflow", 2, r as u32, &row, &root, depth(rows)).is_err());
            assert!(verify_row("main", 2, (r as u32 + 1) % rows as u32, &row, &root, depth(rows)).is_err());
            row[7] ^= 1;
            assert!(verify_row("main", 2, r as u32, &row, &root, depth(rows)).is_err());
        }
    }

    #[test]
    fn spent_markers_share_the_txid_bucket_without_matching_its_record() {
        use layout::*;
        let txid = [7u8; 32];
        let bitmap = spent_bitmap([0, 9, 1_252]);
        assert_eq!(spent_indices(&bitmap), vec![0, 9, 1_252]);
        let mut bucket = vec![0u8; PAYLOAD];
        bucket[..2].copy_from_slice(&1u16.to_le_bytes());
        let at = BUCKET_HEADER;
        bucket[at..at + TAG].copy_from_slice(&spent_tag(&txid));
        bucket[at + TAG..at + ENTRY_HEADER].copy_from_slice(&(bitmap.len() as u16).to_le_bytes());
        bucket[at + ENTRY_HEADER..at + ENTRY_HEADER + bitmap.len()].copy_from_slice(&bitmap);
        assert_eq!(find(&bucket, &txid).unwrap(), Entry::Absent);
        assert_eq!(find_spent(&bucket, &txid).unwrap(), Some(vec![0, 9, 1_252]));
        assert_eq!(find_spent(&bucket, &[8u8; 32]).unwrap(), None);
    }
}

// ---- table layout shared by builder, server and clients ----------------------

pub mod layout {
    //! A txid hashes to one bucket: the same local row in every main instance.
    //! Every lookup asks every instance for that row with one shared upload
    //! and gets all of them back, so the bucket spans `instances * ROW_BYTES`
    //! at no extra request cost. Bucket bytes: `[entries u16][reserved u16]`
    //! then entries `[tag 12][len u16 | PREVIEW_FLAG][body]`, which may cross
    //! row boundaries. A preview body is `[var start][var len][record preview]`
    //! pointing at the full record in the overflow table.
    //!
    //! Every row is `[payload PAYLOAD][Merkle path PROOF_BYTES]`: the path
    //! proves the payload against the instance's root in the signed manifest.
    //! It travels inside the row, so the one private query that returns a row
    //! also returns its proof; fetching a proof separately would reveal the row.
    //! Buckets and overflow offsets count payload bytes only.
    use sha2::{Digest, Sha256};

    pub const SCHEMA_NAME: &str = "zecblock-private-explorer-v3";
    pub const ROW_HASH_DOMAIN: &[u8] = b"zecblock-explorer-bucket-v3";
    pub const ROW_BYTES: usize = 16_384;
    /// Room for a path in a tree of up to 2^18 rows.
    pub const MAX_DEPTH: usize = 18;
    pub const PROOF_BYTES: usize = MAX_DEPTH * 32;
    pub const PAYLOAD: usize = ROW_BYTES - PROOF_BYTES;

    /// Leaf hash binding a row's payload to its table, instance and position.
    pub fn leaf(kind: &str, instance: u32, row: u32, payload: &[u8]) -> [u8; 32] {
        Sha256::new()
            .chain_update(b"zecblock-explorer-row-v3")
            .chain_update([kind.len() as u8])
            .chain_update(kind)
            .chain_update(instance.to_le_bytes())
            .chain_update(row.to_le_bytes())
            .chain_update(payload)
            .finalize()
            .into()
    }

    pub fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        Sha256::new().chain_update(b"zecblock-explorer-node-v3").chain_update(left).chain_update(right).finalize().into()
    }

    /// Stands in for the leaves past the last row in a power-of-two tree.
    pub fn empty_leaf() -> [u8; 32] {
        Sha256::digest(b"zecblock-explorer-empty-v3").into()
    }

    pub fn depth(rows: usize) -> usize {
        rows.next_power_of_two().trailing_zeros() as usize
    }

    /// Every level of the tree, leaves first, root last.
    pub fn merkle_levels(mut leaves: Vec<[u8; 32]>) -> Vec<Vec<[u8; 32]>> {
        leaves.resize(leaves.len().next_power_of_two().max(1), empty_leaf());
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let next = levels.last().unwrap().chunks_exact(2).map(|pair| node(&pair[0], &pair[1])).collect();
            levels.push(next);
        }
        levels
    }

    /// Sibling hashes from the leaf up, padded with zeros to PROOF_BYTES.
    pub fn path(levels: &[Vec<[u8; 32]>], index: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(PROOF_BYTES);
        let mut at = index;
        for level in &levels[..levels.len() - 1] {
            out.extend_from_slice(&level[at ^ 1]);
            at >>= 1;
        }
        out.resize(PROOF_BYTES, 0);
        out
    }

    /// The row's payload, if its path leads to `root`.
    pub fn verify_row<'a>(kind: &str, instance: u32, row: u32, bytes: &'a [u8], root: &[u8; 32], depth: usize) -> Result<&'a [u8], String> {
        if bytes.len() != ROW_BYTES || depth > MAX_DEPTH {
            return Err("row has the wrong shape".into());
        }
        let (payload, proof) = bytes.split_at(PAYLOAD);
        let mut hash = leaf(kind, instance, row, payload);
        let mut at = row as usize;
        for sibling in proof[..depth * 32].chunks_exact(32) {
            let sibling: &[u8; 32] = sibling.try_into().unwrap();
            hash = if at & 1 == 0 { node(&hash, sibling) } else { node(sibling, &hash) };
            at >>= 1;
        }
        if &hash != root {
            return Err(format!("{kind} row failed verification against the signed manifest"));
        }
        Ok(payload)
    }
    pub const BUCKET_HEADER: usize = 4;
    pub const TAG: usize = 12;
    pub const ENTRY_HEADER: usize = TAG + 2;
    pub const PREVIEW_FLAG: u16 = 0x8000;

    /// Local bucket row for a txid in display byte order.
    pub fn row_of(txid: &[u8; 32], rows: u64) -> u64 {
        let digest = Sha256::new().chain_update(ROW_HASH_DOMAIN).chain_update(txid).finalize();
        u64::from_le_bytes(digest[..8].try_into().unwrap()) % rows
    }

    pub fn geometry(kind: &str, rows: usize) -> String {
        format!("explorer-{kind}-{rows}x{ROW_BYTES}")
    }

    pub fn put_var(out: &mut Vec<u8>, mut value: u64) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn get_var(bytes: &[u8], at: &mut usize) -> Result<u64, String> {
        let mut value = 0;
        for shift in (0..64).step_by(7) {
            let byte = *bytes.get(*at).ok_or("truncated varint")?;
            *at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("varint too long".into())
    }

    pub fn preview_body(start: u64, len: usize, preview: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + preview.len());
        put_var(&mut out, start);
        put_var(&mut out, len as u64);
        out.extend_from_slice(preview);
        out
    }

    /// Where a txid's record sits in a decoded bucket.
    #[derive(Debug, PartialEq, Eq)]
    pub enum Entry {
        Absent,
        Inline(Vec<u8>),
        /// A truncated record, plus the full record's byte range in the
        /// concatenated overflow table.
        Preview { preview: Vec<u8>, start: u64, len: usize },
    }

    /// Tag of a "spent since the base snapshot" marker for a base txid. It
    /// sits in the txid's own bucket, so the same single query returns it.
    pub fn spent_tag(txid: &[u8; 32]) -> [u8; TAG] {
        Sha256::new().chain_update(b"zecblock-explorer-spent-v1").chain_update(txid).finalize()[..TAG].try_into().unwrap()
    }

    /// Output indices encoded as a little-endian bitmap.
    pub fn spent_bitmap(indices: impl IntoIterator<Item = u32>) -> Vec<u8> {
        let mut out = Vec::new();
        for index in indices {
            let byte = index as usize / 8;
            if out.len() <= byte {
                out.resize(byte + 1, 0);
            }
            out[byte] |= 1 << (index % 8);
        }
        out
    }

    pub fn spent_indices(bitmap: &[u8]) -> Vec<u32> {
        bitmap.iter().enumerate().flat_map(|(byte, bits)| (0..8).filter(move |bit| bits & (1 << bit) != 0).map(move |bit| (byte * 8 + bit) as u32)).collect()
    }

    /// Output indices of a base transaction spent after its snapshot, when
    /// this (recent) bucket carries a marker for it.
    pub fn find_spent(bucket: &[u8], txid: &[u8; 32]) -> Result<Option<Vec<u32>>, String> {
        Ok(match find_tag(bucket, &spent_tag(txid))? {
            Entry::Inline(bitmap) => Some(spent_indices(&bitmap)),
            _ => None,
        })
    }

    pub fn find(bucket: &[u8], txid: &[u8; 32]) -> Result<Entry, String> {
        find_tag(bucket, &txid[..TAG])
    }

    fn find_tag(bucket: &[u8], tag: &[u8]) -> Result<Entry, String> {
        if bucket.is_empty() || bucket.len() % PAYLOAD != 0 {
            return Err("bucket has the wrong length".into());
        }
        let entries = u16::from_le_bytes([bucket[0], bucket[1]]);
        let mut at = BUCKET_HEADER;
        for _ in 0..entries {
            let header = bucket.get(at..at + ENTRY_HEADER).ok_or("bucket entry exceeds bucket")?;
            let raw = u16::from_le_bytes([header[TAG], header[TAG + 1]]);
            let len = (raw & !PREVIEW_FLAG) as usize;
            let body = bucket.get(at + ENTRY_HEADER..at + ENTRY_HEADER + len).ok_or("bucket entry exceeds bucket")?;
            if header[..TAG] == *tag {
                if raw & PREVIEW_FLAG == 0 {
                    return Ok(Entry::Inline(body.to_vec()));
                }
                let mut at = 0;
                let start = get_var(body, &mut at)?;
                let len = get_var(body, &mut at)? as usize;
                if len == 0 {
                    return Err("empty overflow record".into());
                }
                return Ok(Entry::Preview { preview: body[at..].to_vec(), start, len });
            }
            at += ENTRY_HEADER + len;
        }
        Ok(Entry::Absent)
    }

    /// Global overflow rows covering a payload byte range.
    pub fn overflow_rows(start: u64, len: usize) -> std::ops::RangeInclusive<u64> {
        start / PAYLOAD as u64..=(start + len as u64 - 1) / PAYLOAD as u64
    }

    /// Row count actually requested for a full-record fetch: the next power
    /// of two, so the server learns only a coarse size class.
    pub fn padded_rows(rows: usize) -> usize {
        rows.next_power_of_two()
    }
}

// ---- signed publications ---------------------------------------------------------

pub mod publication {
    //! A manifest is trusted only with a valid Ed25519 signature from the
    //! pinned ZecBlock publishing key. Its roots then authenticate every row.
    use super::layout;
    use ed25519_dalek::{Signature, VerifyingKey};
    use serde_json::Value;

    /// ZecBlock private explorer publishing key (raw Ed25519 public key).
    pub const PUBLISHER_KEY: &str = "710a2be39ee4ecbc2a8762df4da84066e0180f4ebcaffaf6eeab66abf7410e92";

    pub struct Side {
        pub instances: usize,
        pub rows: usize,
        pub roots: Vec<[u8; 32]>,
        pub depth: usize,
    }

    pub struct Manifest {
        pub value: Value,
        pub tip: u64,
        pub base_tip: Option<u64>,
        pub main: Side,
        pub overflow: Side,
    }

    pub fn verify(manifest: &[u8], signature: &[u8]) -> Result<Manifest, String> {
        let key: [u8; 32] = hex::decode(PUBLISHER_KEY).unwrap().try_into().unwrap();
        let key = VerifyingKey::from_bytes(&key).map_err(|e| e.to_string())?;
        let signature = Signature::from_slice(signature).map_err(|_| "malformed manifest signature".to_string())?;
        key.verify_strict(manifest, &signature).map_err(|_| "manifest signature is not from the ZecBlock publishing key".to_string())?;
        let value: Value = serde_json::from_slice(manifest).map_err(|e| e.to_string())?;
        if value["schema"] != layout::SCHEMA_NAME || value["network"] != "mainnet" || value["rowBytes"] != layout::ROW_BYTES
            || value["payloadBytes"] != layout::PAYLOAD {
            return Err("unsupported private explorer manifest".into());
        }
        let side = |kind: &str| -> Result<Side, String> {
            let instances = value[kind]["instances"].as_u64().ok_or("bad manifest")? as usize;
            let rows = value[kind]["rows"].as_u64().ok_or("bad manifest")? as usize;
            let roots = value[kind]["roots"].as_array().ok_or("manifest has no roots")?.iter()
                .map(|r| r.as_str().and_then(|h| hex::decode(h).ok()).and_then(|b| b.try_into().ok()).ok_or("bad root".to_string()))
                .collect::<Result<Vec<[u8; 32]>, _>>()?;
            let depth = value["proofDepth"][kind].as_u64().ok_or("bad manifest")? as usize;
            if instances == 0 || rows == 0 || roots.len() != instances || depth != layout::depth(rows) {
                return Err(format!("{kind} manifest shape mismatch"));
            }
            Ok(Side { instances, rows, roots, depth })
        };
        Ok(Manifest {
            tip: value["snapshotTip"].as_u64().ok_or("bad manifest")?,
            base_tip: value["baseTip"].as_u64(),
            main: side("main")?,
            overflow: side("overflow")?,
            value,
        })
    }
}

// ---- blocks ------------------------------------------------------------------------

/// First byte of an encoded block record.
pub const BLOCK_VERSION: u8 = 1;
/// First byte of a block-hash pointer entry: `[BLOCK_POINTER][var height]`.
pub const BLOCK_POINTER: u8 = 0xfe;

/// Lookup key of a block's full record: its height, hashed into the same
/// 32-byte key space as txids and block hashes.
pub fn block_height_key(height: u32) -> [u8; 32] {
    Sha256::new().chain_update(b"zecblock-explorer-block-height-v1").chain_update(height.to_le_bytes()).finalize().into()
}

/// What the block page lists for each transaction.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlockTx {
    pub txid: [u8; 32],
    /// coinbase, sapling, orchard, ironwood, sprout
    pub flags: u8,
    pub fee: Option<i64>,
    pub total_output: Option<i64>,
    pub vin_count: u32,
    pub vout_count: u32,
    pub sapling_spends: u32,
    pub sapling_outputs: u32,
    pub orchard_actions: u32,
    pub ironwood_actions: u32,
    pub value_balance_sapling: Option<i64>,
    pub value_balance_orchard: Option<i64>,
    pub value_balance_ironwood: Option<i64>,
    pub first_input_address: Option<String>,
    pub first_output_address: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlockRecord {
    pub height: u32,
    pub hash: [u8; 32],
    pub previous_hash: Option<[u8; 32]>,
    pub time: u64,
    pub version: i64,
    pub merkle_root: Option<[u8; 32]>,
    pub final_sapling_root: Option<[u8; 32]>,
    pub final_orchard_root: Option<[u8; 32]>,
    pub final_ironwood_root: Option<[u8; 32]>,
    pub bits: String,
    pub nonce: Option<[u8; 32]>,
    /// Exact decimal text from the database.
    pub difficulty: String,
    pub size: u32,
    pub tx_count: u32,
    pub total_fees: Option<i64>,
    pub miner_address: Option<String>,
    pub txs: Vec<BlockTx>,
}

fn put_text(out: &mut Vec<u8>, text: &str) {
    put(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

fn read_text(r: &mut Reader) -> Result<String, String> {
    let len = r.var()? as usize;
    String::from_utf8(r.take(len)?.to_vec()).map_err(|_| "text is not UTF-8".into())
}

impl BlockRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256 + self.txs.len() * 96);
        out.push(BLOCK_VERSION);
        let hashes = [&self.previous_hash, &self.merkle_root, &self.final_sapling_root, &self.final_orchard_root, &self.final_ironwood_root, &self.nonce];
        let presence = hashes.iter().enumerate().fold(0u8, |b, (i, h)| b | (u8::from(h.is_some()) << i))
            | u8::from(self.total_fees.is_some()) << 6 | u8::from(self.miner_address.is_some()) << 7;
        out.push(presence);
        put(&mut out, u64::from(self.height));
        out.extend_from_slice(&self.hash);
        for hash in hashes.into_iter().flatten() {
            out.extend_from_slice(hash);
        }
        put(&mut out, self.time);
        put_signed(&mut out, self.version);
        put_text(&mut out, &self.bits);
        put_text(&mut out, &self.difficulty);
        put(&mut out, u64::from(self.size));
        put(&mut out, u64::from(self.tx_count));
        if let Some(fees) = self.total_fees {
            put_signed(&mut out, fees);
        }
        if let Some(miner) = &self.miner_address {
            let at = out.len();
            out.push(0);
            out[at] = put_address(&mut out, miner);
        }
        put(&mut out, self.txs.len() as u64);
        for tx in &self.txs {
            out.extend_from_slice(&tx.txid);
            let optionals = [tx.fee, tx.total_output, tx.value_balance_sapling, tx.value_balance_orchard, tx.value_balance_ironwood];
            let presence = optionals.iter().enumerate().fold(0u8, |b, (i, v)| b | (u8::from(v.is_some()) << i))
                | u8::from(tx.first_input_address.is_some()) << 5 | u8::from(tx.first_output_address.is_some()) << 6;
            out.push(tx.flags);
            out.push(presence);
            for value in optionals.into_iter().flatten() {
                put_signed(&mut out, value);
            }
            for count in [tx.vin_count, tx.vout_count, tx.sapling_spends, tx.sapling_outputs, tx.orchard_actions, tx.ironwood_actions] {
                put(&mut out, u64::from(count));
            }
            for address in [&tx.first_input_address, &tx.first_output_address].into_iter().flatten() {
                let at = out.len();
                out.push(0);
                out[at] = put_address(&mut out, address);
            }
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = Reader { bytes, at: 0 };
        if r.byte()? != BLOCK_VERSION {
            return Err("unsupported block record version".into());
        }
        let presence = r.byte()?;
        let mut block = BlockRecord { height: r.var32()?, hash: r.hash()?, ..BlockRecord::default() };
        let mut hashes: [Option<[u8; 32]>; 6] = [None; 6];
        for (i, slot) in hashes.iter_mut().enumerate() {
            if presence & (1 << i) != 0 {
                *slot = Some(r.hash()?);
            }
        }
        [block.previous_hash, block.merkle_root, block.final_sapling_root, block.final_orchard_root, block.final_ironwood_root, block.nonce] = hashes;
        block.time = r.var()?;
        block.version = r.signed()?;
        block.bits = read_text(&mut r)?;
        block.difficulty = read_text(&mut r)?;
        block.size = r.var32()?;
        block.tx_count = r.var32()?;
        if presence & (1 << 6) != 0 {
            block.total_fees = Some(r.signed()?);
        }
        if presence & (1 << 7) != 0 {
            let kind = r.byte()?;
            block.miner_address = Some(read_address(&mut r, kind)?);
        }
        let count = r.var()? as usize;
        for _ in 0..count {
            let mut tx = BlockTx { txid: r.hash()?, flags: r.byte()?, ..BlockTx::default() };
            let presence = r.byte()?;
            let mut optionals = [None; 5];
            for (i, slot) in optionals.iter_mut().enumerate() {
                if presence & (1 << i) != 0 {
                    *slot = Some(r.signed()?);
                }
            }
            [tx.fee, tx.total_output, tx.value_balance_sapling, tx.value_balance_orchard, tx.value_balance_ironwood] = optionals;
            tx.vin_count = r.var32()?;
            tx.vout_count = r.var32()?;
            tx.sapling_spends = r.var32()?;
            tx.sapling_outputs = r.var32()?;
            tx.orchard_actions = r.var32()?;
            tx.ironwood_actions = r.var32()?;
            if presence & (1 << 5) != 0 {
                let kind = r.byte()?;
                tx.first_input_address = Some(read_address(&mut r, kind)?);
            }
            if presence & (1 << 6) != 0 {
                let kind = r.byte()?;
                tx.first_output_address = Some(read_address(&mut r, kind)?);
            }
            block.txs.push(tx);
        }
        if r.at != bytes.len() {
            return Err("trailing bytes after block record".into());
        }
        Ok(block)
    }

    /// The block with only its first transactions, as many as fit in `max`
    /// bytes; `tx_count` keeps the full count.
    pub fn preview(&self, max: usize) -> Vec<u8> {
        let mut cut = self.clone();
        let (mut low, mut high) = (0, self.txs.len());
        while low < high {
            let mid = (low + high + 1) / 2;
            cut.txs = self.txs[..mid].to_vec();
            if cut.encode().len() <= max { low = mid } else { high = mid - 1 }
        }
        cut.txs = self.txs[..low].to_vec();
        cut.encode()
    }

    /// Shaped like the public `/api/block/:height` fields; zatoshi amounts as
    /// decimal strings.
    pub fn to_json(&self) -> Value {
        let zat = |v: Option<i64>| v.map(|v| v.to_string());
        let hex32 = |h: &Option<[u8; 32]>| h.map(hex::encode);
        json!({
            "height": self.height,
            "hash": hex::encode(self.hash),
            "previous_block_hash": hex32(&self.previous_hash),
            "timestamp": self.time,
            "version": self.version,
            "merkle_root": hex32(&self.merkle_root),
            "final_sapling_root": hex32(&self.final_sapling_root),
            "final_orchard_root": hex32(&self.final_orchard_root),
            "final_ironwood_root": hex32(&self.final_ironwood_root),
            "bits": self.bits,
            "nonce": hex32(&self.nonce),
            "difficulty": self.difficulty,
            "size": self.size,
            "transaction_count": self.tx_count,
            "total_fees": zat(self.total_fees),
            "miner_address": self.miner_address,
            "transactions": self.txs.iter().map(|tx| json!({
                "txid": hex::encode(tx.txid),
                "is_coinbase": tx.flags & 1 != 0,
                "has_sapling": tx.flags & 2 != 0,
                "has_orchard": tx.flags & 4 != 0,
                "has_ironwood": tx.flags & 8 != 0,
                "has_sprout": tx.flags & 16 != 0,
                "fee": zat(tx.fee),
                "total_output": zat(tx.total_output),
                "vin_count": tx.vin_count,
                "vout_count": tx.vout_count,
                "sapling_spend_count": tx.sapling_spends,
                "sapling_output_count": tx.sapling_outputs,
                "orchard_actions": tx.orchard_actions,
                "ironwood_actions": tx.ironwood_actions,
                "value_balance_sapling": zat(tx.value_balance_sapling),
                "value_balance_orchard": zat(tx.value_balance_orchard),
                "value_balance_ironwood": zat(tx.value_balance_ironwood),
                "first_input_address": tx.first_input_address,
                "first_output_address": tx.first_output_address,
            })).collect::<Vec<_>>(),
        })
    }
}

/// Parses one line of the block export (see `blocks.sql`): 16 block columns
/// and the per-transaction summaries joined with \x1f fields and \x1e items.
pub fn parse_block_line(line: &str) -> Result<BlockRecord, String> {
    let f: Vec<&str> = line.split('\t').collect();
    if f.len() != 17 {
        return Err(format!("expected 17 columns, found {}", f.len()));
    }
    let hash = |field: &str| null(field).map(hash_field).transpose();
    let mut block = BlockRecord {
        height: f[0].parse().map_err(|_| "bad height")?,
        hash: hash_field(f[1])?,
        previous_hash: hash(f[2])?,
        time: f[3].parse().map_err(|_| "bad timestamp")?,
        version: f[4].parse().map_err(|_| "bad version")?,
        merkle_root: hash(f[5])?,
        final_sapling_root: hash(f[6])?,
        final_orchard_root: hash(f[7])?,
        final_ironwood_root: hash(f[8])?,
        bits: null(f[9]).unwrap_or("").to_owned(),
        nonce: hash(f[10])?,
        difficulty: null(f[11]).unwrap_or("").to_owned(),
        size: opt(f[12])?.unwrap_or(0),
        tx_count: opt(f[13])?.unwrap_or(0),
        total_fees: opt(f[14])?,
        miner_address: null(f[15]).map(str::to_owned),
        txs: Vec::new(),
    };
    if let Some(items) = null(f[16]) {
        for item in items.split('\u{1e}') {
            let p: Vec<&str> = item.split('\u{1f}').collect();
            if p.len() != 19 {
                return Err(format!("expected 19 transaction fields, found {}", p.len()));
            }
            let int = |s: &str| -> Result<u32, String> { opt(s).map(|v| v.unwrap_or(0)) };
            block.txs.push(BlockTx {
                txid: hash_field(p[0])?,
                flags: (0..5).fold(0u8, |b, i| b | (u8::from(p[1 + i] == "t") << i)),
                fee: opt(p[6])?,
                total_output: opt(p[7])?,
                vin_count: int(p[8])?,
                vout_count: int(p[9])?,
                sapling_spends: int(p[10])?,
                sapling_outputs: int(p[11])?,
                orchard_actions: int(p[12])?,
                ironwood_actions: int(p[13])?,
                value_balance_sapling: opt(p[14])?,
                value_balance_orchard: opt(p[15])?,
                value_balance_ironwood: opt(p[16])?,
                first_input_address: null(p[17]).map(str::to_owned),
                first_output_address: null(p[18]).map(str::to_owned),
            });
        }
    }
    Ok(block)
}

#[cfg(test)]
mod block_tests {
    use super::*;

    #[test]
    fn block_round_trips_and_previews() {
        let tx = |i: u8| BlockTx {
            txid: [i; 32], flags: u8::from(i == 0), fee: (i > 0).then_some(1_000), total_output: Some(5_000_000 + i64::from(i)),
            vin_count: 1, vout_count: 2, orchard_actions: 2, value_balance_orchard: Some(-7), first_input_address: None,
            first_output_address: Some("t1aTey5i7FzJQ2FC238SomgzMfbZxXBWPMX".into()), ..BlockTx::default()
        };
        let block = BlockRecord {
            height: 3_541_000, hash: [9; 32], previous_hash: Some([8; 32]), time: 1_793_751_208, version: 4,
            merkle_root: Some([7; 32]), bits: "1b7b6a9a".into(), nonce: Some([6; 32]), difficulty: "278404404.866183".into(),
            size: 1646, tx_count: 300, total_fees: Some(0), miner_address: Some("t1TVdjqU1APVQmCRRnzbqfjz6wR2qtBnnoc".into()),
            txs: (0..=255).map(tx).collect(), ..BlockRecord::default()
        };
        let bytes = block.encode();
        assert_eq!(BlockRecord::decode(&bytes).unwrap(), block);
        let preview = BlockRecord::decode(&block.preview(2_048)).unwrap();
        assert!(!preview.txs.is_empty() && preview.txs.len() < block.txs.len());
        assert_eq!(preview.tx_count, 300);
        assert_eq!(preview.txs[..], block.txs[..preview.txs.len()]);
        assert_ne!(block_height_key(1), block_height_key(2));
    }
}

// ---- transparent addresses ---------------------------------------------------------

pub const ADDRESS_VERSION: u8 = 1;
/// History entries per page; the first page travels with the summary.
pub const ADDRESS_PAGE: usize = 50;

pub fn address_key(address: &str) -> [u8; 32] {
    Sha256::new().chain_update(b"zecblock-explorer-address-v1").chain_update(address.as_bytes()).finalize().into()
}

/// Key of history page `page` (1-based; page 0 is in the summary entry).
pub fn address_page_key(address: &str, page: u32) -> [u8; 32] {
    Sha256::new().chain_update(b"zecblock-explorer-address-page-v1").chain_update(address.as_bytes()).chain_update(page.to_le_bytes()).finalize().into()
}

/// One transaction of an address's history, newest first in a page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AddressTx {
    pub txid: [u8; 32],
    pub height: u32,
    pub tx_index: u32,
    pub time: u64,
    /// Spent from this address in the transaction (zatoshis).
    pub value_in: i64,
    /// Received by this address in the transaction (zatoshis).
    pub value_out: i64,
}

/// A summary with the newest page of history, or (page > 0) one older page.
/// Totals cover exactly the rows the publication was built from, so a base
/// summary and a recent delta add up without counting anything twice.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AddressRecord {
    pub address: String,
    pub page: u32,
    pub received: i64,
    pub sent: i64,
    pub tx_count: u32,
    pub first_seen: u64,
    pub last_seen: u64,
    /// Older pages available after page 0.
    pub pages: u32,
    pub txs: Vec<AddressTx>,
}

impl AddressRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(96 + self.txs.len() * 50);
        out.push(ADDRESS_VERSION);
        let at = out.len();
        out.push(0);
        out[at] = put_address(&mut out, &self.address);
        put(&mut out, u64::from(self.page));
        if self.page == 0 {
            put_signed(&mut out, self.received);
            put_signed(&mut out, self.sent);
            put(&mut out, u64::from(self.tx_count));
            put(&mut out, self.first_seen);
            put(&mut out, self.last_seen);
            put(&mut out, u64::from(self.pages));
        }
        put(&mut out, self.txs.len() as u64);
        for tx in &self.txs {
            out.extend_from_slice(&tx.txid);
            put(&mut out, u64::from(tx.height));
            put(&mut out, u64::from(tx.tx_index));
            put(&mut out, tx.time);
            put_signed(&mut out, tx.value_in);
            put_signed(&mut out, tx.value_out);
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = Reader { bytes, at: 0 };
        if r.byte()? != ADDRESS_VERSION {
            return Err("unsupported address record version".into());
        }
        let kind = r.byte()?;
        let mut record = AddressRecord { address: read_address(&mut r, kind)?, page: r.var32()?, ..AddressRecord::default() };
        if record.page == 0 {
            record.received = r.signed()?;
            record.sent = r.signed()?;
            record.tx_count = r.var32()?;
            record.first_seen = r.var()?;
            record.last_seen = r.var()?;
            record.pages = r.var32()?;
        }
        for _ in 0..r.var()? {
            record.txs.push(AddressTx { txid: r.hash()?, height: r.var32()?, tx_index: r.var32()?, time: r.var()?, value_in: r.signed()?, value_out: r.signed()? });
        }
        if r.at != bytes.len() {
            return Err("trailing bytes after address record".into());
        }
        Ok(record)
    }

    pub fn to_json(&self) -> Value {
        let mut json = json!({
            "address": self.address,
            "page": self.page,
            "transactions": self.txs.iter().map(|t| json!({
                "txid": hex::encode(t.txid), "block_height": t.height, "tx_index": t.tx_index, "block_time": t.time,
                "value_in": t.value_in.to_string(), "value_out": t.value_out.to_string(),
            })).collect::<Vec<_>>(),
        });
        if self.page == 0 {
            json["total_received"] = json!(self.received.to_string());
            json["total_sent"] = json!(self.sent.to_string());
            json["balance"] = json!((self.received - self.sent).to_string());
            json["tx_count"] = json!(self.tx_count);
            json["first_seen"] = json!(self.first_seen);
            json["last_seen"] = json!(self.last_seen);
            json["pages"] = json!(self.pages);
        }
        json
    }

    /// Records for one address from its rows (any order): the summary with
    /// the newest page, then older pages unless `pages` is false.
    pub fn from_rows(address: &str, mut rows: Vec<AddressTx>, pages: bool) -> Vec<([u8; 32], AddressRecord)> {
        rows.sort_unstable_by(|a, b| (b.height, b.tx_index, b.txid).cmp(&(a.height, a.tx_index, a.txid)));
        let summary = AddressRecord {
            address: address.to_owned(),
            received: rows.iter().map(|r| r.value_out).sum(),
            sent: rows.iter().map(|r| r.value_in).sum(),
            tx_count: rows.len() as u32,
            first_seen: rows.iter().map(|r| r.time).min().unwrap_or(0),
            last_seen: rows.iter().map(|r| r.time).max().unwrap_or(0),
            pages: if pages { rows.len().saturating_sub(1).max(0) as u32 / ADDRESS_PAGE as u32 } else { 0 },
            ..AddressRecord::default()
        };
        let mut chunks = rows.chunks(ADDRESS_PAGE);
        let mut out = vec![(address_key(address), AddressRecord { txs: chunks.next().unwrap_or(&[]).to_vec(), ..summary })];
        if pages {
            for (i, chunk) in chunks.enumerate() {
                let page = i as u32 + 1;
                out.push((address_page_key(address, page), AddressRecord { address: address.to_owned(), page, txs: chunk.to_vec(), ..AddressRecord::default() }));
            }
        }
        out
    }
}

/// Parses one line of the address export (see `addresses.sql`):
/// address, txid, block_height, tx_index, block_time, value_in, value_out.
pub fn parse_address_line(line: &str) -> Result<(String, AddressTx), String> {
    let f: Vec<&str> = line.split('\t').collect();
    if f.len() != 7 {
        return Err(format!("expected 7 columns, found {}", f.len()));
    }
    Ok((f[0].to_owned(), AddressTx {
        txid: hash_field(f[1])?,
        height: f[2].parse().map_err(|_| "bad height")?,
        tx_index: opt(f[3])?.unwrap_or(0),
        time: opt(f[4])?.unwrap_or(0),
        value_in: opt(f[5])?.unwrap_or(0),
        value_out: opt(f[6])?.unwrap_or(0),
    }))
}

#[cfg(test)]
mod address_tests {
    use super::*;

    #[test]
    fn address_pages_round_trip_and_fit() {
        let rows: Vec<AddressTx> = (0..123u32).map(|i| AddressTx { txid: [i as u8; 32], height: 1_000 + i, tx_index: i % 3, time: 1_700_000_000 + u64::from(i),
            value_in: if i % 2 == 0 { 0 } else { 5_000 }, value_out: 2_000_000_000 }).collect();
        let records = AddressRecord::from_rows("t1TVdjqU1APVQmCRRnzbqfjz6wR2qtBnnoc", rows, true);
        assert_eq!(records.len(), 3);
        let summary = &records[0].1;
        assert_eq!((summary.tx_count, summary.pages, summary.txs.len()), (123, 2, 50));
        assert_eq!(summary.txs[0].height, 1_122);
        assert_eq!(records[2].1.txs.len(), 23);
        for (_, record) in &records {
            let bytes = record.encode();
            assert!(bytes.len() <= 4_096);
            assert_eq!(&AddressRecord::decode(&bytes).unwrap(), record);
        }
        assert_eq!(summary.received - summary.sent, 123 * 2_000_000_000 - 61 * 5_000);
        assert_eq!(AddressRecord::from_rows("t1TVdjqU1APVQmCRRnzbqfjz6wR2qtBnnoc", vec![], true)[0].1.pages, 0);
    }
}
