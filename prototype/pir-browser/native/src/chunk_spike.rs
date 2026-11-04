//! Offline spike: one tall table of fixed-size transaction chunks instead of
//! many 2,048-row bucket layers. Synthetic uniform bytes stand in for raw
//! transaction chunks; PIR cost depends on geometry, not content. No files are
//! written and nothing is served.
use super::*;
use rayon::prelude::*;
use reinspiring::prepared_native;
use std::time::Instant;
use zakura_pir_client::transparent::native::TableClientExt as _;
use zakura_pir_protocol::native::{D, Q};

const SPIKE_SCHEMA: &str = "zecblock-private-chunk-spike-v1";

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

fn synthetic(rows: usize, row_bytes: usize) -> Vec<u8> {
    let mut database = vec![0u8; rows * row_bytes];
    database
        .par_chunks_mut(row_bytes)
        .enumerate()
        .for_each(|(row, bytes)| {
            let mut state = (row as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15);
            for word in bytes.chunks_mut(8) {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                word.copy_from_slice(&state.to_le_bytes()[..word.len()]);
            }
        });
    database
}

/// Same exact Z/(2^64) sums as `matvec::multiply`, split by row ranges.
pub(super) fn parallel_multiply(database: &[u8], row_bytes: usize, query: &[u64]) -> Vec<u64> {
    let rows_per_task = (query.len() / (rayon::current_num_threads() * 4)).max(1);
    let mut out = database
        .par_chunks(rows_per_task * row_bytes)
        .zip(query.par_chunks(rows_per_task))
        .map(|(part, coefficients)| {
            let mut sums = vec![0u64; row_bytes];
            for (row, &coefficient) in part.chunks_exact(row_bytes).zip(coefficients) {
                for (sum, &value) in sums.iter_mut().zip(row) {
                    *sum = sum.wrapping_add(u64::from(value).wrapping_mul(coefficient));
                }
            }
            sums
        })
        .reduce(
            || vec![0u64; row_bytes],
            |mut left, right| {
                for (a, b) in left.iter_mut().zip(right) {
                    *a = a.wrapping_add(b);
                }
                left
            },
        );
    for sum in &mut out {
        *sum &= Q - 1;
    }
    out
}

/// Answers several selections in one pass over the database: each block of
/// `block_rows` rows is visited one column tile at a time, so the running
/// sums for every selection stay in L1 while the block's bytes are reused.
/// Exact for the same reason as `parallel_multiply`: wrapping in 2^64 then
/// masking to Q = 2^54.
pub(super) fn parallel_multiply_batch(database: &[u8], row_bytes: usize, queries: &[&[u64]], block_rows: usize, tile: usize) -> Vec<Vec<u64>> {
    let k = queries.len();
    let rows = queries[0].len();
    assert!(queries.iter().all(|q| q.len() == rows) && database.len() == rows * row_bytes);
    let rows_per_task = rows.div_ceil(rayon::current_num_threads() * 4).max(block_rows);
    let total = (0..rows.div_ceil(rows_per_task))
        .into_par_iter()
        .map(|task| {
            let (r0, r1) = (task * rows_per_task, ((task + 1) * rows_per_task).min(rows));
            let mut sums = vec![0u64; k * row_bytes];
            let mut acc = vec![0u64; k * tile];
            for b0 in (r0..r1).step_by(block_rows) {
                let b1 = (b0 + block_rows).min(r1);
                for c0 in (0..row_bytes).step_by(tile) {
                    let w = tile.min(row_bytes - c0);
                    acc[..k * w].fill(0);
                    for r in b0..b1 {
                        let row = &database[r * row_bytes + c0..r * row_bytes + c0 + w];
                        for (q, query) in queries.iter().enumerate() {
                            let c = query[r];
                            for (sum, &value) in acc[q * w..(q + 1) * w].iter_mut().zip(row) {
                                *sum = sum.wrapping_add(u64::from(value).wrapping_mul(c));
                            }
                        }
                    }
                    for q in 0..k {
                        for (sum, &a) in sums[q * row_bytes + c0..q * row_bytes + c0 + w].iter_mut().zip(&acc[q * w..(q + 1) * w]) {
                            *sum = sum.wrapping_add(a);
                        }
                    }
                }
            }
            sums
        })
        .reduce(
            || vec![0u64; k * row_bytes],
            |mut left, right| {
                for (a, b) in left.iter_mut().zip(right) {
                    *a = a.wrapping_add(b);
                }
                left
            },
        );
    total.chunks_exact(row_bytes).map(|sums| sums.iter().map(|s| s & (Q - 1)).collect()).collect()
}

