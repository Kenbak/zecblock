//! Private explorer test: every canonical transaction's explorer record in
//! hashed buckets spanning all main instances, plus an overflow table holding
//! the full form of large records.
//!
//! encode  : export lines (stdin) -> records.bin ([txid 32][len u32][record])
//! build   : records.bin -> per-instance database files + manifest.json
//! serve   : loopback HTTP; one upload answers every instance of a table
//! lookup  : native client; prints the `/api/tx/:txid` fields and timings
//!
//! A lookup is always exactly one main-table request: the same encrypted row
//! selection for every instance, answered by every instance. Every txid has an
//! entry in its bucket, either complete or as a preview (all summary fields,
//! first inputs/outputs), so the server learns nothing about which txid was
//! chosen, whether it exists or how large it is. Only an explicit request for
//! a preview's full lists touches the overflow table; that request is padded
//! to a power-of-two row count and reveals the coarse size class.
use super::chunk_spike::{parallel_multiply, parallel_multiply_batch, preprocess_blocks};
use super::explorer_record::{AddressRecord, AddressTx, BLOCK_POINTER, BLOCK_VERSION, BlockRecord, BlockTx, Record, block_height_key, parse_address_line, parse_block_line, parse_export_line, publication};
use super::*;
use memmap2::{Mmap, MmapMut};
use rayon::prelude::*;
use std::{
    fs::{File, OpenOptions},
    io::{BufReader, BufWriter, Read},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock, mpsc},
    time::Instant,
};
use zakura_pir_client::transparent::native::TableClientExt as _;
use zakura_pir_protocol::native::D;

use super::explorer_record::layout::{self, BUCKET_HEADER, ENTRY_HEADER, PAYLOAD, PREVIEW_FLAG, ROW_BYTES, TAG, preview_body, row_of, spent_bitmap, spent_tag};
use std::collections::{HashMap, HashSet};
/// Records up to this size are stored whole; larger ones get a preview.
const INLINE_MAX: usize = 4_096;
const PREVIEW_MAX: usize = 2_048;
/// Upper bound on the two varints in front of a preview.
const PREVIEW_POINTER: usize = 10;
const MAX_INSTANCE_ROWS: usize = 131_072;
/// Planned mean bucket fill; the slack absorbs per-bucket variance so that
/// demoting small records to previews stays rare.
const TARGET_FILL: f64 = 0.72;

// ---- shared helpers ----------------------------------------------------------

fn instance_rows(total_rows: usize) -> (usize, usize) {
    let instances = total_rows.div_ceil(MAX_INSTANCE_ROWS).max(1);
    let rows = total_rows.div_ceil(instances).div_ceil(D) * D;
    (instances, rows)
}

fn profile_for(kind: &str, rows: usize) -> Result<TableProfile, String> {
    TableProfile::new(layout::SCHEMA_NAME, &layout::geometry(kind, rows), TABLE, rows as u64, ROW_BYTES as u32)
}

fn io_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

// ---- encode ------------------------------------------------------------------

pub(super) fn encode(out_path: &Path) -> Result<(), String> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut writer = BufWriter::with_capacity(8 << 20, File::create(out_path).map_err(io_err)?);
    let mut sizes: Vec<u32> = Vec::new();
    let (mut inputs, mut outputs, mut compact_addresses, mut raw_addresses) = (0u64, 0u64, 0u64, 0u64);
    let mut max_height = 0u32;
    let start = Instant::now();
    loop {
        let batch: Vec<String> = lines.by_ref().take(100_000).collect::<Result<_, _>>().map_err(io_err)?;
        if batch.is_empty() {
            break;
        }
        let encoded: Vec<([u8; 32], Vec<u8>, u32, usize, usize, u64, u64)> = batch
            .par_iter()
            .map(|line| {
                let record = parse_export_line(line).map_err(|e| format!("{e}: {}", &line[..line.len().min(80)]))?;
                let bytes = record.encode();
                let addresses = record.inputs.iter().filter_map(|i| i.address.as_ref())
                    .chain(record.outputs.iter().filter_map(|o| o.address.as_ref()));
                let (mut compact, mut raw) = (0, 0);
                for address in addresses {
                    if address.len() == 35 && (address.starts_with("t1") || address.starts_with("t3")) { compact += 1 } else { raw += 1 }
                }
                Ok((record.txid, bytes, record.height, record.inputs.len(), record.outputs.len(), compact, raw))
            })
            .collect::<Result<_, String>>()?;
        for (txid, bytes, height, i, o, c, r) in encoded {
            writer.write_all(&txid).map_err(io_err)?;
            writer.write_all(&(bytes.len() as u32).to_le_bytes()).map_err(io_err)?;
            writer.write_all(&bytes).map_err(io_err)?;
            sizes.push(bytes.len() as u32);
            inputs += i as u64;
            outputs += o as u64;
            compact_addresses += c;
            raw_addresses += r;
            max_height = max_height.max(height);
        }
    }
    writer.flush().map_err(io_err)?;
    let total: u64 = sizes.iter().map(|&s| u64::from(s)).sum();
    let mut sorted = sizes.clone();
    sorted.sort_unstable();
    let pct = |p: f64| sorted.get(((sorted.len() as f64 - 1.0) * p) as usize).copied();
    let over_inline: u64 = sizes.iter().filter(|&&s| s as usize > INLINE_MAX).map(|&s| u64::from(s)).sum();
    let report = json!({"records":sizes.len(),"recordBytes":total,"maxHeight":max_height,"inputs":inputs,"outputs":outputs,
        "standardAddressesLikelyCompacted":compact_addresses,"otherAddresses":raw_addresses,
        "recordBytesPercentiles":{"p50":pct(0.5),"p90":pct(0.9),"p99":pct(0.99),"p999":pct(0.999),"max":sorted.last()},
        "recordsOverInlineMax":sizes.iter().filter(|&&s| s as usize > INLINE_MAX).count(),"bytesOverInlineMax":over_inline,
        "inlineMax":INLINE_MAX,"seconds":start.elapsed().as_secs_f64()});
    serde_json::to_writer(io::stdout().lock(), &report).map_err(io_err)?;
    println!();
    Ok(())
}

/// Block lines (stdin) -> records file: each block's record under its height
/// key, and a `[BLOCK_POINTER][var height]` entry under its hash.
pub(super) fn encode_blocks(out_path: &Path) -> Result<(), String> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut writer = BufWriter::with_capacity(8 << 20, File::create(out_path).map_err(io_err)?);
    let (mut blocks, mut bytes, mut max_height, mut largest) = (0u64, 0u64, 0u32, 0usize);
    let start = Instant::now();
    loop {
        let batch: Vec<String> = lines.by_ref().take(20_000).collect::<Result<_, _>>().map_err(io_err)?;
        if batch.is_empty() {
            break;
        }
        let encoded: Vec<(u32, [u8; 32], Vec<u8>)> = batch.par_iter()
            .map(|line| parse_block_line(line).map(|b| (b.height, b.hash, b.encode())).map_err(|e| format!("{e}: {}", &line[..line.len().min(80)])))
            .collect::<Result<_, String>>()?;
        for (height, hash, body) in encoded {
            let mut pointer = vec![BLOCK_POINTER];
            layout::put_var(&mut pointer, u64::from(height));
            for (key, entry) in [(block_height_key(height), &body), (hash, &pointer)] {
                writer.write_all(&key).map_err(io_err)?;
                writer.write_all(&(entry.len() as u32).to_le_bytes()).map_err(io_err)?;
                writer.write_all(entry).map_err(io_err)?;
            }
            blocks += 1;
            bytes += body.len() as u64;
            max_height = max_height.max(height);
            largest = largest.max(body.len());
        }
    }
    writer.flush().map_err(io_err)?;
    println!("{}", json!({"blocks":blocks,"recordBytes":bytes,"maxHeight":max_height,"largestRecord":largest,"seconds":start.elapsed().as_secs_f64()}));
    Ok(())
}

