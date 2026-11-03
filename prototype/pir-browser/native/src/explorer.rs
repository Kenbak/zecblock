//! Private explorer test: every canonical transaction's explorer record in
//! hashed 16 KiB PIR rows, plus an overflow table for large records.
//!
//! encode  : export lines (stdin) -> records.bin ([txid 32][len u32][record])
//! build   : records.bin -> per-instance database files + manifest.json
//! serve   : loopback HTTP; one upload answers every instance of a table
//! lookup  : native client; prints the `/api/tx/:txid` fields and timings
//!
//! A main-table lookup always queries every main instance with the same
//! encrypted row selection, so the server learns nothing about which row or
//! instance holds the txid, or whether it exists. Fetching overflow rows does
//! reveal that the transaction is large, and how many rows it spans.
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

const SCHEMA_NAME: &str = "zecblock-private-explorer-test-v1";
const ROW_HASH_DOMAIN: &[u8] = b"zecblock-explorer-row-v1";
const ROW_BYTES: usize = 16_384;
const ROW_HEADER: usize = 4;
const TAG: usize = 12;
const ENTRY_HEADER: usize = TAG + 2;
const STUB_FLAG: u16 = 0x8000;
const INLINE_MAX: usize = 4_096;
const MAX_INSTANCE_ROWS: usize = 131_072;
const TARGET_FILL: f64 = 0.85;
/// Row bytes kept free of inline records so overflow stubs always fit.
const STUB_RESERVE: usize = 1_024;

// ---- shared helpers ----------------------------------------------------------

fn row_of(txid: &[u8; 32], rows: u64) -> u64 {
    let digest = Sha256::new().chain_update(ROW_HASH_DOMAIN).chain_update(txid).finalize();
    u64::from_le_bytes(digest[..8].try_into().unwrap()) % rows
}

