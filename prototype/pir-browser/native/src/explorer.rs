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
use super::explorer_record::{Record, parse_export_line};
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

use super::explorer_record::layout::{self, BUCKET_HEADER, ENTRY_HEADER, PREVIEW_FLAG, ROW_BYTES, TAG, preview_body, row_of, spent_bitmap, spent_tag};
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

// ---- build ---------------------------------------------------------------------

fn write_overflow(maps: &mut [MmapMut], cursor: &mut u64, rows: usize, limit: u64, bytes: &[u8]) -> Result<u64, String> {
    let start = *cursor;
    if start + bytes.len() as u64 > limit {
        return Err("overflow table capacity exceeded".into());
    }
    let instance_bytes = (rows * ROW_BYTES) as u64;
    let mut at = start;
    let mut remaining = bytes;
    while !remaining.is_empty() {
        let (instance, offset) = ((at / instance_bytes) as usize, (at % instance_bytes) as usize);
        let take = remaining.len().min(instance_bytes as usize - offset);
        maps[instance][offset..offset + take].copy_from_slice(&remaining[..take]);
        remaining = &remaining[take..];
        at += take as u64;
    }
    *cursor = at;
    Ok(start)
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
    fn shrink(&mut self, txid: [u8; 32]) -> Result<bool, String> {
        let full: &'a [u8] = match self { Body::Full(full) | Body::Preview { full, .. } => full, Body::Spent(_) => return Ok(false) };
        let current = self.entry_bytes();
        let bytes = Record::decode(txid, full)?.preview((current - ENTRY_HEADER - PREVIEW_POINTER).min(PREVIEW_MAX) / 2);
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
pub(super) fn build(records_path: &Path, dir: &Path, snapshot_tip: u64, base_tip: Option<u64>) -> Result<(), String> {
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
    let markers = if base_tip.is_some() { spent_markers(&data, &index)? } else { Vec::new() };
    estimate += markers.iter().map(|(_, bitmap)| (ENTRY_HEADER + bitmap.len()) as u64).sum::<u64>();
    let (instances, rows) = instance_rows((estimate as f64 / (ROW_BYTES as f64 * TARGET_FILL)).ceil() as usize);
    let bucket_bytes = instances * ROW_BYTES;
    // Items below index.len() are records; the rest are spent markers.
    let key_of = |item: usize| if item < index.len() { txid_at(item) } else { markers[item - index.len()].0 };
    let mut order: Vec<(u32, u32)> = (0..index.len() + markers.len()).into_par_iter().map(|i| (row_of(&key_of(i), rows as u64) as u32, i as u32)).collect();
    order.par_sort_unstable();
    // Demotions of small records also land in overflow; reserve a margin. A
    // recent table stays small, and its preparation time scales with rows.
    let floor: u64 = if base_tip.is_some() { 4 << 20 } else { 64 << 20 };
    let overflow_capacity = (overflow_bytes + overflow_bytes / 10 + floor) as usize;
    let (overflow_instances, overflow_rows) = instance_rows(overflow_capacity.div_ceil(ROW_BYTES));
    let mut main = table_files(dir, "main", instances, rows)?;
    let mut overflow = table_files(dir, "overflow", overflow_instances, overflow_rows)?;
    let overflow_limit = (overflow_instances * overflow_rows * ROW_BYTES) as u64;
    let (mut cursor, mut previews, mut demoted_small, mut demoted_buckets, mut max_used, mut total_used) = (0u64, 0u64, 0u64, 0u64, 0usize, 0u64);
    let mut buffer = vec![0u8; bucket_bytes];
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
                Body::Preview { full, bytes: Record::decode(txid, full)?.preview(PREVIEW_MAX) }
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
                if body.shrink(*txid)? {
                    used = used - before + body.entry_bytes();
                    demoted_small += u64::from(was_full);
                } else {
                    frozen[pick] = true;
                }
            }
        }
        buffer[..used.max(BUCKET_HEADER)].fill(0);
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
            map[bucket * ROW_BYTES..(bucket + 1) * ROW_BYTES].copy_from_slice(&buffer[instance * ROW_BYTES..(instance + 1) * ROW_BYTES]);
        }
        max_used = max_used.max(at);
        total_used += at as u64;
    }
    for map in main.iter().chain(overflow.iter()) {
        map.flush().map_err(io_err)?;
    }
    let manifest = json!({"schema":layout::SCHEMA_NAME,"snapshotTip":snapshot_tip,"baseTip":base_tip,"spentMarkers":markers.len(),
        "records":index.len(),"rowBytes":ROW_BYTES,"builtAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io_err)?.as_secs(),
        "rowHashDomain":String::from_utf8_lossy(layout::ROW_HASH_DOMAIN),"tagBytes":TAG,"inlineMax":INLINE_MAX,"previewMax":PREVIEW_MAX,
        "main":{"instances":instances,"rows":rows,"bucketBytes":bucket_bytes,"meanBucketBytesUsed":total_used as f64 / rows as f64,
            "maxBucketBytesUsed":max_used,"previews":previews,"demotedSmallRecords":demoted_small,"bucketsWithDemotions":demoted_buckets},
        "overflow":{"instances":overflow_instances,"rows":overflow_rows,"bytesUsed":cursor,"largeRecords":large},
        "buildSeconds":start.elapsed().as_secs_f64()});
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