/// Address rows (stdin), grouped by address: summaries with their newest
/// page to `summaries`, older pages to `pages` (a recent publication passes
/// none: it keeps only each address's newest page of recent activity).
pub(super) fn encode_addresses(summaries: &Path, pages: Option<&Path>) -> Result<(), String> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut main = BufWriter::with_capacity(8 << 20, File::create(summaries).map_err(io_err)?);
    let mut paged = pages.map(|p| File::create(p).map(|f| BufWriter::with_capacity(8 << 20, f))).transpose().map_err(io_err)?;
    let (mut addresses, mut rows, mut page_entries, mut max_height) = (0u64, 0u64, 0u64, 0u32);
    let start = Instant::now();
    let mut carry: Option<(String, Vec<AddressTx>)> = None;
    let mut write = |groups: Vec<(String, Vec<AddressTx>)>, main: &mut BufWriter<File>, paged: &mut Option<BufWriter<File>>| -> Result<(), String> {
        let encoded: Vec<Vec<([u8; 32], Vec<u8>, bool)>> = groups.into_par_iter()
            .map(|(address, rows)| AddressRecord::from_rows(&address, rows, paged.is_some()).into_iter().map(|(k, r)| (k, r.encode(), r.page > 0)).collect())
            .collect();
        for (key, body, is_page) in encoded.into_iter().flatten() {
            if body.len() > INLINE_MAX {
                return Err("address entry exceeds the inline limit".into());
            }
            let out = if is_page { page_entries += 1; paged.as_mut().unwrap() } else { addresses += 1; &mut *main };
            out.write_all(&key).map_err(io_err)?;
            out.write_all(&(body.len() as u32).to_le_bytes()).map_err(io_err)?;
            out.write_all(&body).map_err(io_err)?;
        }
        Ok(())
    };
    loop {
        let batch: Vec<String> = lines.by_ref().take(200_000).collect::<Result<_, _>>().map_err(io_err)?;
        let done = batch.is_empty();
        let mut groups = Vec::new();
        for line in &batch {
            let (address, tx) = parse_address_line(line).map_err(|e| format!("{e}: {}", &line[..line.len().min(80)]))?;
            rows += 1;
            max_height = max_height.max(tx.height);
            match &mut carry {
                Some((current, txs)) if *current == address => txs.push(tx),
                _ => {
                    if let Some(finished) = carry.replace((address, vec![tx])) {
                        groups.push(finished);
                    }
                }
            }
        }
        if done {
            groups.extend(carry.take());
        }
        write(groups, &mut main, &mut paged)?;
        if done {
            break;
        }
    }
    main.flush().map_err(io_err)?;
    if let Some(p) = paged.as_mut() {
        p.flush().map_err(io_err)?;
    }
    println!("{}", json!({"addresses":addresses,"rows":rows,"pages":page_entries,"maxHeight":max_height,"seconds":start.elapsed().as_secs_f64()}));
    Ok(())
}

/// Address histories derived from a transaction records file, so the address
/// publications are exactly consistent with the transaction table and need no
/// extra replica export. Pass one writes one row per (address, transaction)
/// into hash partitions on disk; pass two groups each partition in memory.
pub(super) fn addresses_from_tx(records: &Path, summaries: &Path, pages: Option<&Path>) -> Result<(), String> {
    const PARTITIONS: usize = 64;
    // Partition row after the address: txid 32, height 4, tx index 4, time 8, value in 8, value out 8.
    const ROW: usize = 64;
    let start = Instant::now();
    let file = File::open(records).map_err(io_err)?;
    let data = unsafe { Mmap::map(&file) }.map_err(io_err)?;
    let mut index: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let len = u32::from_le_bytes(data.get(at + 32..at + 36).ok_or("truncated records file")?.try_into().unwrap()) as usize;
        index.push((at, len));
        at += 36 + len;
    }
    let work = summaries.with_extension("partitions");
    fs::create_dir_all(&work).map_err(io_err)?;
    let mut parts: Vec<BufWriter<File>> = (0..PARTITIONS)
        .map(|i| File::create(work.join(format!("{i:02}"))).map(|f| BufWriter::with_capacity(1 << 20, f)))
        .collect::<Result<_, _>>().map_err(io_err)?;
    let (mut rows, mut max_height) = (0u64, 0u32);
    for chunk in index.chunks(200_000) {
        let batch: Vec<Vec<(usize, Vec<u8>)>> = chunk.par_iter().map(|&(offset, len)| {
            let txid: [u8; 32] = data[offset..offset + 32].try_into().unwrap();
            let record = Record::decode(txid, &data[offset + 36..offset + 36 + len])?;
            let mut per: std::collections::BTreeMap<&str, (i64, i64)> = Default::default();
            for input in &record.inputs {
                if let (Some(address), Some(value)) = (&input.address, input.value) {
                    per.entry(address).or_default().0 += value;
                }
            }
            for output in &record.outputs {
                if let (Some(address), Some(value)) = (&output.address, output.value) {
                    per.entry(address).or_default().1 += value;
                }
            }
            Ok(per.into_iter().map(|(address, (value_in, value_out))| {
                let mut row = Vec::with_capacity(1 + address.len() + ROW);
                row.push(address.len() as u8);
                row.extend_from_slice(address.as_bytes());
                row.extend_from_slice(&record.txid);
                row.extend_from_slice(&record.height.to_le_bytes());
                row.extend_from_slice(&record.tx_index.unwrap_or(0).to_le_bytes());
                row.extend_from_slice(&record.block_time.to_le_bytes());
                row.extend_from_slice(&value_in.to_le_bytes());
                row.extend_from_slice(&value_out.to_le_bytes());
                let part = u64::from_le_bytes(sha2::Sha256::digest(address.as_bytes())[..8].try_into().unwrap()) as usize % PARTITIONS;
                (part, row)
            }).collect())
        }).collect::<Result<_, String>>()?;
        for (part, row) in batch.into_iter().flatten() {
            parts[part].write_all(&row).map_err(io_err)?;
            rows += 1;
        }
    }
    for part in &mut parts {
        part.flush().map_err(io_err)?;
    }
    drop(parts);
    let mut main = BufWriter::with_capacity(8 << 20, File::create(summaries).map_err(io_err)?);
    let mut paged = pages.map(|p| File::create(p).map(|f| BufWriter::with_capacity(8 << 20, f))).transpose().map_err(io_err)?;
    let (mut addresses, mut page_entries) = (0u64, 0u64);
    for i in 0..PARTITIONS {
        let path = work.join(format!("{i:02}"));
        let bytes = fs::read(&path).map_err(io_err)?;
        let mut groups: HashMap<String, Vec<AddressTx>> = HashMap::new();
        let mut at = 0;
        while at < bytes.len() {
            let len = bytes[at] as usize;
            let address = String::from_utf8(bytes[at + 1..at + 1 + len].to_vec()).map_err(|_| "address is not UTF-8")?;
            let r = bytes.get(at + 1 + len..at + 1 + len + ROW).ok_or("truncated address partition")?;
            let tx = AddressTx {
                txid: r[..32].try_into().unwrap(),
                height: u32::from_le_bytes(r[32..36].try_into().unwrap()),
                tx_index: u32::from_le_bytes(r[36..40].try_into().unwrap()),
                time: u64::from_le_bytes(r[40..48].try_into().unwrap()),
                value_in: i64::from_le_bytes(r[48..56].try_into().unwrap()),
                value_out: i64::from_le_bytes(r[56..64].try_into().unwrap()),
            };
            max_height = max_height.max(tx.height);
            groups.entry(address).or_default().push(tx);
            at += 1 + len + ROW;
        }
        fs::remove_file(&path).map_err(io_err)?;
        let encoded: Vec<Vec<([u8; 32], Vec<u8>, bool)>> = groups.into_par_iter()
            .map(|(address, rows)| AddressRecord::from_rows(&address, rows, paged.is_some()).into_iter().map(|(k, r)| (k, r.encode(), r.page > 0)).collect())
            .collect();
        for (key, body, is_page) in encoded.into_iter().flatten() {
            if body.len() > INLINE_MAX {
                return Err("address entry exceeds the inline limit".into());
            }
            let out = if is_page { page_entries += 1; paged.as_mut().unwrap() } else { addresses += 1; &mut main };
            out.write_all(&key).map_err(io_err)?;
            out.write_all(&(body.len() as u32).to_le_bytes()).map_err(io_err)?;
            out.write_all(&body).map_err(io_err)?;
        }
    }
    fs::remove_dir(&work).map_err(io_err)?;
    main.flush().map_err(io_err)?;
    if let Some(p) = paged.as_mut() {
        p.flush().map_err(io_err)?;
    }
    println!("{}", json!({"addresses":addresses,"rows":rows,"pages":page_entries,"maxHeight":max_height,"seconds":start.elapsed().as_secs_f64()}));
    Ok(())
}

