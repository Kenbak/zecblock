//! Exact P8 database/selection products in the native power-of-two ring.
use zakura_pir_protocol::native::Q;

/// Visit every byte in row order, keeping each column's running sum in memory.
///
/// Wrapping in Z/(2^64) and then masking to Q = 2^54 is exact: Q divides
/// 2^64. The former column-first scan visits the same terms in the same row
/// order for each output; only the order of work between columns changes.
pub fn multiply(database: &[u8], row_bytes: usize, query: &[u64]) -> Vec<u64> {
    assert!(row_bytes > 0);
    assert_eq!(database.len(), query.len().checked_mul(row_bytes).unwrap());
    let mut out = vec![0u64; row_bytes];
    for (row, &coefficient) in database.chunks_exact(row_bytes).zip(query) {
        for (sum, &value) in out.iter_mut().zip(row) {
            *sum = sum.wrapping_add(u64::from(value).wrapping_mul(coefficient));
        }
    }
    for sum in &mut out {
        *sum &= Q - 1;
    }
    out
}

/// Retained only for the explicit offline benchmark and regression oracle.
pub fn column_strided(database: &[u8], row_bytes: usize, query: &[u64]) -> Vec<u64> {
    assert!(row_bytes > 0);
    assert_eq!(database.len(), query.len().checked_mul(row_bytes).unwrap());
    (0..row_bytes)
        .map(|col| {
            query
                .iter()
                .enumerate()
                .fold(0u64, |sum, (row, &coefficient)| {
                    sum.wrapping_add(
                        u64::from(database[row * row_bytes + col]).wrapping_mul(coefficient),
                    )
                })
                & (Q - 1)
        })
        .collect()
}

/// Deterministic public input at the current P8 profile's lifted query width.
pub fn benchmark_query(rows: usize) -> Vec<u64> {
    let mut state = 0x6a09_e667_f3bc_c909u64;
    (0..rows)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> (64 - 28)) << (54 - 28)
        })
        .collect()
}

/// Scan timing excludes loading, setup, parsing, packing and output hashing.
pub fn benchmark(
    database: &[u8],
    row_bytes: usize,
    query: &[u64],
    iterations: usize,
) -> Result<serde_json::Value, String> {
    use std::{hint::black_box, time::Instant};

    use sha2::{Digest, Sha256};

    if !(1..=1000).contains(&iterations) {
        return Err("benchmark iterations must be between 1 and 1000".into());
    }
    let expected = column_strided(database, row_bytes, query);
    if multiply(database, row_bytes, query) != expected {
        return Err("matrix benchmark warmup mismatch".into());
    }
    let mut baseline_ns = Vec::with_capacity(iterations);
    let mut contiguous_ns = Vec::with_capacity(iterations);
    for iteration in 0..iterations {
        // Alternate the timed order after one warmup of each path.
        for baseline in [iteration % 2 == 0, iteration % 2 != 0] {
            let start = Instant::now();
            let out = if baseline {
                column_strided(black_box(database), row_bytes, black_box(query))
            } else {
                multiply(black_box(database), row_bytes, black_box(query))
            };
            let elapsed = start.elapsed().as_nanos();
            black_box(&out);
            if out != expected {
                return Err("matrix benchmark result mismatch".into());
            }
            if baseline {
                baseline_ns.push(elapsed);
            } else {
                contiguous_ns.push(elapsed);
            }
        }
    }
    let mut digest = Sha256::new();
    for word in expected {
        digest.update(word.to_le_bytes());
    }
    Ok(serde_json::json!({
        "schema": "zecblock-pir-matvec-benchmark-v1",
        "rows": query.len(),
        "rowBytes": row_bytes,
        "databaseBytes": database.len(),
        "databaseSha256": hex::encode(Sha256::digest(database)),
        "query": "public-seeded-28-bit-lifted-to-q54-v1",
        "iterations": iterations,
        "warmupRoundsPerPath": 1,
        "order": "alternating-baseline-first-contiguous-first",
        "baselineColumnStridedNs": baseline_ns,
        "contiguousRowsNs": contiguous_ns,
        "resultSha256": hex::encode(digest.finalize()),
        "resultsEqual": true,
        "timingScope": "matrix scan and output allocation only; excludes load/setup/parse/pack/hash"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent wide-integer arithmetic, without wrapping u64 accumulation.
    fn oracle(database: &[u8], row_bytes: usize, query: &[u64]) -> Vec<u64> {
        let mut exact = vec![0u128; row_bytes];
        for (index, &value) in database.iter().enumerate() {
            exact[index % row_bytes] += u128::from(value) * u128::from(query[index / row_bytes]);
        }
        exact
            .into_iter()
            .map(|sum| (sum % u128::from(Q)) as u64)
            .collect()
    }

    #[test]
    fn zero_database_and_zero_query_are_zero() {
        assert_eq!(multiply(&[0; 35], 7, &[Q - 1; 5]), vec![0; 7]);
        assert_eq!(multiply(&[255; 35], 7, &[0; 5]), vec![0; 7]);
    }

    #[test]
    fn isolated_rows_and_column_boundaries_match_exact_products() {
        let rows = 17;
        let cols = 129;
        let database: Vec<u8> = (0..rows * cols).map(|i| (i % 256) as u8).collect();
        for selected in [0, 1, 8, rows - 1] {
            let mut query = vec![0; rows];
            query[selected] = Q - 1;
            let expected: Vec<u64> = database[selected * cols..(selected + 1) * cols]
                .iter()
                .map(|&value| ((u128::from(value) * u128::from(Q - 1)) % u128::from(Q)) as u64)
                .collect();
            assert_eq!(multiply(&database, cols, &query), expected);
        }
    }

    #[test]
    fn maximum_bytes_and_overflowing_sums_match_u128_oracle() {
        let database = vec![255; 2048 * 33];
        for coefficient in [1, Q - 1, u64::MAX] {
            let query = vec![coefficient; 2048];
            assert_eq!(
                multiply(&database, 33, &query),
                oracle(&database, 33, &query)
            );
        }
    }

    #[test]
    fn seeded_varied_shapes_match_independent_oracle_and_old_scan() {
        let mut state = 0x243f_6a88_85a3_08d3u64;
        for (rows, cols) in [(1, 1), (3, 7), (31, 65), (257, 513)] {
            let mut next = || {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state
            };
            let database: Vec<u8> = (0..rows * cols).map(|_| next() as u8).collect();
            let query: Vec<u64> = (0..rows).map(|_| next() & (Q - 1)).collect();
            let expected = oracle(&database, cols, &query);
            assert_eq!(multiply(&database, cols, &query), expected);
            assert_eq!(column_strided(&database, cols, &query), expected);
        }
    }

    #[test]
    fn production_geometry_lifted_query_matches_wide_integer_oracle() {
        let rows = 2048;
        let cols = 8192;
        let database: Vec<u8> = (0..rows * cols)
            .map(|i| ((i / cols * 17 + i % cols * 31) % 256) as u8)
            .collect();
        let query = benchmark_query(rows);
        assert!(query.iter().all(|&x| x < Q && x & ((1 << 26) - 1) == 0));
        let expected = oracle(&database, cols, &query);
        assert_eq!(multiply(&database, cols, &query), expected);
        assert_eq!(column_strided(&database, cols, &query), expected);
    }
}
