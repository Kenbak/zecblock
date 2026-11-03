//! Lossless, bounded binary JSON used only by the experimental v2 record codec.
//!
//! A u32 LE length and immutable raw-transaction byte anchor precede one value.
//! Tags: 0 null, 1 false, 2 true, 3 canonical Number text, 4 UTF-8 string,
//! 5 array, 6 sorted object, 7/8 lower/upper hex bytes, 9/10 lower/upper hex
//! spans (u32 offset + u32 bytes) in the anchor. Lengths/counts are u32 LE.
//! Object keys are untagged length-prefixed UTF-8 strings. Tag 11 is a
//! root-only canonical JSON fallback with an empty anchor. It bounds binary
//! overhead for records with many tiny numbers/containers. Unknown RPC fields
//! remain ordinary values; nothing is inferred from transaction semantics.
use super::MAX_DECODED_RECORD_BYTES;
use serde_json::{Map, Number, Value};
use std::collections::HashMap;
use std::str::FromStr;

pub(super) const MAX_PAYLOAD_BYTES: usize = MAX_DECODED_RECORD_BYTES + 9;
const MAX_DEPTH: usize = 128;
const STRIDE: usize = 16;
const MIN_SPAN_BYTES: usize = 32;

fn error() -> String {
    "Invalid, truncated or oversized compact global JSON".into()
}

fn write_u32(out: &mut Vec<u8>, length: usize) -> Result<(), String> {
    out.extend_from_slice(&u32::try_from(length).map_err(|_| error())?.to_le_bytes());
    Ok(())
}

fn write_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    write_u32(out, bytes.len())?;
    out.extend_from_slice(bytes);
    Ok(())
}

fn hex_case(text: &str) -> Option<bool> {
    if text.is_empty() || !text.len().is_multiple_of(2) {
        return None;
    }
    let mut lower = false;
    let mut upper = false;
    for byte in text.bytes() {
        match byte {
            b'0'..=b'9' => (),
            b'a'..=b'f' => lower = true,
            b'A'..=b'F' => upper = true,
            _ => return None,
        }
    }
    if lower && upper { None } else { Some(upper) }
}

struct Anchor<'a> {
    bytes: &'a [u8],
    // One first occurrence per 16-byte boundary keeps the index bounded and
    // deterministic. Ambiguous matches simply fall back to packed hex.
    first: HashMap<u64, u32>,
}

impl<'a> Anchor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        let mut first = HashMap::with_capacity(bytes.len() / STRIDE);
        for offset in (0..bytes.len().saturating_sub(7)).step_by(STRIDE) {
            let key = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
            first.entry(key).or_insert(offset as u32);
        }
        Self { bytes, first }
    }

    fn span(&self, needle: &[u8]) -> Option<usize> {
        if needle.len() < MIN_SPAN_BYTES {
            return None;
        }
        // At most 16 candidates, independent of transaction length. Arbitrary
        // byte alignment is covered by an anchor-aligned 8-byte needle prefix.
        for prefix in 0..STRIDE {
            let key = u64::from_le_bytes(needle[prefix..prefix + 8].try_into().unwrap());
            let Some(&offset) = self.first.get(&key) else {
                continue;
            };
            let Some(start) = (offset as usize).checked_sub(prefix) else {
                continue;
            };
            let Some(end) = start
                .checked_add(needle.len())
                .filter(|&end| end <= self.bytes.len())
            else {
                continue;
            };
            if self.bytes[start..end] == *needle {
                return Some(start);
            }
        }
        None
    }
}

