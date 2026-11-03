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
}