/// One loaded publication of the recent table, addressed by a content id so
/// a client never mixes public parameters and queries across rebuilds.
struct Recent {
    id: String,
    target: PathBuf,
    manifest: Vec<u8>,
    main: Arc<Table>,
    overflow: Arc<Table>,
}

impl Recent {
    fn load(target: &Path, pool: &rayon::ThreadPool) -> Result<Self, String> {
        let bytes = fs::read(target.join("manifest.json")).map_err(io_err)?;
        let mut manifest: Value = serde_json::from_slice(&bytes).map_err(io_err)?;
        if manifest["schema"] != layout::SCHEMA_NAME || manifest["baseTip"].as_u64().is_none() {
            return Err("not a recent publication".into());
        }
        let count = |kind: &str, field: &str| manifest[kind][field].as_u64().map(|v| v as usize).ok_or("bad recent manifest");
        let (main, _) = pool.install(|| Table::load(target, "main", count("main", "instances")?, count("main", "rows")?))?;
        let (overflow, _) = pool.install(|| Table::load(target, "overflow", count("overflow", "instances")?, count("overflow", "rows")?))?;
        let id = hex::encode(&sha2::Sha256::digest(&bytes)[..12]);
        manifest["id"] = json!(id);
        Ok(Recent { id, target: target.to_owned(), manifest: serde_json::to_vec(&manifest).map_err(io_err)?, main: Arc::new(main), overflow: Arc::new(overflow) })
    }
}

type RecentSet = Arc<RwLock<Vec<Arc<Recent>>>>;