fn put_var(out: &mut Vec<u8>, mut value: u64) {
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

fn instance_rows(total_rows: usize) -> (usize, usize) {
    let instances = total_rows.div_ceil(MAX_INSTANCE_ROWS).max(1);
    let rows = total_rows.div_ceil(instances).div_ceil(D) * D;
    (instances, rows)
}

fn profile_for(kind: &str, rows: usize) -> Result<TableProfile, String> {
    TableProfile::new(SCHEMA_NAME, &format!("explorer-{kind}-{rows}x{ROW_BYTES}"), TABLE, rows as u64, ROW_BYTES as u32)
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

fn records(path: &Path, mut visit: impl FnMut([u8; 32], &[u8]) -> Result<(), String>) -> Result<(), String> {
    let mut reader = BufReader::with_capacity(8 << 20, File::open(path).map_err(io_err)?);
    let mut header = [0u8; 36];
    let mut body = Vec::new();
    loop {
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
        let len = u32::from_le_bytes(header[32..].try_into().unwrap()) as usize;
        body.resize(len, 0);
        reader.read_exact(&mut body).map_err(io_err)?;
        visit(header[..32].try_into().unwrap(), &body)?;
    }
}

fn stub(start: u64, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    put_var(&mut out, start);
    put_var(&mut out, len as u64);
    out
}

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

pub(super) fn build(records_path: &Path, dir: &Path, snapshot_tip: u64) -> Result<(), String> {
    fs::create_dir(dir).map_err(io_err)?;
    let start = Instant::now();
    let (mut count, mut inline_bytes, mut overflow_bytes, mut large) = (0u64, 0u64, 0u64, 0u64);
    records(records_path, |_, body| {
        count += 1;
        if body.len() > INLINE_MAX {
            large += 1;
            overflow_bytes += body.len() as u64;
            inline_bytes += (ENTRY_HEADER + 10) as u64;
        } else {
            inline_bytes += (ENTRY_HEADER + body.len()) as u64;
        }
        Ok(())
    })?;
    let usable = (ROW_BYTES - ROW_HEADER - STUB_RESERVE) as f64 * TARGET_FILL;
    let (main_instances, main_rows) = instance_rows((inline_bytes as f64 / usable).ceil() as usize);
    let total_rows = (main_instances * main_rows) as u64;
    // Spills from full rows also land in overflow; reserve a 10% margin.
    let overflow_capacity = (overflow_bytes + overflow_bytes / 10 + (64 << 20)) as usize;
    let (overflow_instances, overflow_rows) = instance_rows(overflow_capacity.div_ceil(ROW_BYTES));
    let mut main = table_files(dir, "main", main_instances, main_rows)?;
    let mut overflow = table_files(dir, "overflow", overflow_instances, overflow_rows)?;
    let overflow_limit = (overflow_instances * overflow_rows * ROW_BYTES) as u64;
    let mut cursor = 0u64;
    let mut spills = 0u64;
    let mut used = vec![0u16; total_rows as usize];
    records(records_path, |txid, body| {
        let global = row_of(&txid, total_rows) as usize;
        let (instance, row) = (global / main_rows, global % main_rows);
        let base = row * ROW_BYTES;
        let free = ROW_BYTES - ROW_HEADER - used[global] as usize;
        let (payload, flag) = if body.len() <= INLINE_MAX && ENTRY_HEADER + body.len() + STUB_RESERVE <= free {
            (body.to_vec(), 0)
        } else {
            if body.len() <= INLINE_MAX {
                spills += 1;
            }
            (stub(write_overflow(&mut overflow, &mut cursor, overflow_rows, overflow_limit, body)?, body.len()), STUB_FLAG)
        };
        if ENTRY_HEADER + payload.len() > free {
            return Err(format!("row {global} cannot hold even a stub"));
        }
        let table = &mut main[instance];
        let at = base + ROW_HEADER + used[global] as usize;
        let entries = u16::from_le_bytes([table[base], table[base + 1]]);
        {
            // Tags must be unique within a row; scan the entries already placed.
            let mut scan = base + ROW_HEADER;
            for _ in 0..entries {
                if table[scan..scan + TAG] == txid[..TAG] {
                    return Err("duplicate tag within a row".into());
                }
                let len = u16::from_le_bytes([table[scan + TAG], table[scan + TAG + 1]]) & !STUB_FLAG;
                scan += ENTRY_HEADER + len as usize;
            }
        }
        table[at..at + TAG].copy_from_slice(&txid[..TAG]);
        table[at + TAG..at + ENTRY_HEADER].copy_from_slice(&(payload.len() as u16 | flag).to_le_bytes());
        table[at + ENTRY_HEADER..at + ENTRY_HEADER + payload.len()].copy_from_slice(&payload);
        used[global] += (ENTRY_HEADER + payload.len()) as u16;
        table[base..base + 2].copy_from_slice(&(entries + 1).to_le_bytes());
        table[base + 2..base + 4].copy_from_slice(&used[global].to_le_bytes());
        Ok(())
    })?;
    for map in main.iter().chain(overflow.iter()) {
        map.flush().map_err(io_err)?;
    }
    let max_used = *used.iter().max().unwrap() as usize;
    let mean_used = used.iter().map(|&u| u as u64).sum::<u64>() as f64 / used.len() as f64;
    let manifest = json!({"schema":SCHEMA_NAME,"snapshotTip":snapshot_tip,"records":count,"rowBytes":ROW_BYTES,
        "rowHashDomain":String::from_utf8_lossy(ROW_HASH_DOMAIN),"tagBytes":TAG,"inlineMax":INLINE_MAX,
        "main":{"instances":main_instances,"rows":main_rows,"totalRows":total_rows,"inlineBytes":inline_bytes,
            "meanRowBytesUsed":mean_used,"maxRowBytesUsed":max_used,"spilledToOverflow":spills},
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

pub(super) fn serve(dir: &Path, port: u16, threads: usize) -> Result<(), String> {
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

pub(super) fn lookup(addr: &str, txid_hex: &str, cache: &Path) -> Result<(), String> {
    let txid: [u8; 32] = hex::decode(txid_hex).ok().and_then(|b| b.try_into().ok()).ok_or("txid must be 64 hex characters")?;
    let total = Instant::now();
    let http = Http { addr: addr.to_owned() };
    let mut timing = BTreeMap::new();
    let (manifest_bytes, _) = http.call("GET", "/manifest", &[])?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(io_err)?;
    let cache = cache.join(manifest["snapshotTip"].to_string());
    fs::create_dir_all(&cache).map_err(io_err)?;
    let start = Instant::now();
    let main = Remote::fetch(&http, &cache, &manifest, "main")?;
    let overflow = Remote::fetch(&http, &cache, &manifest, "overflow")?;
    timing.insert("publicParamsNs".into(), start.elapsed().as_nanos());
    let total_rows = manifest["main"]["totalRows"].as_u64().ok_or("bad manifest")?;
    let global = row_of(&txid, total_rows) as usize;
    let rows = main.rows(&http, "main", &[global % main.rows], &mut timing)?;
    let row = &rows[0][global / main.rows];
    let entries = u16::from_le_bytes([row[0], row[1]]);
    let mut at = ROW_HEADER;
    let mut found = None;
    for _ in 0..entries {
        let len = u16::from_le_bytes([row[at + TAG], row[at + TAG + 1]]);
        let body = &row[at + ENTRY_HEADER..at + ENTRY_HEADER + (len & !STUB_FLAG) as usize];
        if row[at..at + TAG] == txid[..TAG] {
            found = Some((len & STUB_FLAG != 0, body.to_vec()));
            break;
        }
        at += ENTRY_HEADER + (len & !STUB_FLAG) as usize;
    }
    let record = match found {
        None => None,
        Some((false, body)) => Some(body),
        Some((true, stub)) => {
            let mut at = 0;
            let start = get_var(&stub, &mut at)? as usize;
            let len = get_var(&stub, &mut at)? as usize;
            let (first, last) = (start / ROW_BYTES, (start + len - 1) / ROW_BYTES);
            let wanted: Vec<usize> = (first..=last).collect();
            let fetched = overflow.rows(&http, "overflow", &wanted.iter().map(|g| g % overflow.rows).collect::<Vec<_>>(), &mut timing)?;
            let bytes: Vec<u8> = wanted.iter().zip(&fetched).flat_map(|(g, per)| per[g / overflow.rows].clone()).collect();
            timing.insert("overflowRows".into(), wanted.len() as u128);
            Some(bytes[start - first * ROW_BYTES..][..len].to_vec())
        }
    };
    let result = match record {
        None => json!({"found":false,"txid":txid_hex}),
        Some(bytes) => {
            let mut json = Record::decode(txid, &bytes)?.to_json();
            let tip = manifest["snapshotTip"].as_u64().unwrap_or(0);
            json["confirmationsAtSnapshot"] = json!(tip.saturating_sub(json["blockHeight"].as_u64().unwrap_or(0)) + 1);
            json["found"] = json!(true);
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
