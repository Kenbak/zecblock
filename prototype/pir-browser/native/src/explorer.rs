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
use super::chunk_spike::{parallel_multiply, preprocess_blocks};
use super::explorer_record::{Record, parse_export_line};
use super::*;
use memmap2::{Mmap, MmapMut};
use rayon::prelude::*;
use std::{
    fs::{File, OpenOptions},
    io::{BufReader, BufWriter, Read},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    time::Instant,
};
use zakura_pir_client::transparent::native::TableClientExt as _;
use zakura_pir_protocol::native::D;

use super::explorer_record::layout::{self, BUCKET_HEADER, ENTRY_HEADER, PREVIEW_FLAG, ROW_BYTES, TAG, preview_body, row_of};
use sha2::Digest as _;
use std::collections::HashSet;
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
}

impl<'a> Body<'a> {
    fn entry_bytes(&self) -> usize {
        ENTRY_HEADER + match self { Body::Full(full) => full.len(), Body::Preview { bytes, .. } => PREVIEW_POINTER + bytes.len() }
    }
    /// Halves the entry's preview budget; false when it cannot get smaller.
    fn shrink(&mut self, txid: [u8; 32]) -> Result<bool, String> {
        let full: &'a [u8] = match self { Body::Full(full) | Body::Preview { full, .. } => full };
        let current = self.entry_bytes();
        let bytes = Record::decode(txid, full)?.preview((current - ENTRY_HEADER - PREVIEW_POINTER).min(PREVIEW_MAX) / 2);
        if ENTRY_HEADER + PREVIEW_POINTER + bytes.len() >= current {
            return Ok(false);
        }
        *self = Body::Preview { full, bytes };
        Ok(true)
    }
}