/// Follows `<root>/current`; keeps the newest two publications so lookups
/// started just before a swap can still finish.
fn watch_recent(root: PathBuf, set: RecentSet) {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().expect("recent loader pool");
    loop {
        if let Ok(target) = fs::canonicalize(root.join("current")) {
            let loaded = set.read().unwrap().last().map(|r| r.target.clone());
            if loaded.as_ref() != Some(&target) {
                let start = Instant::now();
                match Recent::load(&target, &pool) {
                    Ok(recent) => {
                        eprintln!("{}", json!({"recentLoaded":target.display().to_string(),"id":recent.id,"seconds":start.elapsed().as_secs_f64()}));
                        let mut set = set.write().unwrap();
                        set.push(Arc::new(recent));
                        let excess = set.len().saturating_sub(2);
                        set.drain(..excess);
                    }
                    Err(error) => eprintln!("{}", json!({"recentLoadError":error,"target":target.display().to_string()})),
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
}

/// A count-prefixed query body waiting for the scheduler.
struct Job {
    table: Arc<Table>,
    uploads: Vec<Vec<u8>>,
    queued: Instant,
    reply: mpsc::Sender<Result<(Vec<u8>, String), String>>,
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
                    let headers = format!("X-Server-Ns: {server}\r\nX-Scan-Ns: {scan}\r\nX-Pack-Ns: {pack}\r\nX-Queue-Ns: {}\r\nX-Batch: {selections}\r\n",
                        started.duration_since(job.queued).as_nanos());
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
    manifest: Vec<u8>,
    main: Arc<Table>,
    overflow: Arc<Table>,
    recent: RecentSet,
    web: Option<PathBuf>,
    jobs: Mutex<mpsc::Sender<Job>>,
}

impl Shared {
    fn query(&self, table: Arc<Table>, body: &[u8]) -> Result<(Vec<u8>, String), String> {
        let (reply, answer) = mpsc::channel();
        let job = Job { table, uploads: split_uploads(body)?, queued: Instant::now(), reply };
        self.jobs.lock().unwrap().send(job).map_err(|_| "scheduler stopped".to_string())?;
        answer.recv().map_err(|_| "scheduler stopped".to_string())?
    }

    fn handle(&self, stream: &mut TcpStream) -> Result<(), String> {
        let (route, body) = read_request(stream)?;
        let table = |name: &str| match name { "main" => Ok(self.main.clone()), "overflow" => Ok(self.overflow.clone()), _ => Err("unknown table".to_string()) };
        match route.as_str() {
            "GET /manifest" => respond(stream, "200 OK", "application/json", "", &self.manifest).map_err(io_err),
            r if r.starts_with("GET /publics/") => respond(stream, "200 OK", "application/octet-stream", "", &table(&r["GET /publics/".len()..])?.publics.concat()).map_err(io_err),
            r if r.starts_with("GET /public/") => {
                let mut parts = r["GET /public/".len()..].split('/');
                let t = table(parts.next().unwrap_or(""))?;
                let i: usize = parts.next().and_then(|p| p.parse().ok()).ok_or("bad instance")?;
                respond(stream, "200 OK", "application/octet-stream", "", t.publics.get(i).ok_or("bad instance")?).map_err(io_err)
            }
            r if r.starts_with("POST /query/") => {
                let (out, timing) = self.query(table(&r["POST /query/".len()..])?, &body)?;
                respond(stream, "200 OK", "application/octet-stream", &timing, &out).map_err(io_err)
            }
            "GET /recent/manifest" => match self.recent.read().unwrap().last() {
                Some(current) => respond(stream, "200 OK", "application/json", "", &current.manifest).map_err(io_err),
                None => respond(stream, "404 Not Found", "text/plain", "", b"no recent publication").map_err(io_err),
            },
            r if r.starts_with("GET /recent/") || r.starts_with("POST /recent/") => {
                let path = &r[r.find("/recent/").unwrap() + "/recent/".len()..];
                let (id, rest) = path.split_once('/').ok_or("bad recent path")?;
                let Some(publication) = self.recent.read().unwrap().iter().find(|p| p.id == id).cloned() else {
                    return respond(stream, "410 Gone", "text/plain", "", b"recent publication replaced").map_err(io_err);
                };
                let table = |name: &str| match name { "main" => Ok(publication.main.clone()), "overflow" => Ok(publication.overflow.clone()), _ => Err("unknown table".to_string()) };
                match (r.starts_with("POST"), rest.split_once('/')) {
                    (false, Some(("publics", kind))) => respond(stream, "200 OK", "application/octet-stream", "", &table(kind)?.publics.concat()).map_err(io_err),
                    (true, Some(("query", kind))) => {
                        let (out, timing) = self.query(table(kind)?, &body)?;
                        respond(stream, "200 OK", "application/octet-stream", &timing, &out).map_err(io_err)
                    }
                    _ => respond(stream, "404 Not Found", "text/plain", "", b"not found").map_err(io_err),
                }
            }
            r if r.starts_with("GET /") && self.web.is_some() && !r.contains("..") => {
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

/// Most connections handled at once; further ones wait in the listen backlog.
const MAX_CONNECTIONS: usize = 256;

pub(super) fn serve(dir: &Path, port: u16, threads: usize, web: Option<&Path>, recent_root: Option<&Path>) -> Result<(), String> {
    let manifest_bytes = fs::read(dir.join("manifest.json")).map_err(io_err)?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(io_err)?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(io_err)?;
    let count = |kind: &str, field: &str| manifest[kind][field].as_u64().map(|v| v as usize).ok_or("bad manifest");
    let (main, main_load) = pool.install(|| Table::load(dir, "main", count("main", "instances")?, count("main", "rows")?))?;
    let (overflow, overflow_load) =
        pool.install(|| Table::load(dir, "overflow", count("overflow", "instances")?, count("overflow", "rows")?))?;
    eprintln!("{}", json!({"loaded":[main_load, overflow_load],"threads":threads,"maxBatch":MAX_BATCH}));
    let recent: RecentSet = Default::default();
    if let Some(root) = recent_root {
        let (root, set) = (root.to_owned(), recent.clone());
        std::thread::spawn(move || watch_recent(root, set));
    }
    let (sender, jobs) = mpsc::channel();
    std::thread::spawn(move || schedule(jobs, pool));
    let shared = Arc::new(Shared {
        manifest: serde_json::to_vec(&manifest).map_err(io_err)?, main: Arc::new(main), overflow: Arc::new(overflow),
        recent, web: web.map(Path::to_owned), jobs: Mutex::new(sender),
    });
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(io_err)?;
    eprintln!("Private explorer test listening on http://127.0.0.1:{port}");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        if active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_CONNECTIONS {
            active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            let _ = respond(&mut stream, "503 Service Unavailable", "text/plain", "Retry-After: 1\r\n", b"busy");
            continue;
        }
        let (shared, active) = (shared.clone(), active.clone());
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
            if let Err(error) = shared.handle(&mut stream) {
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
    profile: TableProfile,
    publics: Vec<Vec<u8>>,
    rows: usize,
    /// Route prefix: "" for the base publication, "/recent/<id>" for recent.
    prefix: String,
}

impl Remote {
    fn fetch(http: &Http, cache: &Path, manifest: &Value, kind: &str, prefix: &str) -> Result<Self, String> {
        let rows = manifest[kind]["rows"].as_u64().ok_or("bad manifest")? as usize;
        let instances = manifest[kind]["instances"].as_u64().ok_or("bad manifest")? as usize;
        let profile = profile_for(kind, rows)?;
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
        if bytes.len() != size * instances {
            return Err(format!("{kind} public parameters have the wrong length"));
        }
        Ok(Remote { publics: bytes.chunks(size).map(<[u8]>::to_vec).collect(), profile, rows, prefix: prefix.to_owned() })
    }

    /// Queries each local row of every instance with one shared upload per row.
    fn rows(&self, http: &Http, label: &str, local_rows: &[usize], timing: &mut BTreeMap<String, u128>) -> Result<Vec<Vec<Vec<u8>>>, String> {
        let kind = if label.ends_with("overflow") || label.ends_with("Overflow") { "overflow" } else { "main" };
        let start = Instant::now();
        let (secrets, uploads): (Vec<_>, Vec<_>) = local_rows.iter().map(|&r| self.profile.prepare(r)).collect::<Result<Vec<_>, _>>()?.into_iter().unzip();
        *timing.entry(format!("{label}ClientPrepareNs")).or_default() += start.elapsed().as_nanos();
        let start = Instant::now();
        let mut body = (uploads.len() as u32).to_le_bytes().to_vec();
        body.extend(uploads.concat());
        let (reply, headers) = http.call("POST", &format!("{}/query/{kind}", self.prefix), &body)?;
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
            .zip(&secrets)
            .map(|(replies, secret)| replies.chunks(size).zip(&self.publics).map(|(r, p)| self.profile.decode(secret, p, r)).collect())
            .collect::<Result<Vec<Vec<_>>, String>>()?;
        *timing.entry(format!("{label}ClientDecodeNs")).or_default() += start.elapsed().as_nanos();
        Ok(decoded)
    }
}

/// A publication's two tables: the base snapshot, or the recent blocks.
struct Publication {
    main: Remote,
    overflow: Remote,
    tip: u64,
}

impl Publication {
    fn open(http: &Http, cache: &Path, manifest_bytes: &[u8], prefix: &str) -> Result<Self, String> {
        let manifest: Value = serde_json::from_slice(manifest_bytes).map_err(io_err)?;
        if manifest["schema"] != layout::SCHEMA_NAME {
            return Err("unsupported private explorer manifest".into());
        }
        // Public parameters belong to one exact publication, not just its tip.
        let cache = cache.join(hex::encode(&sha2::Sha256::digest(manifest_bytes)[..16]));
        fs::create_dir_all(&cache).map_err(io_err)?;
        Ok(Publication {
            main: Remote::fetch(http, &cache, &manifest, "main", prefix)?,
            overflow: Remote::fetch(http, &cache, &manifest, "overflow", prefix)?,
            tip: manifest["snapshotTip"].as_u64().ok_or("bad manifest")?,
        })
    }

    fn bucket(&self, http: &Http, label: &str, txid: &[u8; 32], timing: &mut BTreeMap<String, u128>) -> Result<Vec<u8>, String> {
        Ok(self.main.rows(http, label, &[row_of(txid, self.main.rows as u64) as usize], timing)?.remove(0).concat())
    }
}

pub(super) fn lookup(addr: &str, txid_hex: &str, cache: &Path, full: bool) -> Result<(), String> {
    let txid: [u8; 32] = hex::decode(txid_hex).ok().and_then(|b| b.try_into().ok()).ok_or("txid must be 64 hex characters")?;
    let total = Instant::now();
    let http = Http { addr: addr.to_owned() };
    let mut timing = BTreeMap::new();
    let start = Instant::now();
    let (base_manifest, _) = http.call("GET", "/manifest", &[])?;
    let base = Publication::open(&http, cache, &base_manifest, "")?;
    // No recent publication yet is a normal state: every client then asks the base only.
    let recent = match http.call("GET", "/recent/manifest", &[]) {
        Ok((bytes, _)) => {
            let id = serde_json::from_slice::<Value>(&bytes).map_err(io_err)?["id"].as_str().ok_or("recent manifest has no id")?.to_owned();
            Some(Publication::open(&http, cache, &bytes, &format!("/recent/{id}"))?)
        }
        Err(_) => None,
    };
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
            let mut asked: Vec<usize> = wanted.iter().map(|g| g % owner.overflow.rows).collect();
            asked.resize(layout::padded_rows(wanted.len()), asked[0]);
            // The other publication gets the same number of dummy queries, so
            // the server cannot tell an old large transaction from a recent one.
            for other in [Some(&base), recent.as_ref()].into_iter().flatten().filter(|p| !std::ptr::eq(*p, owner)) {
                other.overflow.rows(&http, "dummyOverflow", &vec![0; asked.len()], &mut timing)?;
            }
            let fetched = owner.overflow.rows(&http, "overflow", &asked, &mut timing)?;
            let bytes: Vec<u8> = wanted.iter().zip(&fetched).flat_map(|(g, per)| per[g / owner.overflow.rows].clone()).collect();
            timing.insert("overflowRows".into(), asked.len() as u128);
            Some(bytes[start as usize - first * ROW_BYTES..][..len].to_vec())
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
