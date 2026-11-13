//! Offline spike: a fully private txid -> location index as one tall P8 table.
//! Each txid hashes to one row of fixed 28-byte slots; a lookup fetches that row
//! and scans it for the txid tag, so presence and absence cost the same query.
//! Real sample txids are planted among seeded synthetic ones (txids are uniform
//! hashes, so synthetic keys load rows the same way). Nothing is written or served.
use super::chunk_spike::{median, parallel_multiply, preprocess_blocks};
use super::*;
use rayon::prelude::*;
use std::time::Instant;
use zakura_pir_client::transparent::native::TableClientExt as _;

const SPIKE_SCHEMA: &str = "zecblock-private-index-spike-v1";
const SAMPLE: &str = include_str!("index_sample.tsv");
const ROW_HASH_DOMAIN: &[u8] = b"zecblock-index-spike-row-v1";
const SYNTHETIC_DOMAIN: &[u8] = b"zecblock-index-spike-synthetic-v1";
const TAG_BYTES: usize = 12;
const ENTRY_BYTES: usize = 28;
const ROW_HEADER_BYTES: usize = 4;
const UNKNOWN_TX_INDEX: u16 = u16::MAX;
const SYNTHETIC_SIZE: u32 = 7_000;
const SAMPLE_FLAG: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
    txid: [u8; 32],
    height: u32,
    tx_index: u16,
    size: u32,
    offset: u64,
    flags: u8,
}

impl Entry {
    fn encode(&self, slot: &mut [u8]) {
        slot[..12].copy_from_slice(&self.txid[..TAG_BYTES]);
        slot[12..16].copy_from_slice(&self.height.to_le_bytes());
        slot[16..18].copy_from_slice(&self.tx_index.to_le_bytes());
        slot[18..22].copy_from_slice(&self.size.to_le_bytes());
        slot[22..27].copy_from_slice(&self.offset.to_le_bytes()[..5]);
        slot[27] = self.flags;
    }
}

/// Fields a client recovers from one slot after matching its tag.
#[derive(Debug, PartialEq, Eq)]
struct Found {
    height: u32,
    tx_index: u16,
    size: u32,
    offset: u64,
    flags: u8,
}

fn row_of(txid: &[u8; 32], rows: usize) -> usize {
    let digest = Sha256::new().chain_update(ROW_HASH_DOMAIN).chain_update(txid).finalize();
    (u64::from_le_bytes(digest[..8].try_into().unwrap()) % rows as u64) as usize
}

fn synthetic_txid(index: u64) -> [u8; 32] {
    Sha256::new()
        .chain_update(SYNTHETIC_DOMAIN)
        .chain_update(index.to_le_bytes())
        .finalize()
        .into()
}

fn sample() -> Result<Vec<Entry>, String> {
    SAMPLE
        .lines()
        .map(|line| {
            let mut fields = line.split('\t');
            let txid: [u8; 32] = hex::decode(fields.next().ok_or("sample txid")?)
                .map_err(|_| "sample txid hex")?
                .try_into()
                .map_err(|_| "sample txid length")?;
            let height = fields.next().ok_or("sample height")?.parse().map_err(|_| "sample height")?;
            let size = fields.next().ok_or("sample size")?.parse().map_err(|_| "sample size")?;
            Ok(Entry { txid, height, tx_index: UNKNOWN_TX_INDEX, size, offset: 0, flags: SAMPLE_FLAG })
        })
        .collect()
}

/// Entry `index` of the deterministic population: real samples first, then
/// synthetic keys spread over history with a nominal size and packed offset.
fn entry(index: usize, total: usize, real: &[Entry]) -> Entry {
    if let Some(sampled) = real.get(index) {
        return Entry { offset: index as u64 * u64::from(SYNTHETIC_SIZE), ..*sampled };
    }
    Entry {
        txid: synthetic_txid(index as u64),
        height: (index as u64 * 3_540_520 / total as u64) as u32,
        tx_index: (index % 512) as u16,
        size: SYNTHETIC_SIZE,
        offset: index as u64 * u64::from(SYNTHETIC_SIZE),
        flags: 0,
    }
}