// ---- build ---------------------------------------------------------------------

/// What a publication's records are.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Tx,
    Block,
    Address,
    AddressPage,
}

impl Kind {
    fn name(self) -> &'static str {
        match self { Kind::Tx => "tx", Kind::Block => "block", Kind::Address => "address", Kind::AddressPage => "address-page" }
    }

    fn preview(self, key: [u8; 32], full: &[u8], max: usize) -> Result<Vec<u8>, String> {
        match self {
            Kind::Tx => Ok(Record::decode(key, full)?.preview(max)),
            Kind::Block => Ok(BlockRecord::decode(full)?.preview(max)),
            Kind::Address | Kind::AddressPage => Ok(AddressRecord::decode(full)?.preview(max)),
        }
    }

    /// Height and block hash a record belongs to; None for block pointers.
    fn position(self, key: [u8; 32], body: &[u8]) -> Result<Option<(u32, [u8; 32])>, String> {
        match self {
            Kind::Tx => Record::decode(key, body).map(|r| Some((r.height, r.block_hash))),
            Kind::Block if body.first() == Some(&BLOCK_VERSION) => BlockRecord::decode(body).map(|b| Some((b.height, b.hash))),
            Kind::Block | Kind::Address | Kind::AddressPage => Ok(None),
        }
    }
}

fn write_overflow(maps: &mut [MmapMut], cursor: &mut u64, rows: usize, limit: u64, bytes: &[u8]) -> Result<u64, String> {
    let start = *cursor;
    if start + bytes.len() as u64 > limit {
        return Err("overflow table capacity exceeded".into());
    }
    // Offsets count payload bytes: global row g is local row g % rows of instance g / rows.
    let mut at = start;
    let mut remaining = bytes;
    while !remaining.is_empty() {
        let (global, offset) = ((at / PAYLOAD as u64) as usize, (at % PAYLOAD as u64) as usize);
        let (instance, row) = (global / rows, global % rows);
        let take = remaining.len().min(PAYLOAD - offset);
        let base = row * ROW_BYTES + offset;
        maps[instance][base..base + take].copy_from_slice(&remaining[..take]);
        remaining = &remaining[take..];
        at += take as u64;
    }
    *cursor = at;
    Ok(start)
}

/// Writes every row's Merkle path and returns each instance's root.
fn prove(maps: &mut [MmapMut], kind: &str, rows: usize) -> Vec<String> {
    maps.iter_mut()
        .enumerate()
        .map(|(instance, map)| {
            let leaves: Vec<[u8; 32]> = (0..rows).into_par_iter()
                .map(|r| layout::leaf(kind, instance as u32, r as u32, &map[r * ROW_BYTES..r * ROW_BYTES + PAYLOAD]))
                .collect();
            let levels = layout::merkle_levels(leaves);
            map.par_chunks_mut(ROW_BYTES).enumerate().for_each(|(r, row)| row[PAYLOAD..].copy_from_slice(&layout::path(&levels, r)));
            hex::encode(levels.last().unwrap()[0])
        })
        .collect()
}

fn table_files(dir: &Path, kind: &str, instances: usize, rows: usize) -> Result<Vec<MmapMut>, String> {
    (0..instances)
        .map(|i| {
            let file = OpenOptions::new().read(true).write(true).create_new(true)
                .open(dir.join(format!("{kind}-{i:02}.bin"))).map_err(io_err)?;
            file.set_len((rows * ROW_BYTES) as u64).map_err(io_err)?;
            unsafe { MmapMut::map_mut(&file) }.map_err(io_err)
        })
        .collect()
}