fn write_value(
    value: &Value,
    anchor: &Anchor<'_>,
    out: &mut Vec<u8>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("Compact global JSON nesting exceeds its bound".into());
    }
    match value {
        Value::Null => out.push(0),
        Value::Bool(false) => out.push(1),
        Value::Bool(true) => out.push(2),
        Value::Number(number) => {
            out.push(3);
            write_bytes(out, number.to_string().as_bytes())?;
        }
        Value::String(text) => {
            if let Some(upper) = hex_case(text) {
                let bytes = hex::decode(text).map_err(|_| error())?;
                if let Some(offset) = anchor.span(&bytes) {
                    out.push(if upper { 10 } else { 9 });
                    write_u32(out, offset)?;
                    write_u32(out, bytes.len())?;
                } else {
                    out.push(if upper { 8 } else { 7 });
                    write_bytes(out, &bytes)?;
                }
            } else {
                out.push(4);
                write_bytes(out, text.as_bytes())?;
            }
        }
        Value::Array(values) => {
            out.push(5);
            write_u32(out, values.len())?;
            for value in values {
                write_value(value, anchor, out, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            out.push(6);
            write_u32(out, fields.len())?;
            for (key, value) in fields {
                write_bytes(out, key.as_bytes())?;
                write_value(value, anchor, out, depth + 1)?;
            }
        }
    }
    if out.len() > MAX_PAYLOAD_BYTES {
        return Err("Compact global JSON exceeds its payload bound".into());
    }
    Ok(())
}

pub(super) fn encode(value: &Value) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if json.len() > MAX_DECODED_RECORD_BYTES {
        return Err(error());
    }
    let anchor = value["raw"]["hex"]
        .as_str()
        .filter(|text| hex_case(text).is_some() && text.len() >= 2 * MIN_SPAN_BYTES)
        .map(hex::decode)
        .transpose()
        .map_err(|_| error())?
        .unwrap_or_default();
    let index = Anchor::new(&anchor);
    let mut out = Vec::new();
    write_bytes(&mut out, &anchor)?;
    let result = write_value(value, &index, &mut out, 0);
    if let Err(error) = &result
        && error != "Compact global JSON exceeds its payload bound"
    {
        return Err(error.clone());
    }
    if result.is_err() || out.len() >= json.len() + 9 {
        // The complete canonical JSON is a lossless bounded fallback, rather
        // than excluding valid envelopes solely due to binary framing overhead.
        out.clear();
        write_u32(&mut out, 0)?;
        out.push(11);
        write_bytes(&mut out, &json)?;
    }
    Ok(out)
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
    anchor: &'a [u8],
    json_bytes: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .cursor
            .checked_add(length)
            .filter(|&end| end <= self.bytes.len())
            .ok_or_else(error)?;
        let result = &self.bytes[self.cursor..end];
        self.cursor = end;
        Ok(result)
    }

    fn number(&mut self) -> Result<usize, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize)
    }

    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let length = self.number()?;
        self.take(length)
    }

    fn charge(&mut self, count: usize) -> Result<(), String> {
        self.json_bytes = self
            .json_bytes
            .checked_add(count)
            .filter(|&n| n <= MAX_DECODED_RECORD_BYTES)
            .ok_or_else(error)?;
        Ok(())
    }

    fn text(&mut self) -> Result<String, String> {
        let text = std::str::from_utf8(self.bytes()?).map_err(|_| error())?;
        let mut length = text.len().checked_add(2).ok_or_else(error)?;
        for byte in text.bytes() {
            length = length
                .checked_add(match byte {
                    b'"' | b'\\' | b'\x08' | b'\x0c' | b'\n' | b'\r' | b'\t' => 1,
                    0..=0x1f => 5,
                    _ => 0,
                })
                .ok_or_else(error)?;
        }
        self.charge(length)?;
        Ok(text.to_owned())
    }

    fn hex(&mut self, bytes: &[u8], upper: bool) -> Result<Value, String> {
        self.charge(
            bytes
                .len()
                .checked_mul(2)
                .and_then(|n| n.checked_add(2))
                .ok_or_else(error)?,
        )?;
        Ok(Value::String(if upper {
            hex::encode_upper(bytes)
        } else {
            hex::encode(bytes)
        }))
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err(error());
        }
        let tag = self.take(1)?[0];
        match tag {
            0 => {
                self.charge(4)?;
                Ok(Value::Null)
            }
            1 => {
                self.charge(5)?;
                Ok(Value::Bool(false))
            }
            2 => {
                self.charge(4)?;
                Ok(Value::Bool(true))
            }
            3 => {
                let bytes = self.bytes()?;
                self.charge(bytes.len())?;
                let text = std::str::from_utf8(bytes).map_err(|_| error())?;
                let number = Number::from_str(text).map_err(|_| error())?;
                if number.to_string() != text {
                    return Err("Noncanonical compact JSON number".into());
                }
                Ok(Value::Number(number))
            }
            4 => Ok(Value::String(self.text()?)),
            5 => {
                let count = self.number()?;
                if count > self.bytes.len() - self.cursor {
                    return Err(error());
                }
                self.charge(2 + count.saturating_sub(1))?;
                let mut values = Vec::new();
                for _ in 0..count {
                    values.push(self.value(depth + 1)?);
                }
                Ok(Value::Array(values))
            }
            6 => {
                let count = self.number()?;
                if count > (self.bytes.len() - self.cursor) / 5 {
                    return Err(error());
                }
                self.charge(2 + count + count.saturating_sub(1))?;
                let mut fields = Map::new();
                let mut previous: Option<String> = None;
                for _ in 0..count {
                    let key = self.text()?;
                    if previous.as_ref().is_some_and(|last| last >= &key) {
                        return Err("Unsorted or duplicate compact JSON object key".into());
                    }
                    previous = Some(key.clone());
                    fields.insert(key, self.value(depth + 1)?);
                }
                Ok(Value::Object(fields))
            }
            7 | 8 => {
                let bytes = self.bytes()?;
                self.hex(bytes, tag == 8)
            }
            9 | 10 => {
                let offset = self.number()?;
                let length = self.number()?;
                let end = offset
                    .checked_add(length)
                    .filter(|&n| n <= self.anchor.len())
                    .ok_or("Invalid compact JSON raw-transaction span")?;
                self.hex(&self.anchor[offset..end], tag == 10)
            }
            11 if depth == 0 && self.anchor.is_empty() => {
                let bytes = self.bytes()?;
                self.charge(bytes.len())?;
                let value: Value =
                    serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
                if serde_json::to_vec(&value).map_err(|error| error.to_string())? != bytes {
                    return Err("Noncanonical compact JSON literal".into());
                }
                Ok(value)
            }
            _ => Err("Unsupported compact JSON tag".into()),
        }
    }
}

pub(super) fn decode(bytes: &[u8]) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(error());
    }
    let mut reader = Reader {
        bytes,
        cursor: 0,
        anchor: &[],
        json_bytes: 0,
    };
    reader.anchor = reader.bytes()?;
    if reader.anchor.len() > MAX_DECODED_RECORD_BYTES / 2 {
        return Err(error());
    }
    let value = reader.value(0)?;
    if reader.cursor != bytes.len() {
        return Err("Trailing compact JSON bytes".into());
    }
    // Enforce one representation and tie the anchor to the preserved raw.hex.
    // This also rejects unused anchors, nonminimal string forms and alternative
    // reference choices without reconstructing or dropping any JSON fields.
    if encode(&value)? != bytes {
        return Err("Noncanonical compact global JSON".into());
    }
    Ok(value)
}