fn find(row: &[u8], txid: &[u8; 32]) -> Result<Option<Found>, String> {
    let count = u16::from_le_bytes([row[0], row[1]]) as usize;
    if count > (row.len() - ROW_HEADER_BYTES) / ENTRY_BYTES {
        return Err("row count exceeds slots".into());
    }
    Ok(row[ROW_HEADER_BYTES..]
        .chunks_exact(ENTRY_BYTES)
        .take(count)
        .find(|slot| slot[..TAG_BYTES] == txid[..TAG_BYTES])
        .map(|slot| {
            let mut offset = [0u8; 8];
            offset[..5].copy_from_slice(&slot[22..27]);
            Found {
                height: u32::from_le_bytes(slot[12..16].try_into().unwrap()),
                tx_index: u16::from_le_bytes([slot[16], slot[17]]),
                size: u32::from_le_bytes(slot[18..22].try_into().unwrap()),
                offset: u64::from_le_bytes(offset),
                flags: slot[27],
            }
        }))
}

fn build(entries: usize, rows: usize, row_bytes: usize, real: &[Entry]) -> Result<(Vec<u8>, Value), String> {
    let slots = (row_bytes - ROW_HEADER_BYTES) / ENTRY_BYTES;
    let placement: Vec<u32> = (0..entries)
        .into_par_iter()
        .map(|index| row_of(&entry(index, entries, real).txid, rows) as u32)
        .collect();
    let mut counts = vec![0u32; rows];
    for &row in &placement {
        counts[row as usize] += 1;
    }
    let max = *counts.iter().max().unwrap() as usize;
    let near_full = counts.iter().filter(|&&count| count as usize * 100 >= slots * 95).count();
    let stats = json!({"slotsPerRow":slots,"meanLoad":entries as f64 / rows as f64,"maxLoad":max,
        "minLoad":counts.iter().min(),"loadFactor":entries as f64 / (rows * slots) as f64,
        "headroomSlotsAtMax":slots as i64 - max as i64,"rowsAtOrAbove95Percent":near_full});
    if max > slots {
        return Err(format!("row overflow: max load {max} exceeds {slots} slots ({stats})"));
    }
    let mut database = vec![0u8; rows * row_bytes];
    for (row, &count) in counts.iter().enumerate() {
        database[row * row_bytes..][..2].copy_from_slice(&(count as u16).to_le_bytes());
    }
    let mut cursor = vec![0u32; rows];
    for (index, &row) in placement.iter().enumerate() {
        let row = row as usize;
        let at = row * row_bytes + ROW_HEADER_BYTES + cursor[row] as usize * ENTRY_BYTES;
        entry(index, entries, real).encode(&mut database[at..at + ENTRY_BYTES]);
        cursor[row] += 1;
    }
    // Tags only need to be unique within a row; check every row the samples use.
    for sampled in real {
        let row = row_of(&sampled.txid, rows);
        let tagged = database[row * row_bytes + ROW_HEADER_BYTES..][..counts[row] as usize * ENTRY_BYTES]
            .chunks_exact(ENTRY_BYTES)
            .filter(|slot| slot[..TAG_BYTES] == sampled.txid[..TAG_BYTES])
            .count();
        if tagged != 1 {
            return Err("sample tag is not unique in its row".into());
        }
    }
    Ok((database, stats))
}