enum Body<'a> {
    Full(&'a [u8]),
    Preview { full: &'a [u8], bytes: Vec<u8> },
    /// Bitmap of a base transaction's outputs spent after the base snapshot.
    Spent(&'a [u8]),
}

impl<'a> Body<'a> {
    fn entry_bytes(&self) -> usize {
        ENTRY_HEADER + match self { Body::Full(full) | Body::Spent(full) => full.len(), Body::Preview { bytes, .. } => PREVIEW_POINTER + bytes.len() }
    }
    /// Halves the entry's preview budget; false when it cannot get smaller.
    fn shrink(&mut self, kind: Kind, txid: [u8; 32]) -> Result<bool, String> {
        let full: &'a [u8] = match self { Body::Full(full) | Body::Preview { full, .. } => full, Body::Spent(_) => return Ok(false) };
        let current = self.entry_bytes();
        let bytes = kind.preview(txid, full, (current - ENTRY_HEADER - PREVIEW_POINTER).min(PREVIEW_MAX) / 2)?;
        if ENTRY_HEADER + PREVIEW_POINTER + bytes.len() >= current {
            return Ok(false);
        }
        *self = Body::Preview { full, bytes };
        Ok(true)
    }
}

/// Spent markers for a recent publication: outputs of transactions outside
/// this records file (so in the base table) spent by a transaction in it.
fn spent_markers(data: &[u8], index: &[(usize, usize)]) -> Result<Vec<([u8; 32], Vec<u8>)>, String> {
    let txid_at = |i: usize| -> [u8; 32] { data[index[i].0..index[i].0 + 32].try_into().unwrap() };
    let own: HashSet<[u8; 32]> = (0..index.len()).map(txid_at).collect();
    let spends: Vec<Vec<([u8; 32], u32)>> = (0..index.len()).into_par_iter().map(|i| {
        let (offset, len) = index[i];
        let record = Record::decode(txid_at(i), &data[offset + 36..offset + 36 + len])?;
        Ok(record.inputs.iter().filter_map(|input| Some((input.prev_txid?, input.prev_vout?))).filter(|(prev, _)| !own.contains(prev)).collect())
    }).collect::<Result<_, String>>()?;
    let mut by_tx: HashMap<[u8; 32], Vec<u32>> = HashMap::new();
    for (prev, vout) in spends.into_iter().flatten() {
        by_tx.entry(prev).or_default().push(vout);
    }
    let mut markers: Vec<_> = by_tx.into_iter().map(|(txid, vouts)| (txid, spent_bitmap(vouts))).collect();
    markers.sort_unstable();
    Ok(markers)
}

/// `base_tip` marks a recent publication: blocks after the base snapshot,
/// plus spent markers for base transactions those blocks spend.
pub(super) fn build(records_path: &Path, dir: &Path, snapshot_tip: u64, base_tip: Option<u64>, kind: Kind) -> Result<(), String> {
    fs::create_dir(dir).map_err(io_err)?;
    let start = Instant::now();
    let file = File::open(records_path).map_err(io_err)?;
    let data = unsafe { Mmap::map(&file) }.map_err(io_err)?;
    let mut index: Vec<(usize, usize)> = Vec::new();
    let (mut estimate, mut overflow_bytes, mut large) = (0u64, 0u64, 0u64);
    let mut at = 0;
    while at < data.len() {
        let len = u32::from_le_bytes(data.get(at + 32..at + 36).ok_or("truncated records file")?.try_into().unwrap()) as usize;
        index.push((at, len));
        if len > INLINE_MAX {
            large += 1;
            overflow_bytes += len as u64;
            estimate += (ENTRY_HEADER + PREVIEW_POINTER + PREVIEW_MAX) as u64;
        } else {
            estimate += (ENTRY_HEADER + len) as u64;
        }
        at += 36 + len;
    }
    if at != data.len() {
        return Err("truncated records file".into());
    }
    let txid_at = |i: usize| -> [u8; 32] { data[index[i].0..index[i].0 + 32].try_into().unwrap() };
    // The tip block's hash anchors the publication to the public chain.
    let (tip_height, tip_hash) = (0..index.len()).into_par_iter()
        .map(|i| {
            let (offset, len) = index[i];
            kind.position(txid_at(i), &data[offset + 36..offset + 36 + len]).map(|p| p.unwrap_or((0, [0u8; 32])))
        })
        .try_reduce(|| (0, [0u8; 32]), |a, b| Ok(if b.0 > a.0 { b } else { a }))?;
    // Address entries carry no block hash; their tip is the export's bound.
    let addresses = matches!(kind, Kind::Address | Kind::AddressPage);
    if !addresses && u64::from(tip_height) != snapshot_tip {
        return Err(format!("records end at block {tip_height}, not the declared tip {snapshot_tip}"));
    }
    let markers = if base_tip.is_some() && kind == Kind::Tx { spent_markers(&data, &index)? } else { Vec::new() };
    // A block publication carries the public homepage feed: the same bytes
    // for every visitor, bound to the signed manifest by its hash.
    let feed = if kind == Kind::Block {
        let mut latest: Vec<BlockRecord> = (0..index.len()).into_par_iter()
            .filter_map(|i| {
                let (offset, len) = index[i];
                let body = &data[offset + 36..offset + 36 + len];
                (body.first() == Some(&BLOCK_VERSION)).then(|| BlockRecord::decode(body))
            })
            .collect::<Result<_, _>>()?;
        latest.sort_unstable_by(|a, b| b.height.cmp(&a.height));
        latest.truncate(10);
        let blocks: Vec<Value> = latest.iter().map(|b| json!({"height":b.height,"hash":hex::encode(b.hash),"timestamp":b.time,
            "transaction_count":b.tx_count,"size":b.size,"total_fees":b.total_fees.map(|f| f.to_string()),"miner_address":b.miner_address})).collect();
        // Transactions newest first (block height, then position), in the
        // public transaction-list shape; amounts are zatoshi strings.
        let newest = latest.iter().flat_map(|b| b.txs.iter().enumerate().rev().map(move |(i, t)| (b, i, t)));
        let tx_json = |(b, i, t): (&BlockRecord, usize, &BlockTx)| json!({
            "txid":hex::encode(t.txid),"block_height":b.height,"block_time":b.time,"timestamp":b.time,"tx_index":i,
            "vin_count":t.vin_count,"vout_count":t.vout_count,"is_coinbase":t.flags & 1 != 0,"has_sapling":t.flags & 2 != 0,
            "has_orchard":t.flags & 4 != 0,"has_ironwood":t.flags & 8 != 0,"has_sprout":t.flags & 16 != 0,"has_shielded":t.flags & 0b11110 != 0,
            "sapling_spend_count":t.sapling_spends,"sapling_output_count":t.sapling_outputs,"orchard_actions":t.orchard_actions,"ironwood_actions":t.ironwood_actions,
            "value_balance_sapling":t.value_balance_sapling.map(|v| v.to_string()),"value_balance_orchard":t.value_balance_orchard.map(|v| v.to_string()),
            "value_balance_ironwood":t.value_balance_ironwood.map(|v| v.to_string()),"total_output":t.total_output.map(|v| v.to_string()),
            "fee":t.fee.map(|v| v.to_string())});
        let txs: Vec<Value> = newest.take(10).map(tx_json).collect();
        let bytes = serde_json::to_vec(&json!({"snapshotTip":snapshot_tip,"blocks":blocks,"transactions":txs})).map_err(io_err)?;
        Some(bytes)
    } else {
        None
    };
    estimate += markers.iter().map(|(_, bitmap)| (ENTRY_HEADER + bitmap.len()) as u64).sum::<u64>();
    // Address entries are large (up to a full 50-transaction page), so their
    // buckets get more headroom against crowding.
    let fill = if matches!(kind, Kind::Address | Kind::AddressPage) { 0.6 } else { TARGET_FILL };
    let (instances, rows) = instance_rows((estimate as f64 / (PAYLOAD as f64 * fill)).ceil() as usize);
    let bucket_bytes = instances * PAYLOAD;
    // Items below index.len() are records; the rest are spent markers.
    let key_of = |item: usize| if item < index.len() { txid_at(item) } else { markers[item - index.len()].0 };
    let mut order: Vec<(u32, u32)> = (0..index.len() + markers.len()).into_par_iter().map(|i| (row_of(&key_of(i), rows as u64) as u32, i as u32)).collect();
    order.par_sort_unstable();
    // Demotions of small records also land in overflow; reserve a margin. A
    // recent table stays small, and its preparation time scales with rows.
    let floor: u64 = if base_tip.is_some() { 4 << 20 } else { 64 << 20 };
    let overflow_capacity = (overflow_bytes + overflow_bytes / 10 + floor) as usize;
    let (overflow_instances, overflow_rows) = instance_rows(overflow_capacity.div_ceil(PAYLOAD));
    let mut main = table_files(dir, "main", instances, rows)?;
    let mut overflow = table_files(dir, "overflow", overflow_instances, overflow_rows)?;
    let overflow_limit = (overflow_instances * overflow_rows * PAYLOAD) as u64;
    let (mut cursor, mut previews, mut demoted_small, mut demoted_buckets, mut max_used, mut total_used) = (0u64, 0u64, 0u64, 0u64, 0usize, 0u64);
    let mut buffer = vec![0u8; bucket_bytes];
    let mut dirty = 0;
    for group in order.chunk_by(|a, b| a.0 == b.0) {
        let bucket = group[0].0 as usize;
        let mut tags = HashSet::with_capacity(group.len());
        let mut entries: Vec<([u8; TAG], [u8; 32], Body)> = Vec::with_capacity(group.len());
        for &(_, i) in group {
            if i as usize >= index.len() {
                let (txid, bitmap) = &markers[i as usize - index.len()];
                if !tags.insert(spent_tag(txid)) {
                    return Err(format!("duplicate tag in bucket {bucket}"));
                }
                entries.push((spent_tag(txid), *txid, Body::Spent(bitmap)));
                continue;
            }
            let txid = txid_at(i as usize);
            let tag = <[u8; TAG]>::try_from(&txid[..TAG]).unwrap();
            if !tags.insert(tag) {
                return Err(format!("duplicate tag in bucket {bucket}"));
            }
            let (offset, len) = index[i as usize];
            let full = &data[offset + 36..offset + 36 + len];
            let body = if len <= INLINE_MAX {
                Body::Full(full)
            } else {
                Body::Preview { full, bytes: kind.preview(txid, full, PREVIEW_MAX)? }
            };
            entries.push((tag, txid, body));
        }
        let mut used: usize = BUCKET_HEADER + entries.iter().map(|(_, _, b)| b.entry_bytes()).sum::<usize>();
        if used > bucket_bytes {
            demoted_buckets += 1;
            let mut frozen = vec![false; entries.len()];
            while used > bucket_bytes {
                let pick = (0..entries.len()).filter(|&i| !frozen[i]).max_by_key(|&i| entries[i].2.entry_bytes())
                    .ok_or_else(|| format!("bucket {bucket} cannot fit even zero-list previews"))?;
                let (_, txid, body) = &mut entries[pick];
                let (before, was_full) = (body.entry_bytes(), matches!(body, Body::Full(_)));
                if body.shrink(kind, *txid)? {
                    used = used - before + body.entry_bytes();
                    demoted_small += u64::from(was_full);
                } else {
                    frozen[pick] = true;
                }
            }
        }
        buffer[..dirty.max(used).max(BUCKET_HEADER)].fill(0);
        dirty = used;
        buffer[..2].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        let mut at = BUCKET_HEADER;
        for (tag, _, body) in &entries {
            let (payload, flag) = match body {
                Body::Full(full) | Body::Spent(full) => (full.to_vec(), 0),
                Body::Preview { full, bytes } => {
                    previews += 1;
                    let start = write_overflow(&mut overflow, &mut cursor, overflow_rows, overflow_limit, full)?;
                    (preview_body(start, full.len(), bytes), PREVIEW_FLAG)
                }
            };
            buffer[at..at + TAG].copy_from_slice(tag);
            buffer[at + TAG..at + ENTRY_HEADER].copy_from_slice(&(payload.len() as u16 | flag).to_le_bytes());
            buffer[at + ENTRY_HEADER..at + ENTRY_HEADER + payload.len()].copy_from_slice(&payload);
            at += ENTRY_HEADER + payload.len();
        }
        for (instance, map) in main.iter_mut().enumerate() {
            map[bucket * ROW_BYTES..bucket * ROW_BYTES + PAYLOAD].copy_from_slice(&buffer[instance * PAYLOAD..(instance + 1) * PAYLOAD]);
        }
        max_used = max_used.max(at);
        total_used += at as u64;
    }
    let proving = Instant::now();
    let main_roots = prove(&mut main, "main", rows);
    let overflow_roots = prove(&mut overflow, "overflow", overflow_rows);
    let prove_seconds = proving.elapsed().as_secs_f64();
    for map in main.iter().chain(overflow.iter()) {
        map.flush().map_err(io_err)?;
    }
    let manifest = json!({"schema":layout::SCHEMA_NAME,"kind":kind.name(),"network":"mainnet","snapshotTip":snapshot_tip,"tipHash":hex::encode(tip_hash),
        "baseTip":base_tip,"spentMarkers":markers.len(),"payloadBytes":PAYLOAD,"proofDepth":{"main":layout::depth(rows),"overflow":layout::depth(overflow_rows)},
        "proveSeconds":prove_seconds,
        "records":index.len(),"rowBytes":ROW_BYTES,"builtAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io_err)?.as_secs(),
        "rowHashDomain":String::from_utf8_lossy(layout::ROW_HASH_DOMAIN),"tagBytes":TAG,"inlineMax":INLINE_MAX,"previewMax":PREVIEW_MAX,
        "main":{"instances":instances,"rows":rows,"roots":main_roots,"bucketBytes":bucket_bytes,"meanBucketBytesUsed":total_used as f64 / rows as f64,
            "maxBucketBytesUsed":max_used,"previews":previews,"demotedSmallRecords":demoted_small,"bucketsWithDemotions":demoted_buckets},
        "overflow":{"instances":overflow_instances,"rows":overflow_rows,"roots":overflow_roots,"bytesUsed":cursor,"largeRecords":large},
        "buildSeconds":start.elapsed().as_secs_f64()});
    let mut manifest = manifest;
    if let Some(feed) = &feed {
        fs::write(dir.join("feed.json"), feed).map_err(io_err)?;
        manifest["feedSha256"] = json!(hex::encode(sha2::Sha256::digest(feed)));
    }
    fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(io_err)?).map_err(io_err)?;
    println!("{manifest}");
    Ok(())
}

// ---- serve ---------------------------------------------------------------------

struct Table {
    profile: TableProfile,
    databases: Vec<Mmap>,
    blocks: Vec<Vec<NativePreprocessed>>,
    publics: Vec<Vec<u8>>,
}

/// Most selections answered by one pass over a table. The scan is bound by
/// memory bandwidth, so sharing it between waiting lookups raises throughput.
const MAX_BATCH: usize = 8;

impl Table {
    fn load(dir: &Path, kind: &str, instances: usize, rows: usize) -> Result<(Self, Value), String> {
        let profile = profile_for(kind, rows)?;
        let start = Instant::now();
        let mut table = Table { profile, databases: Vec::new(), blocks: Vec::new(), publics: Vec::new() };
        for i in 0..instances {
            let file = File::open(dir.join(format!("{kind}-{i:02}.bin"))).map_err(io_err)?;
            let map = unsafe { Mmap::map(&file) }.map_err(io_err)?;
            if map.len() != rows * ROW_BYTES {
                return Err(format!("{kind} instance {i} has the wrong size"));
            }
            let blocks = preprocess_blocks(&map, &table.profile)?;
            table.publics.push(table.profile.native.publish(&blocks)?);
            table.blocks.push(blocks);
            table.databases.push(map);
        }
        Ok((table, json!({"kind":kind,"instances":instances,"rows":rows,"preprocessSeconds":start.elapsed().as_secs_f64()})))
    }

    /// Replies for several uploads, in order, from one scan of each instance.
    /// Returns the replies plus the shared scan and total pack nanoseconds.
    fn answer_batch(&self, uploads: &[&[u8]]) -> Result<(Vec<Vec<u8>>, u128, u128), String> {
        let parsed: Vec<_> = uploads.iter().map(|u| self.profile.parse(u)).collect::<Result<_, _>>()?;
        let selections: Vec<&[u64]> = parsed.iter().map(|(_, s)| s.as_slice()).collect();
        let mut out: Vec<Vec<u8>> = vec![Vec::with_capacity(self.databases.len() * self.profile.scheme.response_bytes); uploads.len()];
        let (mut scan, mut pack) = (0, 0);
        for (database, blocks) in self.databases.iter().zip(&self.blocks) {
            let start = Instant::now();
            let intermediates = if selections.len() == 1 {
                vec![parallel_multiply(database, ROW_BYTES, selections[0])]
            } else {
                parallel_multiply_batch(database, ROW_BYTES, &selections, 16, 256)
            };
            scan += start.elapsed().as_nanos();
            let start = Instant::now();
            let packed: Vec<Vec<u8>> = parsed.par_iter().zip(&intermediates)
                .map(|((keys, _), intermediate)| self.profile.native.pack(blocks, keys, intermediate))
                .collect::<Result<_, _>>()?;
            pack += start.elapsed().as_nanos();
            for (reply, part) in out.iter_mut().zip(packed) {
                reply.extend(part);
            }
        }
        Ok((out, scan, pack))
    }
}

/// One loaded, signed publication (the base snapshot or a recent table),
/// addressed by a content id so a client never mixes public parameters and
/// queries across rebuilds.
struct Publication {
    id: String,
    target: PathBuf,
    manifest: Vec<u8>,
    signature: Vec<u8>,
    tip: u64,
    base_tip: Option<u64>,
    main: Arc<Table>,
    overflow: Arc<Table>,
}

pub(super) fn publication_id(manifest: &[u8]) -> String {
    hex::encode(&sha2::Sha256::digest(manifest)[..12])
}

impl Publication {
    fn load(target: &Path, pool: &rayon::ThreadPool) -> Result<Self, String> {
        let bytes = fs::read(target.join("manifest.json")).map_err(io_err)?;
        let signature = fs::read(target.join("manifest.sig")).map_err(|_| "publication is not signed".to_string())?;
        let manifest: Value = serde_json::from_slice(&bytes).map_err(io_err)?;
        if manifest["schema"] != layout::SCHEMA_NAME {
            return Err("unsupported publication schema".into());
        }
        let count = |kind: &str, field: &str| manifest[kind][field].as_u64().map(|v| v as usize).ok_or("bad manifest");
        let (main, _) = pool.install(|| Table::load(target, "main", count("main", "instances")?, count("main", "rows")?))?;
        let (overflow, _) = pool.install(|| Table::load(target, "overflow", count("overflow", "instances")?, count("overflow", "rows")?))?;
        Ok(Publication {
            id: publication_id(&bytes), target: target.to_owned(), signature,
            tip: manifest["snapshotTip"].as_u64().ok_or("bad manifest")?, base_tip: manifest["baseTip"].as_u64(),
            manifest: bytes, main: Arc::new(main), overflow: Arc::new(overflow),
        })
    }
}

type PublicationSet = Arc<RwLock<Vec<Arc<Publication>>>>;

/// Follows `<root>/current` for one publication set. Each set has its own
/// watcher thread, so a slow base load (minutes) never holds back the small
/// recent tables. A new base is loaded beside the old one and replaces it;
/// clients of the old one get 410 and reload. The newest `keep` recent tables
/// stay loaded so lookups started just before a swap can finish, and the
/// newest table built on the base currently served is always kept, even when
/// tables for a base that is still loading arrive first.
fn watch(root: PathBuf, set: PublicationSet, keep: usize, parent: Option<PublicationSet>, pool: Arc<rayon::ThreadPool>) {
    loop {
        if let Ok(target) = fs::canonicalize(root.join("current"))
            && !set.read().unwrap().iter().any(|p| p.target == target)
        {
            let start = Instant::now();
            match Publication::load(&target, &pool) {
                Ok(publication) => {
                    eprintln!("{}", json!({"loaded":target.display().to_string(),"id":publication.id,"tip":publication.tip,"seconds":start.elapsed().as_secs_f64()}));
                    let mut set = set.write().unwrap();
                    set.push(Arc::new(publication));
                    let served = parent.as_ref().and_then(|parent| parent.read().unwrap().last().map(|base| base.tip));
                    while set.len() > keep {
                        let protected = served.and_then(|tip| set.iter().rposition(|p| p.base_tip == Some(tip)));
                        let Some(oldest) = (0..set.len()).find(|&i| Some(i) != protected) else { break };
                        set.remove(oldest);
                    }
                }
                Err(error) => eprintln!("{}", json!({"loadError":error,"target":target.display().to_string()})),
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

/// A count-prefixed query body waiting for the scheduler.
struct Job {
    table: Arc<Table>,
    uploads: Vec<Vec<u8>>,
    queued: Instant,
    reply: mpsc::Sender<Result<(Vec<u8>, String), String>>,
}

/// Set EXPLORER_TIMING_HEADERS=1 to report server timing and batch size.
fn timing_headers() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("EXPLORER_TIMING_HEADERS").is_ok_and(|v| v == "1"))
}

fn split_uploads(body: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let count = body.get(..4).map(|c| u32::from_le_bytes(c.try_into().unwrap()) as usize).ok_or("missing upload count")?;
    let body = &body[4..];
    if count == 0 || count > 256 || body.len() % count != 0 {
        return Err("bad upload length".into());
    }
    Ok(body.chunks(body.len() / count).map(<[u8]>::to_vec).collect())
}

/// Runs queued jobs. Each round takes the oldest job and every other waiting
/// job for the same table, up to MAX_BATCH selections, and answers them all
/// from one scan. A job larger than the cap (a padded full-record fetch) runs
/// in chunks of MAX_BATCH.
fn schedule(jobs: mpsc::Receiver<Job>, pool: rayon::ThreadPool) {
    let mut waiting: std::collections::VecDeque<Job> = Default::default();
    loop {
        if waiting.is_empty() {
            match jobs.recv() {
                Ok(job) => waiting.push_back(job),
                Err(_) => return,
            }
        }
        while let Ok(job) = jobs.try_recv() {
            waiting.push_back(job);
        }
        let first = waiting.pop_front().unwrap();
        let mut batch = vec![first];
        let mut selections = batch[0].uploads.len();
        let mut rest = std::collections::VecDeque::new();
        while let Some(job) = waiting.pop_front() {
            if Arc::ptr_eq(&job.table, &batch[0].table) && selections + job.uploads.len() <= MAX_BATCH {
                selections += job.uploads.len();
                batch.push(job);
            } else {
                rest.push_back(job);
            }
        }
        waiting = rest;
        let table = batch[0].table.clone();
        let started = Instant::now();
        let uploads: Vec<&[u8]> = batch.iter().flat_map(|job| job.uploads.iter().map(Vec::as_slice)).collect();
        let answered = uploads.chunks(MAX_BATCH)
            .map(|chunk| pool.install(|| table.answer_batch(chunk)))
            .collect::<Result<Vec<_>, String>>();
        match answered {
            Err(error) => batch.into_iter().for_each(|job| { let _ = job.reply.send(Err(error.clone())); }),
            Ok(parts) => {
                let (scan, pack): (u128, u128) = (parts.iter().map(|p| p.1).sum(), parts.iter().map(|p| p.2).sum());
                let mut replies = parts.into_iter().flat_map(|p| p.0);
                let server = started.elapsed().as_nanos();
                for job in batch {
                    let body: Vec<u8> = replies.by_ref().take(job.uploads.len()).flatten().collect();
                    // Timing and batch size are diagnostics; production replies omit them.
                    let headers = if timing_headers() {
                        format!("X-Server-Ns: {server}\r\nX-Scan-Ns: {scan}\r\nX-Pack-Ns: {pack}\r\nX-Queue-Ns: {}\r\nX-Batch: {selections}\r\n",
                            started.duration_since(job.queued).as_nanos())
                    } else {
                        String::new()
                    };
                    let _ = job.reply.send(Ok((body, headers)));
                }
            }
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(io_err)?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(io_err)?;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).map_err(io_err)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().map_err(|_| "bad content length")?;
        }
    }
    if length > 64 << 20 {
        return Err("request body too large".into());
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(io_err)?;
    let mut parts = line.split_whitespace();
    Ok((format!("{} {}", parts.next().unwrap_or(""), parts.next().unwrap_or("")), body))
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, extra: &str, body: &[u8]) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len())?;
    stream.write_all(body)
}

/// Everything a connection thread needs; query work goes to the scheduler.
struct Shared {
    sets: Vec<(&'static str, Option<&'static str>, PublicationSet)>,
    web: Option<PathBuf>,
    jobs: Mutex<mpsc::Sender<Job>>,
}

/// Publication sets under the serving root: each base set, and the recent
/// set that extends it. Only `base` is required.
const SETS: [(&str, Option<&str>, usize); 7] = [("base", None, 1), ("recent", Some("base"), 8), ("blocks", None, 1), ("blocks-recent", Some("blocks"), 8),
    ("addresses", None, 1), ("addresses-recent", Some("addresses"), 8), ("address-pages", None, 1)];

impl Shared {
    fn query(&self, table: Arc<Table>, body: &[u8]) -> Result<(Vec<u8>, String), String> {
        let (reply, answer) = mpsc::channel();
        let job = Job { table, uploads: split_uploads(body)?, queued: Instant::now(), reply };
        self.jobs.lock().unwrap().send(job).map_err(|_| "scheduler stopped".to_string())?;
        answer.recv().map_err(|_| "scheduler stopped".to_string())?
    }

    fn set(&self, name: &str) -> Option<&(&'static str, Option<&'static str>, PublicationSet)> {
        self.sets.iter().find(|(n, _, _)| *n == name)
    }

    /// A base set's loaded publication, or the newest recent table built on
    /// its base's current publication.
    fn current(&self, name: &str) -> Option<Arc<Publication>> {
        let (_, parent, set) = self.set(name)?;
        match parent {
            None => set.read().unwrap().last().cloned(),
            Some(parent) => {
                let tip = self.current(parent)?.tip;
                set.read().unwrap().iter().rev().find(|p| p.base_tip == Some(tip)).cloned()
            }
        }
    }

    fn handle(&self, stream: &mut TcpStream) -> Result<(), String> {
        let (route, body) = read_request(stream)?;
        let manifest = |stream: &mut TcpStream, p: Option<Arc<Publication>>| match p {
            Some(p) => respond(stream, "200 OK", "application/json", &format!("X-Publication-Id: {}\r\nCache-Control: no-store\r\n", p.id), &p.manifest).map_err(io_err),
            None => respond(stream, "404 Not Found", "text/plain", "", b"no publication").map_err(io_err),
        };
        let path = route.split_once(' ').map(|(_, p)| p.trim_start_matches('/')).unwrap_or("");
        let named = path.split_once('/').and_then(|(name, rest)| self.set(name).map(|s| (s, rest)));
        match (route.as_str(), named) {
            ("GET /manifest", _) => manifest(stream, self.current("base")),
            (_, Some(((name, _, _), "manifest"))) if route.starts_with("GET ") => manifest(stream, self.current(name)),
            (r, Some(((_, _, set), rest))) => {
                let (id, rest) = rest.split_once('/').ok_or("bad path")?;
                let Some(publication) = set.read().unwrap().iter().find(|p| p.id == id).cloned() else {
                    return respond(stream, "410 Gone", "text/plain", "", b"publication replaced").map_err(io_err);
                };
                let table = |name: &str| match name { "main" => Ok(publication.main.clone()), "overflow" => Ok(publication.overflow.clone()), _ => Err("unknown table".to_string()) };
                match (r.starts_with("POST"), rest.split_once('/').unwrap_or((rest, ""))) {
                    (false, ("manifest.sig", "")) => respond(stream, "200 OK", "application/octet-stream", "", &publication.signature).map_err(io_err),
                    (false, ("feed.json", "")) => match fs::read(publication.target.join("feed.json")) {
                        Ok(feed) => respond(stream, "200 OK", "application/json", "Cache-Control: no-store\r\n", &feed).map_err(io_err),
                        Err(_) => respond(stream, "404 Not Found", "text/plain", "", b"no feed").map_err(io_err),
                    },
                    (false, ("publics", kind)) => respond(stream, "200 OK", "application/octet-stream", "", &table(kind)?.publics.concat()).map_err(io_err),
                    (true, ("query", kind)) => {
                        let (out, timing) = self.query(table(kind)?, &body)?;
                        respond(stream, "200 OK", "application/octet-stream", &timing, &out).map_err(io_err)
                    }
                    _ => respond(stream, "404 Not Found", "text/plain", "", b"not found").map_err(io_err),
                }
            }
            (r, None) if r.starts_with("GET /") && self.web.is_some() && !r.contains("..") => {
                let name = match r["GET /".len()..].split('?').next().unwrap_or("") { "" => "index.html", other => other };
                let kind = match name.rsplit('.').next() {
                    Some("html") => "text/html; charset=utf-8",
                    Some("js") => "text/javascript",
                    Some("wasm") => "application/wasm",
                    Some("css") => "text/css",
                    Some("woff2") => "font/woff2",
                    Some("png") => "image/png",
                    Some("svg") => "image/svg+xml",
                    _ => "application/octet-stream",
                };
                match fs::read(self.web.as_ref().unwrap().join(name)) {
                    Ok(bytes) => respond(stream, "200 OK", kind, "Cache-Control: no-store\r\n", &bytes).map_err(io_err),
                    Err(_) => respond(stream, "404 Not Found", "text/plain", "", b"not found").map_err(io_err),
                }
            }
            _ => respond(stream, "404 Not Found", "text/plain", "", b"not found").map_err(io_err),
        }
    }
}

/// Most connections handled at once; further ones get 503.
const MAX_CONNECTIONS: usize = 256;

/// `root` holds one directory per publication set (see SETS), each with a
/// `current` symlink to a signed publication; all are followed and swapped
/// without a restart.
pub(super) fn serve(root: &Path, port: u16, threads: usize, web: Option<&Path>) -> Result<(), String> {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(io_err)?;
    let loader = Arc::new(rayon::ThreadPoolBuilder::new().num_threads(threads.min(4)).build().map_err(io_err)?);
    let sets: Vec<_> = SETS.iter().map(|&(name, parent, _)| (name, parent, PublicationSet::default())).collect();
    // The first base loads with every thread before the listener opens.
    let first = fs::canonicalize(root.join("base/current")).map_err(|_| "no base publication under root".to_string())?;
    let start = Instant::now();
    sets[0].2.write().unwrap().push(Arc::new(Publication::load(&first, &pool)?));
    eprintln!("{}", json!({"loaded":first.display().to_string(),"seconds":start.elapsed().as_secs_f64(),"threads":threads,"maxBatch":MAX_BATCH}));
    // Base sets load on one pool and the small recent tables on another, so
    // a recent table is never queued behind a multi-gigabyte base load.
    let recent_loader = Arc::new(rayon::ThreadPoolBuilder::new().num_threads(2).build().map_err(io_err)?);
    for (&(name, parent, keep), (_, _, set)) in SETS.iter().zip(&sets) {
        let parent = parent.and_then(|parent| sets.iter().find(|(n, _, _)| *n == parent)).map(|(_, _, set)| set.clone());
        let pool = if parent.is_some() { recent_loader.clone() } else { loader.clone() };
        let (root, set) = (root.join(name), set.clone());
        std::thread::spawn(move || watch(root, set, keep, parent, pool));
    }
    let (sender, jobs) = mpsc::channel();
    std::thread::spawn(move || schedule(jobs, pool));
    let shared = Arc::new(Shared { sets, web: web.map(Path::to_owned), jobs: Mutex::new(sender) });
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(io_err)?;
    eprintln!("Private explorer listening on http://127.0.0.1:{port}");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        if active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_CONNECTIONS {
            active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            eprintln!("{}", json!({"requestError":"busy","status":503}));
            let _ = respond(&mut stream, "503 Service Unavailable", "text/plain", "Retry-After: 1\r\n", b"busy");
            continue;
        }
        let (shared, active) = (shared.clone(), active.clone());
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
            if let Err(error) = shared.handle(&mut stream) {
                // Failed requests are logged by reason only: no address, body or timing.
                eprintln!("{}", json!({"requestError":error,"status":400}));
                let _ = respond(&mut stream, "400 Bad Request", "text/plain", "", error.as_bytes());
            }
            active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        });
    }
    Ok(())
}