/// Times the current single-selection scan against the batched tiled scan on
/// one real table file. Selections are public pseudo-random test vectors.
pub(super) fn scan_bench(file: &Path, row_bytes: usize, threads: usize) -> Result<(), String> {
    let map = unsafe { memmap2::Mmap::map(&std::fs::File::open(file).map_err(|e| e.to_string())?) }.map_err(|e| e.to_string())?;
    let rows = map.len() / row_bytes;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(|e| e.to_string())?;
    let queries: Vec<Vec<u64>> = (0..8u64).map(|seed| {
        let mut state = 0x6a09_e667_f3bc_c909u64 ^ seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        (0..rows).map(|_| { state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407); state >> 10 }).collect()
    }).collect();
    let expected: Vec<Vec<u64>> = pool.install(|| queries.iter().map(|q| parallel_multiply(&map, row_bytes, q)).collect());
    let time = |f: &(dyn Fn() -> Vec<Vec<u64>> + Sync), k: usize| -> Result<f64, String> {
        let mut best = f64::MAX;
        for _ in 0..5 {
            let start = Instant::now();
            let out = pool.install(f);
            best = best.min(start.elapsed().as_secs_f64() * 1e3);
            if out[..] != expected[..k] {
                return Err("batched scan mismatch".into());
            }
        }
        Ok(best)
    };
    let mut results = vec![json!({"kernel":"current","k":1,"ms":time(&|| vec![parallel_multiply(&map, row_bytes, &queries[0])], 1)?})];
    for (block_rows, tile) in [(16, 256), (32, 512), (64, 1024), (8, 2048)] {
        for k in [1, 2, 4, 8] {
            let refs: Vec<&[u64]> = queries[..k].iter().map(Vec::as_slice).collect();
            let ms = time(&|| parallel_multiply_batch(&map, row_bytes, &refs, block_rows, tile), k)?;
            results.push(json!({"kernel":"tiled","blockRows":block_rows,"tile":tile,"k":k,"ms":ms,"msPerQuery":ms / k as f64}));
        }
    }
    println!("{}", json!({"file":file.display().to_string(),"rows":rows,"bytes":map.len(),"threads":threads,"results":results}));
    Ok(())
}

pub(super) fn preprocess_blocks(database: &[u8], profile: &TableProfile) -> Result<Vec<NativePreprocessed>, String> {
    (0..profile.blocks())
        .into_par_iter()
        .map(|block| {
            let start = block * D;
            let mut columns = vec![0u8; D * profile.rows];
            for row in 0..profile.rows {
                let source = &database[row * profile.row_bytes + start..][..D];
                for (col, &value) in source.iter().enumerate() {
                    columns[col * profile.rows + row] = value;
                }
            }
            let block_hint = hint(&profile.masks, profile.rows, D, |col| {
                &columns[col * profile.rows..(col + 1) * profile.rows]
            })?;
            NativePreprocessed::build_two_mask(&profile.setup, &block_hint[0])
                .map_err(|error| error.to_string())
        })
        .collect()
}

pub(super) fn median(values: &mut [u128]) -> u128 {
    values.sort_unstable();
    values[values.len() / 2]
}

pub(super) fn run(rows: usize, row_bytes: usize, threads: &[usize], queries: usize) -> Result<(), String> {
    let geometry = format!("spike-{rows}x{row_bytes}");
    let profile = TableProfile::new(SPIKE_SCHEMA, &geometry, TABLE, rows as u64, row_bytes as u32)?;
    let build_threads = *threads.iter().max().ok_or("no thread counts")?;
    let pool = |n: usize| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build()
            .map_err(|error| error.to_string())
    };
    let builder = pool(build_threads)?;

    let start = Instant::now();
    let database = builder.install(|| synthetic(rows, row_bytes));
    let generate_ns = start.elapsed().as_nanos();
    let start = Instant::now();
    let blocks = builder.install(|| preprocess_blocks(&database, &profile))?;
    let preprocess_ns = start.elapsed().as_nanos();
    let public = profile.native.publish(&blocks)?;
    let mut counter = Counter(0);
    prepared_native::write(&mut counter, &blocks).map_err(|error| error.to_string())?;

    let mut runs = Vec::new();
    for &n in threads {
        let pool = pool(n)?;
        let (mut client, mut parse, mut scan, mut pack, mut decode) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut upload_bytes = 0;
        let mut response_bytes = 0;
        for query in 0..queries {
            let row = (query * 2_654_435_761 + 12_345) % rows;
            let start = Instant::now();
            let (secret, upload) = profile.prepare(row)?;
            client.push(start.elapsed().as_nanos());
            upload_bytes = upload.len();
            let response = pool.install(|| -> Result<Vec<u8>, String> {
                let start = Instant::now();
                let (keys, selection) = profile.parse(&upload)?;
                parse.push(start.elapsed().as_nanos());
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
            decode.push(start.elapsed().as_nanos());
            if decoded != database[row * row_bytes..(row + 1) * row_bytes] {
                return Err(format!("decoded row {row} differs at {n} threads"));
            }
        }
        let (parse, scan, pack) = (median(&mut parse), median(&mut scan), median(&mut pack));
        runs.push(json!({"threads":n,"queries":queries,"allRowsDecodedExactly":true,
            "uploadBytes":upload_bytes,"responseBytes":response_bytes,
            "medianNs":{"clientPrepare":median(&mut client),"serverParse":parse,"serverScan":scan,
                "serverPack":pack,"serverTotal":parse+scan+pack,"clientDecode":median(&mut decode)},
            "scanGBps":database.len() as f64 / scan as f64}));
    }
    let report = json!({"schema":"zecblock-pir-chunk-spike-v1","rows":rows,"rowBytes":row_bytes,
        "blocks":profile.blocks(),"databaseBytes":database.len(),"preparedBytes":counter.0,
        "publicBytes":public.len(),"generateNs":generate_ns,"preprocessNs":preprocess_ns,
        "preprocessThreads":build_threads,"runs":runs,
        "scope":"Synthetic uniform rows, in-memory, single process, one query at a time. Exact row decode per query is a correctness spot check, not a noise certificate."});
    serde_json::to_writer(io::stdout().lock(), &report).map_err(|error| error.to_string())?;
    println!();
    Ok(())
}