pub(super) fn run(entries: usize, rows: usize, row_bytes: usize, threads: &[usize], queries: usize) -> Result<(), String> {
    let real = sample()?;
    if entries < real.len() || queries == 0 {
        return Err("entries must cover the sample and queries must be positive".into());
    }
    let geometry = format!("index-{rows}x{row_bytes}");
    let profile = TableProfile::new(SPIKE_SCHEMA, &geometry, TABLE, rows as u64, row_bytes as u32)?;
    let pool = |n: usize| rayon::ThreadPoolBuilder::new().num_threads(n).build().map_err(|error| error.to_string());
    let builder = pool(*threads.iter().max().ok_or("no thread counts")?)?;

    let start = Instant::now();
    let (database, load) = builder.install(|| build(entries, rows, row_bytes, &real))?;
    let build_ns = start.elapsed().as_nanos();
    let start = Instant::now();
    let blocks = builder.install(|| preprocess_blocks(&database, &profile))?;
    let preprocess_ns = start.elapsed().as_nanos();
    let public = profile.native.publish(&blocks)?;

    let mut runs = Vec::new();
    for &n in threads {
        let pool = pool(n)?;
        let (mut client, mut scan, mut pack, mut decode) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut present, mut absent) = (0, 0);
        let mut upload_bytes = 0;
        let mut response_bytes = 0;
        for query in 0..queries {
            // Alternate a real planted txid with a fresh key that was never inserted.
            let (txid, expected) = if query % 2 == 0 {
                let sampled = real[(query / 2) % real.len()];
                let index = real.iter().position(|e| e.txid == sampled.txid).unwrap();
                let e = entry(index, entries, &real);
                (sampled.txid, Some(Found { height: e.height, tx_index: e.tx_index, size: e.size, offset: e.offset, flags: e.flags }))
            } else {
                (synthetic_txid(u64::MAX - query as u64), None)
            };
            let row = row_of(&txid, rows);
            let start = Instant::now();
            let (secret, upload) = profile.prepare(row)?;
            client.push(start.elapsed().as_nanos());
            upload_bytes = upload.len();
            let response = pool.install(|| -> Result<Vec<u8>, String> {
                let (keys, selection) = profile.parse(&upload)?;
                let start = Instant::now();
                let intermediate = parallel_multiply(&database, row_bytes, &selection);
                scan.push(start.elapsed().as_nanos());
                let start = Instant::now();
                let response = profile.native.pack(&blocks, &keys, &intermediate)?;
                pack.push(start.elapsed().as_nanos());
                Ok(response)
            })?;
            response_bytes = response.len();
            let start = Instant::now();
            let decoded = profile.decode(&secret, &public, &response)?;
            let found = find(&decoded, &txid)?;
            decode.push(start.elapsed().as_nanos());
            if found != expected {
                return Err(format!("lookup {query} returned {found:?}, expected {expected:?}"));
            }
            if expected.is_some() { present += 1 } else { absent += 1 }
        }
        let (scan, pack) = (median(&mut scan), median(&mut pack));
        runs.push(json!({"threads":n,"queries":queries,"presentLookupsCorrect":present,"absentLookupsCorrect":absent,
            "uploadBytes":upload_bytes,"responseBytes":response_bytes,
            "medianNs":{"clientPrepare":median(&mut client),"serverScan":scan,"serverPack":pack,
                "serverTotal":scan+pack,"clientDecodeAndFind":median(&mut decode)}}));
    }
    let report = json!({"schema":"zecblock-pir-index-spike-v1","entries":entries,"realSampleEntries":real.len(),
        "rows":rows,"rowBytes":row_bytes,"entryBytes":ENTRY_BYTES,"tagBytes":TAG_BYTES,"blocks":profile.blocks(),
        "databaseBytes":database.len(),"preparedBytes":prepared_bytes(&blocks)?,"publicBytes":public.len(),
        "load":load,"buildNs":build_ns,"preprocessNs":preprocess_ns,"runs":runs,
        "scope":"Real sample txids planted among seeded synthetic keys; synthetic heights/sizes/offsets. One query at a time, in memory. No row authentication, growth/rebuild, or noise certificate."});
    serde_json::to_writer(io::stdout().lock(), &report).map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn prepared_bytes(blocks: &[NativePreprocessed]) -> Result<u64, String> {
    struct Counter(u64);
    impl Write for Counter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0 += buf.len() as u64;
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    reinspiring::prepared_native::write(&mut counter, blocks).map_err(|error| error.to_string())?;
    Ok(counter.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_parses_and_tags_round_trip_through_a_row() {
        let real = sample().unwrap();
        assert_eq!(real.len(), 32);
        let (database, load) = build(5_000, 2048, 16_384, &real).unwrap();
        assert!(load["maxLoad"].as_u64().unwrap() <= load["slotsPerRow"].as_u64().unwrap());
        for (index, sampled) in real.iter().enumerate() {
            let row = row_of(&sampled.txid, 2048);
            let found = find(&database[row * 16_384..(row + 1) * 16_384], &sampled.txid).unwrap().unwrap();
            assert_eq!((found.height, found.size, found.flags), (sampled.height, sampled.size, SAMPLE_FLAG));
            assert_eq!(found.offset, index as u64 * u64::from(SYNTHETIC_SIZE));
        }
        let missing = synthetic_txid(u64::MAX);
        let row = row_of(&missing, 2048);
        assert_eq!(find(&database[row * 16_384..(row + 1) * 16_384], &missing).unwrap(), None);
    }

    #[test]
    fn overflow_is_reported_not_truncated() {
        let real = sample().unwrap();
        assert!(build(2048 * 600, 2048, 16_384, &real).unwrap_err().contains("row overflow"));
    }
}