// ---- lookup client ---------------------------------------------------------------

struct Http {
    addr: String,
}

impl Http {
    fn call(&self, method: &str, path: &str, body: &[u8]) -> Result<(Vec<u8>, BTreeMap<String, String>), String> {
        let mut stream = TcpStream::connect(&self.addr).map_err(io_err)?;
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", self.addr, body.len()).map_err(io_err)?;
        stream.write_all(body).map_err(io_err)?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(io_err)?;
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad HTTP response")?;
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let mut lines = head.lines();
        let status = lines.next().unwrap_or("");
        if !status.contains(" 200 ") {
            return Err(format!("{status}: {}", String::from_utf8_lossy(&raw[split + 4..])));
        }
        let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
        Ok((raw[split + 4..].to_vec(), headers))
    }
}

struct Remote {
    kind: &'static str,
    profile: TableProfile,
    publics: Vec<Vec<u8>>,
    side: publication::Side,
    /// Route prefix: "/base/<id>" or "/recent/<id>".
    prefix: String,
}

impl Remote {
    fn fetch(http: &Http, cache: &Path, side: publication::Side, kind: &'static str, prefix: &str) -> Result<Self, String> {
        let profile = profile_for(kind, side.rows)?;
        let path = cache.join(format!("{kind}.publics"));
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                let (bytes, _) = http.call("GET", &format!("{prefix}/publics/{kind}"), &[])?;
                fs::write(&path, &bytes).map_err(io_err)?;
                bytes
            }
        };
        let size = profile.scheme.public_bytes;
        if bytes.len() != size * side.instances {
            return Err(format!("{kind} public parameters have the wrong length"));
        }
        Ok(Remote { kind, publics: bytes.chunks(size).map(<[u8]>::to_vec).collect(), profile, side, prefix: prefix.to_owned() })
    }

    /// Verified payloads of each local row of every instance, one shared
    /// upload per row.
    fn rows(&self, http: &Http, label: &str, local_rows: &[usize], timing: &mut BTreeMap<String, u128>) -> Result<Vec<Vec<Vec<u8>>>, String> {
        let start = Instant::now();
        let (secrets, uploads): (Vec<_>, Vec<_>) = local_rows.iter().map(|&r| self.profile.prepare(r)).collect::<Result<Vec<_>, _>>()?.into_iter().unzip();
        *timing.entry(format!("{label}ClientPrepareNs")).or_default() += start.elapsed().as_nanos();
        let start = Instant::now();
        let mut body = (uploads.len() as u32).to_le_bytes().to_vec();
        body.extend(uploads.concat());
        let (reply, headers) = http.call("POST", &format!("{}/query/{}", self.prefix, self.kind), &body)?;
        *timing.entry(format!("{label}RoundTripNs")).or_default() += start.elapsed().as_nanos();
        for (name, header) in [("ServerNs", "x-server-ns"), ("ScanNs", "x-scan-ns"), ("PackNs", "x-pack-ns"), ("QueueNs", "x-queue-ns"), ("Batch", "x-batch")] {
            *timing.entry(format!("{label}{name}")).or_default() += headers.get(header).and_then(|v| v.parse().ok()).unwrap_or(0);
        }
        *timing.entry(format!("{label}UploadBytes")).or_default() += uploads.iter().map(|u| u.len() as u128).sum::<u128>();
        *timing.entry(format!("{label}ReplyBytes")).or_default() += reply.len() as u128;
        let size = self.profile.scheme.response_bytes;
        if reply.len() != local_rows.len() * self.publics.len() * size {
            return Err("unexpected reply length".into());
        }
        let start = Instant::now();
        let decoded = reply
            .chunks(size * self.publics.len())
            .zip(secrets.iter().zip(local_rows))
            .map(|(replies, (secret, &row))| {
                replies.chunks(size).zip(&self.publics).enumerate().map(|(instance, (r, p))| {
                    let bytes = self.profile.decode(secret, p, r)?;
                    Ok(layout::verify_row(self.kind, instance as u32, row as u32, &bytes, &self.side.roots[instance], self.side.depth)?.to_vec())
                }).collect()
            })
            .collect::<Result<Vec<Vec<_>>, String>>()?;
        *timing.entry(format!("{label}ClientDecodeNs")).or_default() += start.elapsed().as_nanos();
        Ok(decoded)
    }
}