pub(super) fn build(records_path: &Path, dir: &Path, snapshot_tip: u64) -> Result<(), String> {
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
    let (instances, rows) = instance_rows((estimate as f64 / (ROW_BYTES as f64 * TARGET_FILL)).ceil() as usize);
    let bucket_bytes = instances * ROW_BYTES;
    let mut order: Vec<(u32, u32)> = (0..index.len()).into_par_iter().map(|i| (row_of(&txid_at(i), rows as u64) as u32, i as u32)).collect();
    order.par_sort_unstable();
    // Demotions of small records also land in overflow; reserve a margin.
    let overflow_capacity = (overflow_bytes + overflow_bytes / 10 + (64 << 20)) as usize;
    let (overflow_instances, overflow_rows) = instance_rows(overflow_capacity.div_ceil(ROW_BYTES));
    let mut main = table_files(dir, "main", instances, rows)?;
    let mut overflow = table_files(dir, "overflow", overflow_instances, overflow_rows)?;
    let overflow_limit = (overflow_instances * overflow_rows * ROW_BYTES) as u64;
    let (mut cursor, mut previews, mut demoted_small, mut demoted_buckets, mut max_used, mut total_used) = (0u64, 0u64, 0u64, 0u64, 0usize, 0u64);
    let mut buffer = vec![0u8; bucket_bytes];
    for group in order.chunk_by(|a, b| a.0 == b.0) {
        let bucket = group[0].0 as usize;
        let mut tags = HashSet::with_capacity(group.len());
        let mut entries: Vec<([u8; 32], Body)> = Vec::with_capacity(group.len());
        for &(_, i) in group {
            let txid = txid_at(i as usize);
            if !tags.insert(<[u8; TAG]>::try_from(&txid[..TAG]).unwrap()) {
                return Err(format!("duplicate tag in bucket {bucket}"));
            }
            let (offset, len) = index[i as usize];
            let full = &data[offset + 36..offset + 36 + len];
            let body = if len <= INLINE_MAX {
                Body::Full(full)
            } else {
                Body::Preview { full, bytes: Record::decode(txid, full)?.preview(PREVIEW_MAX) }
            };
            entries.push((txid, body));
        }
        let mut used: usize = BUCKET_HEADER + entries.iter().map(|(_, b)| b.entry_bytes()).sum::<usize>();
        if used > bucket_bytes {
            demoted_buckets += 1;
            let mut frozen = vec![false; entries.len()];
            while used > bucket_bytes {
                let pick = (0..entries.len()).filter(|&i| !frozen[i]).max_by_key(|&i| entries[i].1.entry_bytes())
                    .ok_or_else(|| format!("bucket {bucket} cannot fit even zero-list previews"))?;
                let (txid, body) = &mut entries[pick];
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
        for (txid, body) in &entries {
            let (payload, flag) = match body {
                Body::Full(full) => (full.to_vec(), 0),
                Body::Preview { full, bytes } => {
                    previews += 1;
                    let start = write_overflow(&mut overflow, &mut cursor, overflow_rows, overflow_limit, full)?;
                    (preview_body(start, full.len(), bytes), PREVIEW_FLAG)
                }
            };
            buffer[at..at + TAG].copy_from_slice(&txid[..TAG]);
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
    let manifest = json!({"schema":layout::SCHEMA_NAME,"snapshotTip":snapshot_tip,"records":index.len(),"rowBytes":ROW_BYTES,
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

    fn answer(&self, upload: &[u8]) -> Result<(Vec<u8>, u128, u128), String> {
        let (keys, selection) = self.profile.parse(upload)?;
        let (mut scan, mut pack) = (0, 0);
        let mut out = Vec::with_capacity(self.databases.len() * self.profile.scheme.response_bytes);
        for (database, blocks) in self.databases.iter().zip(&self.blocks) {
            let start = Instant::now();
            let intermediate = parallel_multiply(database, ROW_BYTES, &selection);
            scan += start.elapsed().as_nanos();
            let start = Instant::now();
            out.extend(self.profile.native.pack(blocks, &keys, &intermediate)?);
            pack += start.elapsed().as_nanos();
        }
        Ok((out, scan, pack))
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

pub(super) fn serve(dir: &Path, port: u16, threads: usize, web: Option<&Path>) -> Result<(), String> {
    let manifest: Value = serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(io_err)?).map_err(io_err)?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(io_err)?;
    let count = |kind: &str, field: &str| manifest[kind][field].as_u64().map(|v| v as usize).ok_or("bad manifest");
    let (main, main_load) = pool.install(|| Table::load(dir, "main", count("main", "instances")?, count("main", "rows")?))?;
    let (overflow, overflow_load) =
        pool.install(|| Table::load(dir, "overflow", count("overflow", "instances")?, count("overflow", "rows")?))?;
    eprintln!("{}", json!({"loaded":[main_load, overflow_load],"threads":threads}));
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(io_err)?;
    eprintln!("Private explorer test listening on http://127.0.0.1:{port}");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let result = read_request(&mut stream).and_then(|(route, body)| -> Result<(), String> {
            let table = |name: &str| if name == "main" { Ok(&main) } else if name == "overflow" { Ok(&overflow) } else { Err("unknown table".to_string()) };
            match route.as_str() {
                "GET /manifest" => respond(&mut stream, "200 OK", "application/json", "", &serde_json::to_vec(&manifest).unwrap()).map_err(io_err),
                r if r.starts_with("GET /publics/") => {
                    let t = table(&r["GET /publics/".len()..])?;
                    respond(&mut stream, "200 OK", "application/octet-stream", "", &t.publics.concat()).map_err(io_err)
                }
                r if r.starts_with("GET /public/") => {
                    let mut parts = r["GET /public/".len()..].split('/');
                    let t = table(parts.next().unwrap_or(""))?;
                    let i: usize = parts.next().and_then(|p| p.parse().ok()).ok_or("bad instance")?;
                    respond(&mut stream, "200 OK", "application/octet-stream", "", t.publics.get(i).ok_or("bad instance")?).map_err(io_err)
                }
                r if r.starts_with("POST /query/") => {
                    let t = table(&r["POST /query/".len()..])?;
                    let count = body.get(..4).map(|c| u32::from_le_bytes(c.try_into().unwrap()) as usize).ok_or("missing upload count")?;
                    let body = &body[4..];
                    if count == 0 || count > 256 || body.len() % count != 0 {
                        return Err("bad upload length".into());
                    }
                    let request_bytes = body.len() / count;
                    let start = Instant::now();
                    let mut out = Vec::new();
                    let (mut scan, mut pack) = (0, 0);
                    for upload in body.chunks(request_bytes) {
                        let (reply, s, p) = pool.install(|| t.answer(upload))?;
                        out.extend(reply);
                        scan += s;
                        pack += p;
                    }
                    let timing = format!("X-Server-Ns: {}\r\nX-Scan-Ns: {scan}\r\nX-Pack-Ns: {pack}\r\n", start.elapsed().as_nanos());
                    respond(&mut stream, "200 OK", "application/octet-stream", &timing, &out).map_err(io_err)
                }
                r if r.starts_with("GET /") && web.is_some() && !r.contains("..") => {
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
                    match fs::read(web.unwrap().join(name)) {
                        Ok(bytes) => respond(&mut stream, "200 OK", kind, "Cache-Control: no-store\r\n", &bytes).map_err(io_err),
                        Err(_) => respond(&mut stream, "404 Not Found", "text/plain", "", b"not found").map_err(io_err),
                    }
                }
                _ => respond(&mut stream, "404 Not Found", "text/plain", "", b"not found").map_err(io_err),
            }
        });
        if let Err(error) = result {
            let _ = respond(&mut stream, "400 Bad Request", "text/plain", "", error.as_bytes());
        }
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
}

impl Remote {
    fn fetch(http: &Http, cache: &Path, manifest: &Value, kind: &str) -> Result<Self, String> {
        let rows = manifest[kind]["rows"].as_u64().ok_or("bad manifest")? as usize;
        let instances = manifest[kind]["instances"].as_u64().ok_or("bad manifest")? as usize;
        let publics = (0..instances)
            .map(|i| {
                let path = cache.join(format!("{kind}-{i:02}.public"));
                if let Ok(bytes) = fs::read(&path) {
                    return Ok(bytes);
                }
                let (bytes, _) = http.call("GET", &format!("/public/{kind}/{i}"), &[])?;
                fs::write(&path, &bytes).map_err(io_err)?;
                Ok(bytes)
            })
            .collect::<Result<_, String>>()?;
        Ok(Remote { profile: profile_for(kind, rows)?, publics, rows })
    }

    /// Queries `row` of every instance with one shared upload; returns all rows.
    fn rows(&self, http: &Http, kind: &str, local_rows: &[usize], timing: &mut BTreeMap<String, u128>) -> Result<Vec<Vec<Vec<u8>>>, String> {
        let start = Instant::now();
        let (secrets, uploads): (Vec<_>, Vec<_>) = local_rows.iter().map(|&r| self.profile.prepare(r)).collect::<Result<Vec<_>, _>>()?.into_iter().unzip();
        *timing.entry(format!("{kind}ClientPrepareNs")).or_default() += start.elapsed().as_nanos();
        let start = Instant::now();
        let mut body = (uploads.len() as u32).to_le_bytes().to_vec();
        body.extend(uploads.concat());
        let (reply, headers) = http.call("POST", &format!("/query/{kind}"), &body)?;
        *timing.entry(format!("{kind}RoundTripNs")).or_default() += start.elapsed().as_nanos();
        for (name, header) in [("ServerNs", "x-server-ns"), ("ScanNs", "x-scan-ns"), ("PackNs", "x-pack-ns")] {
            *timing.entry(format!("{kind}{name}")).or_default() += headers.get(header).and_then(|v| v.parse().ok()).unwrap_or(0);
        }
        *timing.entry(format!("{kind}UploadBytes")).or_default() += uploads.iter().map(|u| u.len() as u128).sum::<u128>();
        *timing.entry(format!("{kind}ReplyBytes")).or_default() += reply.len() as u128;
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
        *timing.entry(format!("{kind}ClientDecodeNs")).or_default() += start.elapsed().as_nanos();
        Ok(decoded)
    }
}

pub(super) fn lookup(addr: &str, txid_hex: &str, cache: &Path, full: bool) -> Result<(), String> {
    let txid: [u8; 32] = hex::decode(txid_hex).ok().and_then(|b| b.try_into().ok()).ok_or("txid must be 64 hex characters")?;
    let total = Instant::now();
    let http = Http { addr: addr.to_owned() };
    let mut timing = BTreeMap::new();
    let (manifest_bytes, _) = http.call("GET", "/manifest", &[])?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(io_err)?;
    if manifest["schema"] != layout::SCHEMA_NAME {
        return Err("unsupported private explorer manifest".into());
    }
    // Public parameters belong to one exact publication, not just its tip.
    let cache = cache.join(hex::encode(&sha2::Sha256::digest(&manifest_bytes)[..16]));
    fs::create_dir_all(&cache).map_err(io_err)?;
    let start = Instant::now();
    let main = Remote::fetch(&http, &cache, &manifest, "main")?;
    let overflow = Remote::fetch(&http, &cache, &manifest, "overflow")?;
    timing.insert("publicParamsNs".into(), start.elapsed().as_nanos());
    let rows = main.rows(&http, "main", &[row_of(&txid, main.rows as u64) as usize], &mut timing)?;
    let mut partial = false;
    let record = match layout::find(&rows[0].concat(), &txid)? {
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
            let mut asked: Vec<usize> = wanted.iter().map(|g| g % overflow.rows).collect();
            asked.resize(layout::padded_rows(wanted.len()), asked[0]);
            let fetched = overflow.rows(&http, "overflow", &asked, &mut timing)?;
            let bytes: Vec<u8> = wanted.iter().zip(&fetched).flat_map(|(g, per)| per[g / overflow.rows].clone()).collect();
            timing.insert("overflowRows".into(), asked.len() as u128);
            Some(bytes[start as usize - first * ROW_BYTES..][..len].to_vec())
        }
    };
    let result = match record {
        None => json!({"found":false,"txid":txid_hex}),
        Some(bytes) => {
            let mut json = Record::decode(txid, &bytes)?.to_json();
            let tip = manifest["snapshotTip"].as_u64().unwrap_or(0);
            json["confirmationsAtSnapshot"] = json!(tip.saturating_sub(json["blockHeight"].as_u64().unwrap_or(0)) + 1);
            json["found"] = json!(true);
            json["partial"] = json!(partial);
            json
        }
    };
    timing.insert("totalNs".into(), total.elapsed().as_nanos());
    let ms: BTreeMap<_, _> = timing.iter().map(|(k, v)| {
        if k.ends_with("Ns") { (k.trim_end_matches("Ns").to_owned() + "Ms", json!((*v as f64 / 1e6 * 10.0).round() / 10.0)) } else { (k.clone(), json!(*v as u64)) }
    }).collect();
    println!("{}", serde_json::to_string_pretty(&json!({"snapshotTip":manifest["snapshotTip"],"result":result,"timing":ms})).map_err(io_err)?);
    Ok(())
}

pub(super) fn default_cache() -> PathBuf {
    std::env::temp_dir().join("zecblock-private-explorer-cache")
}