/// A signed publication's two tables: the base snapshot, or the recent blocks.
struct RemotePublication {
    main: Remote,
    overflow: Remote,
    tip: u64,
}

impl RemotePublication {
    /// Fetches `<set>` manifest and signature, verifies them, then the publics.
    fn open(http: &Http, cache: &Path, set: &str) -> Result<Option<Self>, String> {
        let path = if set == "base" { "/manifest" } else { "/recent/manifest" };
        let manifest = match http.call("GET", path, &[]) {
            Ok((bytes, _)) => bytes,
            Err(error) if set == "recent" && error.contains(" 404 ") => return Ok(None),
            Err(error) => return Err(error),
        };
        let id = publication_id(&manifest);
        let prefix = format!("/{set}/{id}");
        let (signature, _) = http.call("GET", &format!("{prefix}/manifest.sig"), &[])?;
        let verified = publication::verify(&manifest, &signature)?;
        let cache = cache.join(&id);
        fs::create_dir_all(&cache).map_err(io_err)?;
        Ok(Some(RemotePublication {
            tip: verified.tip,
            main: Remote::fetch(http, &cache, verified.main, "main", &prefix)?,
            overflow: Remote::fetch(http, &cache, verified.overflow, "overflow", &prefix)?,
        }))
    }

    fn bucket(&self, http: &Http, label: &str, txid: &[u8; 32], timing: &mut BTreeMap<String, u128>) -> Result<Vec<u8>, String> {
        Ok(self.main.rows(http, label, &[row_of(txid, self.main.side.rows as u64) as usize], timing)?.remove(0).concat())
    }
}

pub(super) fn lookup(addr: &str, txid_hex: &str, cache: &Path, full: bool) -> Result<(), String> {
    let txid: [u8; 32] = hex::decode(txid_hex).ok().and_then(|b| b.try_into().ok()).ok_or("txid must be 64 hex characters")?;
    let total = Instant::now();
    let http = Http { addr: addr.to_owned() };
    let mut timing = BTreeMap::new();
    let start = Instant::now();
    let base = RemotePublication::open(&http, cache, "base")?.ok_or("no base publication")?;
    // No recent publication yet is a normal state: every client then asks the base only.
    let recent = RemotePublication::open(&http, cache, "recent")?;
    timing.insert("publicParamsNs".into(), start.elapsed().as_nanos());
    let tip = recent.as_ref().map_or(base.tip, |r| r.tip);
    // Every lookup asks both tables with the same shape, found or not.
    let base_bucket = base.bucket(&http, "main", &txid, &mut timing)?;
    let recent_bucket = recent.as_ref().map(|r| r.bucket(&http, "recentMain", &txid, &mut timing)).transpose()?;
    let (owner, entry) = match recent_bucket.as_ref().map(|b| layout::find(b, &txid)).transpose()? {
        Some(entry) if entry != layout::Entry::Absent => (recent.as_ref(), entry),
        _ => (Some(&base), layout::find(&base_bucket, &txid)?),
    };
    let spent_since: Vec<u32> = match (&recent_bucket, std::ptr::eq(owner.unwrap(), &base)) {
        (Some(bucket), true) => layout::find_spent(bucket, &txid)?.unwrap_or_default(),
        _ => Vec::new(),
    };
    let owner = owner.unwrap();
    let mut partial = false;
    let record = match entry {
        layout::Entry::Absent => None,
        layout::Entry::Inline(body) => Some(body),
        layout::Entry::Preview { preview, .. } if !full => {
            partial = true;
            Some(preview)
        }
        layout::Entry::Preview { start, len, .. } => {
            let wanted: Vec<usize> = layout::overflow_rows(start, len).map(|g| g as usize).collect();
            let first = wanted[0];
            // Padding repeats the first row; the server cannot see which rows.
            let rows = owner.overflow.side.rows;
            let mut asked: Vec<usize> = wanted.iter().map(|g| g % rows).collect();
            asked.resize(layout::padded_rows(wanted.len()), asked[0]);
            // The other publication gets the same number of dummy queries, so
            // the server cannot tell an old large transaction from a recent one.
            for other in [Some(&base), recent.as_ref()].into_iter().flatten().filter(|p| !std::ptr::eq(*p, owner)) {
                other.overflow.rows(&http, "dummyOverflow", &vec![0; asked.len()], &mut timing)?;
            }
            let fetched = owner.overflow.rows(&http, "overflow", &asked, &mut timing)?;
            let bytes: Vec<u8> = wanted.iter().zip(&fetched).flat_map(|(g, per)| per[g / rows].clone()).collect();
            timing.insert("overflowRows".into(), asked.len() as u128);
            Some(bytes[start as usize - first * PAYLOAD..][..len].to_vec())
        }
    };
    let result = match record {
        None => json!({"found":false,"txid":txid_hex}),
        Some(bytes) => {
            let mut record = Record::decode(txid, &bytes)?;
            for output in &mut record.outputs {
                output.spent |= spent_since.contains(&output.index);
            }
            let mut json = record.to_json();
            json["confirmations"] = json!(tip.saturating_sub(json["blockHeight"].as_u64().unwrap_or(0)) + 1);
            json["found"] = json!(true);
            json["verified"] = json!(true);
            json["partial"] = json!(partial);
            json["fromRecent"] = json!(!std::ptr::eq(owner, &base));
            json["outputsSpentSinceBase"] = json!(spent_since);
            json
        }
    };
    timing.insert("totalNs".into(), total.elapsed().as_nanos());
    let ms: BTreeMap<_, _> = timing.iter().map(|(k, v)| {
        if k.ends_with("Ns") { (k.trim_end_matches("Ns").to_owned() + "Ms", json!((*v as f64 / 1e6 * 10.0).round() / 10.0)) } else { (k.clone(), json!(*v as u64)) }
    }).collect();
    println!("{}", serde_json::to_string_pretty(&json!({"baseTip":base.tip,"tip":tip,"result":result,"timing":ms})).map_err(io_err)?);
    Ok(())
}

pub(super) fn default_cache() -> PathBuf {
    std::env::temp_dir().join("zecblock-private-explorer-cache")
}
