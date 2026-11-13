//! Experimental immutable global hash-row publications. No serving-head writes.
//!
//! One ciphertext is parsed once and evaluated against every ordered layer.
//! The only persistent input is the authenticated manifest and layer artifacts;
//! clear transaction identifiers never appear in that public manifest.
use super::*;
use crate::global_data as data;
use memmap2::{Mmap, MmapOptions};
use reinspiring::prepared_native;
use std::{
    collections::{BTreeSet, btree_map::Entry},
    ffi::CString,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use zakura_pir_protocol::native::{D, PREPARED_HEADER_BYTES};
#[path = "global_profile.rs"]
mod global_profile;

pub(super) fn profile_global(root: &Path, options: &[String]) -> Result<(), String> {
    global_profile::profile_global(root, options)
}

pub(super) fn serve_global_cached(root: &Path) -> Result<(), String> {
    global_profile::serve_global_cached(root)
}

const SOURCE_SCHEMA: &str = "zecblock-private-global-source-v1";
const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SUMMARY_BYTES: usize = 16 * 1024;
const MAX_LAYERS: usize = 128;
const SHARD_BLOCKS: usize = 16;
const MAX_REQUEST_LINE: usize = 64 * 1024;
const MAX_ANCHORS: usize = 2048;
const MAX_ANCHOR_BYTES: u64 = 256 * 1024;
const RESOURCE_LIMIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const INVALID_QUERY: &str = "Invalid encrypted global query";

struct Source {
    record_codec: &'static str,
    buckets: Vec<Vec<u8>>,
    summary: Value,
    digest: String,
    record_encoded_bytes: usize,
    bucket_encoded_bytes: usize,
    max_bucket_bytes: usize,
    layer_count: usize,
    anchor_bytes: Vec<u8>,
}

/// JSON maps use the workspace's sorted serde_json representation. Stream the
/// canonical serialization into SHA256 instead of retaining another source copy.
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn canonical_digest(value: &Value) -> Result<String, String> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).map_err(|error| error.to_string())?;
    Ok(hex::encode(writer.0.finalize()))
}

fn number(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        .ok_or("Invalid source height".into())
}

fn canonical_hash(value: &Value) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or("Missing canonical source block hash")?;
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid canonical source block hash".into());
    }
    Ok(text.to_ascii_lowercase())
}

fn add_anchor(
    anchors: &mut BTreeMap<u64, String>,
    height: u64,
    hash: String,
) -> Result<(), String> {
    match anchors.entry(height) {
        Entry::Vacant(entry) => {
            entry.insert(hash);
        }
        Entry::Occupied(entry) if entry.get() != &hash => {
            return Err("Conflicting canonical source block hashes at one height".into());
        }
        Entry::Occupied(_) => {}
    }
    if anchors.len() > MAX_ANCHORS {
        return Err("Global prototype exceeds its 2048 canonical-anchor budget".into());
    }
    Ok(())
}

fn ordinary_directory(path: &Path) -> Result<(), String> {
    if !fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_dir()
    {
        return Err("Global publication requires ordinary directories".into());
    }
    Ok(())
}

/// O_NOFOLLOW protects the final component; callers separately check every
/// publication directory component. O_NONBLOCK avoids opening special files
/// before the ordinary-file check. Artifacts live in a private immutable root.
fn open_bounded(path: &Path, min: u64, max: u64) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || !(min..=max).contains(&metadata.len()) {
        return Err("Invalid global artifact type or size".into());
    }
    Ok(file)
}

fn read_bounded(path: &Path, min: u64, max: u64) -> Result<Vec<u8>, String> {
    let file = open_bounded(path, min, max)?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != size {
        return Err("Global artifact changed while reading".into());
    }
    Ok(bytes)
}

fn read_source(path: &Path) -> Result<Source, String> {
    read_source_with_codec(path, data::RECORD_CODEC)
}

fn read_source_with_codec(path: &Path, record_codec: &'static str) -> Result<Source, String> {
    let file = open_bounded(path, 2, MAX_SOURCE_BYTES)?;
    let mut source: Value =
        serde_json::from_reader(io::BufReader::new(file.take(MAX_SOURCE_BYTES + 1)))
            .map_err(|error| error.to_string())?;
    if source["schema"] != SOURCE_SCHEMA || source["network"] != "mainnet" {
        return Err("Unsupported global source schema or network".into());
    }
    let count = source["records"]
        .as_array()
        .ok_or("Global source records must be an array")?
        .len();
    if count == 0 || count > data::ROWS {
        return Err("Global source must contain between 1 and 2048 records".into());
    }
    let digest = canonical_digest(&source)?;
    let input = source
        .as_object_mut()
        .ok_or("Global source must be an object")?
        .remove("records")
        .unwrap();
    // Consume each full envelope after compression. Only compressed entries,
    // small observation projections and then framed bucket bytes survive.
    drop(source);
    let mut grouped: Vec<Vec<data::EncodedEntry>> = (0..data::ROWS).map(|_| Vec::new()).collect();
    let mut seen = BTreeSet::new();
    let mut contexts: BTreeMap<String, Value> = BTreeMap::new();
    let mut anchors = BTreeSet::new();
    let mut canonical_anchors = BTreeMap::new();
    let mut min_height = u64::MAX;
    let mut max_height = 0;
    let mut min_snapshot = u64::MAX;
    let mut max_snapshot = 0;
    let mut min_coverage = u64::MAX;
    let mut max_coverage = 0;
    let mut earliest = String::new();
    let mut latest = String::new();
    let mut record_encoded_bytes = 0usize;
    let Value::Array(input) = input else {
        return Err("Global records must be an array".into());
    };
    for record in input {
        let entry = data::encode_entry_with_codec(&record, record_codec)?;
        if !seen.insert(entry.txid.clone()) {
            return Err("Duplicate global source transaction ID".into());
        }
        let row = data::key_row(&entry.txid)?;
        let height = number(&record["detail"]["blockHeight"])?;
        let detail_hash = canonical_hash(&record["detail"]["blockHash"])?;
        add_anchor(&mut canonical_anchors, height, detail_hash.clone())?;
        min_height = min_height.min(height);
        max_height = max_height.max(height);
        let snapshot = &record["snapshot"];
        let snapshot_height = number(&snapshot["height"])?;
        add_anchor(
            &mut canonical_anchors,
            snapshot_height,
            canonical_hash(&snapshot["hash"])?,
        )?;
        min_snapshot = min_snapshot.min(snapshot_height);
        max_snapshot = max_snapshot.max(snapshot_height);
        min_coverage = min_coverage.min(number(&record["coverage"]["startHeight"])?);
        max_coverage = max_coverage.max(number(&record["coverage"]["endHeight"])?);
        if let Some(blocks) = record["coverage"].get("blocks") {
            let blocks = blocks
                .as_array()
                .filter(|blocks| !blocks.is_empty() && blocks.len() <= MAX_ANCHORS)
                .ok_or("Invalid bounded canonical coverage block list")?;
            let start = number(&record["coverage"]["startHeight"])?;
            let end = number(&record["coverage"]["endHeight"])?;
            let mut includes_detail = false;
            for block in blocks {
                let block_height = number(&block["height"])?;
                let block_hash = canonical_hash(&block["hash"])?;
                if block_height < start || block_height > end {
                    return Err("Canonical coverage anchor lies outside its declared range".into());
                }
                if block_height == height {
                    if block_hash != detail_hash {
                        return Err("Coverage anchor disagrees with transaction block hash".into());
                    }
                    includes_detail = true;
                }
                add_anchor(&mut canonical_anchors, block_height, block_hash)?;
            }
            if !includes_detail {
                return Err("Coverage block list omits its transaction block height".into());
            }
        }
        let published = snapshot["publishedAt"]
            .as_str()
            .ok_or("Missing observation time")?;
        if earliest.is_empty() || published < earliest.as_str() {
            earliest = published.to_owned();
        }
        if latest.is_empty() || published > latest.as_str() {
            latest = published.to_owned();
        }
        anchors.insert(canonical_digest(
            &json!({"height":snapshot["height"],"hash":snapshot["hash"]}),
        )?);
        let context = json!({"snapshot":snapshot,"coverage":record["coverage"]});
        let context_digest = canonical_digest(&context)?;
        if let Entry::Vacant(entry) = contexts.entry(context_digest) {
            entry.insert(context);
        }
        record_encoded_bytes = record_encoded_bytes
            .checked_add(entry.encoded.len())
            .ok_or("Global encoded source size overflow")?;
        grouped[row].push(entry);
    }
    drop(seen);
    let context_list: Vec<_> = contexts.values().collect();
    let canonical_anchor_values: Vec<_> = canonical_anchors
        .iter()
        .map(|(height, hash)| json!({"height":height,"hash":hash}))
        .collect();
    let anchor_bytes =
        serde_json::to_vec(&canonical_anchor_values).map_err(|error| error.to_string())?;
    if anchor_bytes.len() as u64 > MAX_ANCHOR_BYTES {
        return Err("Canonical source anchors exceed their byte budget".into());
    }
    let summary = json!({
        "recordCount":count,"observationCount":contexts.len(),
        "minHeight":min_height,"maxHeight":max_height,"coverageComplete":false,
        "declaredCoverageBounds":{"minHeight":min_coverage,"maxHeight":max_coverage},
        "snapshotSummary":{"anchorCount":anchors.len(),"minHeight":min_snapshot,"maxHeight":max_snapshot,
            "lexicalMinPublishedAt":earliest,"lexicalMaxPublishedAt":latest},
        "observationContextsSha256":canonical_digest(&json!(context_list))?,
        "canonicalAnchorsSha256":hex::encode(Sha256::digest(&anchor_bytes)),"canonicalAnchorCount":canonical_anchors.len(),
        "scope":"Captured confirmed records with individual snapshot and coverage observations; no complete historical interval is claimed."
    });
    if serde_json::to_vec(&summary)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_SUMMARY_BYTES
    {
        return Err("Global source summary exceeds its limit".into());
    }
    drop(contexts);
    let mut buckets = Vec::with_capacity(data::ROWS);
    let mut bucket_encoded_bytes = 0usize;
    let mut max_bucket_bytes = 0;
    for entries in grouped {
        let bucket = data::encode_bucket_entries_with_codec(&entries, record_codec)?;
        max_bucket_bytes = max_bucket_bytes.max(bucket.len());
        bucket_encoded_bytes = bucket_encoded_bytes
            .checked_add(bucket.len())
            .ok_or("Global bucket size overflow")?;
        buckets.push(bucket);
    }
    let layer_count = max_bucket_bytes.div_ceil(data::PAYLOAD_BYTES).max(1);
    if layer_count > MAX_LAYERS {
        return Err("Global source exceeds the fixed 128-layer budget".into());
    }
    Ok(Source {
        record_codec,
        buckets,
        summary,
        digest,
        record_encoded_bytes,
        bucket_encoded_bytes,
        max_bucket_bytes,
        layer_count,
        anchor_bytes,
    })
}

fn base_manifest(source: &Source, profile: &TableProfile) -> Value {
    json!({
        "schema":data::SCHEMA,"geometry":data::GEOMETRY,"table":data::TABLE,
        "rows":data::ROWS,"rowBytes":data::ROW_BYTES,"payloadBytes":data::PAYLOAD_BYTES,
        "layerCount":source.layer_count,"hashAlgorithm":"sha256-display-v1",
        "recordCodec":source.record_codec,"network":"mainnet",
        "sourceDigest":source.digest,"sourceSummary":source.summary,"scheme":profile.scheme
    })
}

fn plan_value(source: &Source, profile: &TableProfile) -> Value {
    let layers = source.layer_count as u64;
    let database_bytes = profile.database_bytes();
    let shards = profile.blocks().div_ceil(SHARD_BLOCKS) as u64;
    let prepared_bytes = profile.prepared_planned_bytes() + (shards - 1) * PREPARED_HEADER_BYTES;
    let physical_payload = layers * data::ROWS as u64 * data::PAYLOAD_BYTES as u64;
    json!({
        "schema":"zecblock-private-global-plan-v1","geometry":data::GEOMETRY,
        "recordCodec":source.record_codec,
        "status":"experimental-uncertified","sourceDigest":source.digest,"sourceSummary":source.summary,
        "rows":data::ROWS,"rowBytes":data::ROW_BYTES,"payloadBytes":data::PAYLOAD_BYTES,
        "recordEncodedBytes":source.record_encoded_bytes,"bucketEncodedBytes":source.bucket_encoded_bytes,
        "maxBucketBytes":source.max_bucket_bytes,"layerCount":source.layer_count,
        "physicalDatabaseBytes":database_bytes*layers,"payloadCapacityBytes":physical_payload,
        "payloadPaddingBytes":physical_payload-source.bucket_encoded_bytes as u64,
        "authenticationBytes":layers*data::ROWS as u64*(data::ROW_BYTES-data::PAYLOAD_BYTES) as u64,
        "preparedPlannedBytes":prepared_bytes*layers,
        "preparedMinimumBytes":(profile.prepared_min_bytes()+(shards-1)*PREPARED_HEADER_BYTES)*layers,
        "preparedMaximumBytes":(profile.prepared_max_bytes()+(shards-1)*PREPARED_HEADER_BYTES)*layers,
        "publicHintBytes":profile.scheme.public_bytes as u64*layers,
        "requestBytes":profile.scheme.request_bytes,"replyBytes":profile.scheme.response_bytes as u64*layers,
        "plannedArtifactBytes":layers*(database_bytes+prepared_bytes+profile.scheme.public_bytes as u64),
        "preparedFilesPerLayer":shards,"packingBlocksPerFile":SHARD_BLOCKS,
        "canonicalAnchorCount":source.summary["canonicalAnchorCount"],"canonicalAnchorsBytes":source.anchor_bytes.len(),
        "resourceCaps":{"sourceBytes":MAX_SOURCE_BYTES,"sourceRecords":data::ROWS,"decodedRecordBytes":32*1024*1024,
            "layers":MAX_LAYERS,"summaryBytes":MAX_SUMMARY_BYTES,"processBudgetBytes":RESOURCE_LIMIT_BYTES,
            "canonicalAnchors":MAX_ANCHORS,"canonicalAnchorBytes":MAX_ANCHOR_BYTES,
            "residentLayers":1,"sequentialHintColumns":D,"concurrentPreprocessingBlocks":1},
        "scope":"Actual compressed input and maximum hash-bucket plan only; no preprocessing, correctness certificate, full-history capacity or anonymity claim."
    })
}

pub(super) fn plan_global(path: &Path) -> Result<(), String> {
    let source = read_source(path)?;
    let profile = data::profile()?;
    serde_json::to_writer(io::stdout().lock(), &plan_value(&source, &profile))
        .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

pub(super) fn plan_global_compact(path: &Path) -> Result<(), String> {
    let source = read_source_with_codec(path, data::COMPACT_RECORD_CODEC)?;
    let profile = data::profile()?;
    serde_json::to_writer(io::stdout().lock(), &plan_value(&source, &profile))
        .map_err(|e| e.to_string())?;
    println!();
    Ok(())
}

fn private_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|error| error.to_string())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        // This guard owns only a freshly created private random staging path.
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn rename_new(from: &Path, to: &Path) -> Result<(), String> {
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| "Invalid staging path")?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| "Invalid output path")?;
    // Both APIs atomically reject an existing destination, including an empty
    // directory. std::fs::rename alone would be able to replace that directory.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err("Atomic global preparation requires Linux or macOS".into());
    if result != 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}

fn sha_file(file: &mut File) -> Result<String, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(hex::encode(hash.finalize()))
}

/// Build a single D-column hint; never allocate the complete 32-block hint or
/// call the upstream all-block parallel preprocessor for this geometry.
fn build_block(
    database: &[u8],
    profile: &TableProfile,
    block: usize,
) -> Result<NativePreprocessed, String> {
    let start = block * D;
    let mut columns = vec![0u8; D * profile.rows];
    for col in 0..D {
        for row in 0..profile.rows {
            columns[col * profile.rows + row] = database[row * profile.row_bytes + start + col];
        }
    }
    let block_hint = hint(&profile.masks, profile.rows, D, |col| {
        &columns[col * profile.rows..(col + 1) * profile.rows]
    })?;
    NativePreprocessed::build_two_mask(&profile.setup, &block_hint[0])
        .map_err(|error| error.to_string())
}

fn write_prepared(
    path: &Path,
    profile: &TableProfile,
    blocks: &[NativePreprocessed],
) -> Result<Value, String> {
    let mut file = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    {
        let mut writer = io::BufWriter::new(&mut file);
        prepared_native::write(&mut writer, blocks).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
    }
    file.sync_all().map_err(|error| error.to_string())?;
    let bytes = file.metadata().map_err(|error| error.to_string())?.len();
    let min =
        PREPARED_HEADER_BYTES + blocks.len() as u64 * profile.native.prepared_block_min_bytes();
    let max =
        PREPARED_HEADER_BYTES + blocks.len() as u64 * profile.native.prepared_block_max_bytes();
    if !(min..=max).contains(&bytes) {
        return Err("Unexpected global prepared artifact size".into());
    }
    Ok(
        json!({"file":path.file_name().unwrap().to_str().ok_or("Invalid prepared filename")?,
        "count":blocks.len(),"bytes":bytes,"sha256":sha_file(&mut file)?}),
    )
}

fn prepare_layer(
    dir: &Path,
    profile: &TableProfile,
    database: &[u8],
    index: usize,
    root: String,
) -> Result<Value, String> {
    private_directory(dir)?;
    write_new(&dir.join("database.bin"), database)?;
    let mut first = Vec::new();
    let mut other = Vec::new();
    let mut prepared_files = Vec::new();
    for shard in 0..profile.blocks().div_ceil(SHARD_BLOCKS) {
        let mut blocks = Vec::with_capacity(SHARD_BLOCKS);
        for block in shard * SHARD_BLOCKS..((shard + 1) * SHARD_BLOCKS).min(profile.blocks()) {
            let prepared = build_block(database, profile, block)?;
            let public = profile.native.publish(std::slice::from_ref(&prepared))?;
            let half = public.len() / 2;
            first.extend_from_slice(&public[..half]);
            other.extend_from_slice(&public[half..]);
            blocks.push(prepared);
        }
        let file = dir.join(format!("prepared-{shard:02}.bin"));
        prepared_files.push(write_prepared(&file, profile, &blocks)?);
        drop(blocks);
    }
    first.extend(other);
    if first.len() != profile.scheme.public_bytes {
        return Err("Global public setup length mismatch".into());
    }
    write_new(&dir.join("public.bin"), &first)?;
    let layer = json!({"index":index,"merkleRoot":root,"databaseSha256":hex::encode(Sha256::digest(database)),
        "publicSha256":hex::encode(Sha256::digest(&first)),"preparedFiles":prepared_files});
    // Exercise the exact mapped reader, setup identity and canonical public-mask
    // order before finalizing the immutable layer; release it immediately.
    drop(load_layer(dir, profile, &layer)?);
    sync_directory(dir)?;
    Ok(layer)
}

pub(super) fn prepare_global(source_path: &Path, output: &Path) -> Result<(), String> {
    prepare_global_with_codec(source_path, output, data::RECORD_CODEC)
}

pub(super) fn prepare_global_compact(source_path: &Path, output: &Path) -> Result<(), String> {
    prepare_global_with_codec(source_path, output, data::COMPACT_RECORD_CODEC)
}

fn prepare_global_with_codec(
    source_path: &Path,
    output: &Path,
    record_codec: &'static str,
) -> Result<(), String> {
    if fs::symlink_metadata(output).is_ok() {
        return Err("Global output must be a new directory".into());
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    ordinary_directory(parent)?;
    let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    let name = output
        .file_name()
        .ok_or("Global output needs a directory name")?;
    let output = parent.join(name);
    let source = read_source_with_codec(source_path, record_codec)?;
    let profile = data::profile()?;
    let mut manifest = base_manifest(&source, &profile);
    let context_id = data::manifest_context_id(&manifest)?;
    manifest["contextId"] = json!(context_id);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stage_path = parent.join(format!(".global-build-{}-{nonce}", std::process::id()));
    private_directory(&stage_path)?;
    let stage = Staging(stage_path);
    write_new(&stage.0.join("anchors.json"), &source.anchor_bytes)?;
    private_directory(&stage.0.join("layers"))?;
    let mut layers = Vec::with_capacity(source.layer_count);
    eprintln!(
        "Experimental global preparation: {} layers; no noise certificate or independent cryptographic approval",
        source.layer_count
    );
    for layer in 0..source.layer_count {
        let (database, root) =
            data::build_layer(&context_id, layer, source.layer_count, &source.buckets)?;
        let dir = stage.0.join("layers").join(format!("{layer:03}"));
        layers.push(prepare_layer(&dir, &profile, &database, layer, root)?);
        eprintln!("Prepared global layer {}/{}", layer + 1, source.layer_count);
    }
    manifest["layers"] = json!(layers);
    manifest["publicationId"] = json!(data::manifest_id(&manifest)?);
    data::validate_manifest(&manifest)?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Global manifest exceeds its limit".into());
    }
    write_new(&stage.0.join("manifest.json"), &manifest_bytes)?;
    sync_directory(&stage.0.join("layers"))?;
    sync_directory(&stage.0)?;
    rename_new(&stage.0, &output)?;
    sync_directory(&parent).map_err(|error| {
        format!("Global directory was finalized but parent synchronization failed: {error}")
    })?;
    println!(
        "{}",
        json!({"publicationId":manifest["publicationId"],"layerCount":source.layer_count,
        "status":"experimental-uncertified","directory":output})
    );
    Ok(())
}

/// OFFLINE ADVERSARIAL TEST ONLY. Regenerate a mathematically consistent PIR
/// layer for D' while deliberately retaining D's Merkle commitments. Ordinary
/// preparation cannot produce this publication and no HTTP route invokes it.
pub(super) fn prepare_global_poison_test(
    clean: &Path,
    output: &Path,
    layer: usize,
    row: usize,
    payload_offset: usize,
) -> Result<(), String> {
    if layer >= MAX_LAYERS || row >= data::ROWS || payload_offset >= data::PAYLOAD_BYTES {
        return Err("Invalid offline poison-test indices".into());
    }
    if fs::symlink_metadata(output).is_ok() {
        return Err("Poison-test output must be a new directory".into());
    }
    ordinary_directory(clean)?;
    let clean = fs::canonicalize(clean).map_err(|error| error.to_string())?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    ordinary_directory(parent)?;
    let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if parent.starts_with(&clean) {
        return Err("Poison-test output must be outside the clean publication".into());
    }
    let output = parent.join(
        output
            .file_name()
            .ok_or("Poison-test output needs a directory name")?,
    );
    // This authenticates every original artifact, including mapped native
    // setup identities, before any input is hardlinked into the new directory.
    let original = GlobalEvaluator::load(&clean)?;
    if layer
        >= original.manifest["layers"]
            .as_array()
            .ok_or("Missing clean layers")?
            .len()
    {
        return Err("Invalid offline poison-test layer".into());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stage_path = parent.join(format!(
        ".global-poison-test-{}-{nonce}",
        std::process::id()
    ));
    private_directory(&stage_path)?;
    let stage = Staging(stage_path);
    eprintln!(
        "OFFLINE ADVERSARIAL TEST ONLY: rebuilding layer {layer}, row {row}, payload offset {payload_offset}; original Merkle root deliberately retained"
    );
    let manifest = write_poison_layers(
        &clean,
        &stage.0,
        &original.profile,
        &original.manifest,
        layer,
        row,
        payload_offset,
    )?;
    data::validate_manifest(&manifest)?;
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Poison-test manifest exceeds its limit".into());
    }
    write_new(&stage.0.join("manifest.json"), &bytes)?;
    sync_directory(&stage.0.join("layers"))?;
    sync_directory(&stage.0)?;
    rename_new(&stage.0, &output)?;
    sync_directory(&parent).map_err(|error| {
        format!("Poison-test directory finalized but parent synchronization failed: {error}")
    })?;
    println!(
        "{}",
        json!({"status":"offline-adversarial-test-only","directory":output,
        "publicationId":manifest["publicationId"],"originalPublicationId":original.manifest["publicationId"],
        "contextId":manifest["contextId"],"layer":layer,"row":row,"payloadOffset":payload_offset})
    );
    Ok(())
}

/// Called only with a fully authenticated immutable clean publication, or with
/// the explicit reduced-width unit-test harness. No input inode is written.
fn write_poison_layers(
    clean: &Path,
    stage: &Path,
    profile: &TableProfile,
    original: &Value,
    changed_layer: usize,
    row: usize,
    payload_offset: usize,
) -> Result<Value, String> {
    let layers = original["layers"]
        .as_array()
        .ok_or("Missing poison-test layers")?;
    if changed_layer >= layers.len()
        || row >= profile.rows
        || payload_offset >= profile.row_bytes.saturating_sub(data::AUTH_HEADER_BYTES)
    {
        return Err("Invalid offline poison-test geometry".into());
    }
    read_anchors(clean, &original["sourceSummary"])?;
    fs::hard_link(clean.join("anchors.json"), stage.join("anchors.json"))
        .map_err(|error| format!("Poison-test immutable anchors hardlink failed: {error}"))?;
    read_anchors(stage, &original["sourceSummary"])?;
    private_directory(&stage.join("layers"))?;
    let mut manifest = original.clone();
    // Any original noise certificate describes different database weights.
    // The context excludes this optional field, while the final identity binds
    // its removal. The deliberately invalid row proof is the test's only claim.
    manifest
        .as_object_mut()
        .ok_or("Invalid poison-test manifest")?
        .remove("noiseCertificate");
    for (index, layer) in layers.iter().enumerate() {
        let input = clean.join("layers").join(format!("{index:03}"));
        let output = stage.join("layers").join(format!("{index:03}"));
        if index == changed_layer {
            let size = profile.database_bytes();
            let mut database = read_bounded(&input.join("database.bin"), size, size)?;
            if layer["databaseSha256"] != hex::encode(Sha256::digest(&database)) {
                return Err("Clean database changed before poison-test copy".into());
            }
            database[row * profile.row_bytes + data::AUTH_HEADER_BYTES + payload_offset] ^= 1;
            let root = layer["merkleRoot"]
                .as_str()
                .ok_or("Missing clean Merkle root")?
                .to_owned();
            manifest["layers"][index] = prepare_layer(&output, profile, &database, index, root)?;
        } else {
            private_directory(&output)?;
            let mut files = vec!["database.bin".to_owned(), "public.bin".to_owned()];
            files.extend(
                layer["preparedFiles"]
                    .as_array()
                    .ok_or("Missing clean prepared files")?
                    .iter()
                    .map(|file| {
                        file["file"]
                            .as_str()
                            .map(str::to_owned)
                            .ok_or("Invalid clean prepared filename")
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            );
            for name in files {
                fs::hard_link(input.join(&name), output.join(&name))
                    .map_err(|error| format!("Poison-test immutable hardlink failed: {error}"))?;
            }
            drop(load_layer(&output, profile, layer)?);
            sync_directory(&output)?;
        }
    }
    if data::manifest_context_id(&manifest)?
        != original["contextId"]
            .as_str()
            .ok_or("Missing clean context")?
    {
        return Err("Poison-test unexpectedly changed the source context".into());
    }
    manifest["publicationId"] = json!(data::manifest_id(&manifest)?);
    Ok(manifest)
}

struct LoadedLayer {
    database: Vec<u8>,
    blocks: Vec<NativePreprocessed>,
}

fn read_mapping(
    path: &Path,
    profile: &TableProfile,
    prepared: &Value,
) -> Result<Vec<NativePreprocessed>, String> {
    let count = prepared["count"].as_u64().ok_or("Missing prepared count")? as usize;
    let bytes = prepared["bytes"].as_u64().ok_or("Missing prepared size")?;
    if !(1..=SHARD_BLOCKS).contains(&count) {
        return Err("Invalid prepared block count".into());
    }
    let min = PREPARED_HEADER_BYTES + count as u64 * profile.native.prepared_block_min_bytes();
    let max = PREPARED_HEADER_BYTES + count as u64 * profile.native.prepared_block_max_bytes();
    if !(min..=max).contains(&bytes) {
        return Err("Invalid prepared byte count".into());
    }
    let file = open_bounded(path, bytes, bytes)?;
    // The command accepts only immutable, owned private publications. The mmap
    // is read-only and is retained by the upstream blocks until layer release.
    let mapping: Mmap =
        unsafe { MmapOptions::new().map(&file) }.map_err(|error| error.to_string())?;
    if &mapping[..8] != b"RNMAP002" || prepared["sha256"] != hex::encode(Sha256::digest(&mapping)) {
        return Err("Global prepared artifact checksum or mode mismatch".into());
    }
    prepared_native::read(mapping, 0, &profile.setup, count).map_err(|error| error.to_string())
}

fn load_layer(dir: &Path, profile: &TableProfile, layer: &Value) -> Result<LoadedLayer, String> {
    ordinary_directory(dir)?;
    let database_bytes = profile.database_bytes();
    let database = read_bounded(&dir.join("database.bin"), database_bytes, database_bytes)?;
    if layer["databaseSha256"] != hex::encode(Sha256::digest(&database)) {
        return Err("Global database checksum mismatch".into());
    }
    let public = read_bounded(
        &dir.join("public.bin"),
        profile.scheme.public_bytes as u64,
        profile.scheme.public_bytes as u64,
    )?;
    if layer["publicSha256"] != hex::encode(Sha256::digest(&public)) {
        return Err("Global setup checksum mismatch".into());
    }
    let files = layer["preparedFiles"]
        .as_array()
        .ok_or("Missing prepared files")?;
    if files.len() != profile.blocks().div_ceil(SHARD_BLOCKS) {
        return Err("Invalid prepared shard count".into());
    }
    let mut blocks = Vec::with_capacity(profile.blocks());
    for (index, prepared) in files.iter().enumerate() {
        let name = format!("prepared-{index:02}.bin");
        if prepared["file"] != name {
            return Err("Invalid prepared artifact filename".into());
        }
        blocks.extend(read_mapping(&dir.join(name), profile, prepared)?);
    }
    if blocks.len() != profile.blocks() || profile.native.publish(&blocks)? != public {
        return Err("Global prepared setup identity mismatch".into());
    }
    Ok(LoadedLayer { database, blocks })
}

struct GlobalEvaluator {
    root: PathBuf,
    manifest: Value,
    profile: TableProfile,
}

fn read_anchors(root: &Path, summary: &Value) -> Result<Vec<u8>, String> {
    let bytes = read_bounded(&root.join("anchors.json"), 2, MAX_ANCHOR_BYTES)?;
    if summary["canonicalAnchorsSha256"] != hex::encode(Sha256::digest(&bytes)) {
        return Err("Global canonical anchor checksum mismatch".into());
    }
    let anchors: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let anchors = anchors
        .as_array()
        .filter(|anchors| !anchors.is_empty() && anchors.len() <= MAX_ANCHORS)
        .ok_or("Invalid bounded global canonical anchors")?;
    if summary["canonicalAnchorCount"].as_u64() != Some(anchors.len() as u64)
        || serde_json::to_vec(anchors).map_err(|error| error.to_string())? != bytes
    {
        return Err("Global canonical anchor count or canonical encoding mismatch".into());
    }
    let mut previous = None;
    for anchor in anchors {
        let object = anchor
            .as_object()
            .filter(|object| object.len() == 2)
            .ok_or("Invalid canonical anchor object")?;
        let height = object
            .get("height")
            .and_then(Value::as_u64)
            .ok_or("Invalid canonical anchor height")?;
        let hash = canonical_hash(&anchor["hash"])?;
        if anchor["hash"] != hash || previous.is_some_and(|prior| height <= prior) {
            return Err(
                "Canonical anchors must have unique sorted heights and lowercase hashes".into(),
            );
        }
        previous = Some(height);
    }
    Ok(bytes)
}

impl GlobalEvaluator {
    fn load(root: &Path) -> Result<Self, String> {
        ordinary_directory(root)?;
        ordinary_directory(&root.join("layers"))?;
        let bytes = read_bounded(&root.join("manifest.json"), 2, MAX_MANIFEST_BYTES)?;
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let profile = data::validate_manifest(&manifest)?;
        read_anchors(root, &manifest["sourceSummary"])?;
        // Authenticate every layer at admission, with just one layer resident.
        // Subsequent reloads repeat checks, rather than trusting path names.
        for layer in manifest["layers"]
            .as_array()
            .ok_or("Missing global layers")?
        {
            let index = layer["index"].as_u64().ok_or("Missing layer index")?;
            drop(load_layer(
                &root.join("layers").join(format!("{index:03}")),
                &profile,
                layer,
            )?);
        }
        Ok(Self {
            root: root.to_owned(),
            manifest,
            profile,
        })
    }

    fn answer(&self, upload: &[u8]) -> Result<Vec<u8>, String> {
        if upload.len() != self.profile.scheme.request_bytes {
            return Err(INVALID_QUERY.into());
        }
        // Parse exactly once. Every layer uses this same key and encrypted
        // selection under the one locally derived common TableProfile.
        let (keys, query) = self.profile.parse(upload)?;
        let layers = self.manifest["layers"]
            .as_array()
            .ok_or("Missing global layers")?;
        let mut response = Vec::with_capacity(layers.len() * self.profile.scheme.response_bytes);
        for (index, layer) in layers.iter().enumerate() {
            let loaded = load_layer(
                &self.root.join("layers").join(format!("{index:03}")),
                &self.profile,
                layer,
            )?;
            let intermediate = matvec::multiply(&loaded.database, self.profile.row_bytes, &query);
            let body = self
                .profile
                .native
                .pack(&loaded.blocks, &keys, &intermediate)?;
            if body.len() != self.profile.scheme.response_bytes {
                return Err("Global response shape mismatch".into());
            }
            response.extend(body);
            drop(loaded);
        }
        Ok(response)
    }
}

/// Read a line with a hard allocation ceiling, draining an oversized line so
/// the next JSONL frame remains well-defined. EOF without a newline is valid.
fn bounded_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if out.is_empty() && !oversized {
                None
            } else {
                Some(out)
            });
        }
        let end = available
            .iter()
            .position(|&byte| byte == b'\n')
            .map(|at| at + 1)
            .unwrap_or(available.len());
        if !oversized && out.len().saturating_add(end) <= limit {
            out.extend_from_slice(&available[..end]);
        } else {
            oversized = true;
            out.clear();
        }
        let complete = available[end - 1] == b'\n';
        reader.consume(end);
        if complete {
            return Ok(Some(out));
        }
    }
}

pub(super) fn serve_global(dir: &Path) -> Result<(), String> {
    let evaluator = GlobalEvaluator::load(dir)?;
    eprintln!(
        "Experimental global evaluator ready; all {} layers evaluated per query",
        evaluator.manifest["layerCount"]
    );
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    while let Some(line) =
        bounded_line(&mut input, MAX_REQUEST_LINE).map_err(|error| error.to_string())?
    {
        let reply = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => {
                let expected = evaluator.profile.scheme.request_bytes.div_ceil(3) * 4;
                let result = if request.query.len() == expected {
                    B64.decode(&request.query)
                        .map_err(|_| INVALID_QUERY.to_owned())
                        .and_then(|upload| evaluator.answer(&upload))
                } else {
                    Err(INVALID_QUERY.into())
                };
                match result {
                    Ok(response) => json!({"id":request.id,"response":B64.encode(response)}),
                    Err(_) => json!({"id":request.id,"error":INVALID_QUERY}),
                }
            }
            Err(_) => json!({"id":null,"error":INVALID_QUERY}),
        };
        serde_json::to_writer(&mut stdout, &reply).map_err(|error| error.to_string())?;
        writeln!(&mut stdout)
            .and_then(|_| stdout.flush())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_jsonl_drains_large_frames() {
        let mut input = io::Cursor::new(b"123456789012345\n{\"id\":2}\nlast".as_slice());
        assert_eq!(
            bounded_line(&mut input, 12).unwrap().unwrap(),
            Vec::<u8>::new()
        );
        assert_eq!(
            bounded_line(&mut input, 12).unwrap().unwrap(),
            b"{\"id\":2}\n"
        );
        assert_eq!(bounded_line(&mut input, 12).unwrap().unwrap(), b"last");
        assert!(bounded_line(&mut input, 12).unwrap().is_none());
    }

    #[test]
    fn canonical_source_digest_ignores_object_key_order() {
        let first: Value = serde_json::from_str("{\"z\":3,\"a\":{\"c\":2,\"b\":1}}").unwrap();
        let second = json!({"a":{"b":1,"c":2},"z":3});
        assert_eq!(
            canonical_digest(&first).unwrap(),
            canonical_digest(&second).unwrap()
        );
    }

    #[test]
    fn exclusive_finalize_preserves_existing_directory() {
        let root = std::env::temp_dir().join(format!(
            "global-rename-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        let guard = Staging(root.clone());
        private_directory(&root.join("from")).unwrap();
        private_directory(&root.join("existing")).unwrap();
        assert!(rename_new(&root.join("from"), &root.join("existing")).is_err());
        assert!(root.join("from").is_dir());
        rename_new(&root.join("from"), &root.join("new")).unwrap();
        assert!(root.join("new").is_dir());
        drop(guard);
    }

    #[test]
    fn artifact_reader_rejects_symlinks_and_wrong_sizes() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "global-reader-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        let guard = Staging(root.clone());
        write_new(&root.join("file"), b"abc").unwrap();
        symlink(root.join("file"), root.join("link")).unwrap();
        assert!(read_bounded(&root.join("link"), 3, 3).is_err());
        assert!(read_bounded(&root.join("file"), 4, 4).is_err());
        assert!(read_bounded(&root, 0, 1000).is_err());
        assert_eq!(read_bounded(&root.join("file"), 3, 3).unwrap(), b"abc");
        drop(guard);
    }

    fn record(index: u32, snapshot_height: u64) -> Value {
        // A small structurally valid v1 wire transaction for local algebra and
        // source-contract checks; this is not an observed mainnet transaction.
        let mut raw = 1_u32.to_le_bytes().to_vec();
        raw.push(1);
        raw.extend([0; 32]);
        raw.extend(u32::MAX.to_le_bytes());
        raw.push(4);
        raw.extend(index.to_le_bytes());
        raw.extend(u32::MAX.to_le_bytes());
        raw.push(1);
        raw.extend(1_u64.to_le_bytes());
        raw.push(1);
        raw.push(0x51);
        raw.extend(0_u32.to_le_bytes());
        let txid = Txid(TransactionView::parse_exact(&raw).unwrap().txid()).to_display_hex();
        json!({"schema":full_record::RECORD_SCHEMA,"network":"mainnet","txid":txid,
            "snapshot":{"height":snapshot_height,"hash":"22".repeat(32),"publishedAt":"2026-11-02T00:00:00Z"},
            "coverage":{"startHeight":0,"endHeight":snapshot_height,"complete":false},
            "detail":{"txid":txid,"status":"confirmed","isCanonical":true,"blockHeight":1,
                "blockHash":"11".repeat(32),"feeZat":null,"inputs":[],"outputs":[]},
            "raw":{"hex":hex::encode(&raw),"decoded":{"txid":txid,"hex":hex::encode(&raw)}}})
    }

    #[test]
    fn actual_source_plan_preserves_mixed_observations_without_catalogue() {
        let root = std::env::temp_dir().join(format!(
            "global-source-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        let guard = Staging(root.clone());
        let input = json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[record(1,100),record(2,200)]});
        write_new(
            &root.join("source.json"),
            &serde_json::to_vec(&input).unwrap(),
        )
        .unwrap();
        let source = read_source(&root.join("source.json")).unwrap();
        assert_eq!(source.digest, canonical_digest(&input).unwrap());
        assert_eq!(source.summary["recordCount"], 2);
        assert_eq!(source.summary["observationCount"], 2);
        assert_eq!(source.summary["snapshotSummary"]["minHeight"], 100);
        assert_eq!(source.summary["snapshotSummary"]["maxHeight"], 200);
        assert_eq!(source.summary["coverageComplete"], false);
        assert_eq!(source.summary["canonicalAnchorCount"], 3);
        let anchors: Value = serde_json::from_slice(&source.anchor_bytes).unwrap();
        assert_eq!(
            anchors,
            json!([{"height":1,"hash":"11".repeat(32)},
            {"height":100,"hash":"22".repeat(32)},{"height":200,"hash":"22".repeat(32)}])
        );
        write_new(&root.join("anchors.json"), &source.anchor_bytes).unwrap();
        assert_eq!(
            read_anchors(&root, &source.summary).unwrap(),
            source.anchor_bytes
        );
        let mut wrong = source.summary.clone();
        wrong["canonicalAnchorCount"] = json!(2);
        assert!(read_anchors(&root, &wrong).is_err());
        wrong = source.summary.clone();
        wrong["canonicalAnchorsSha256"] = json!("00".repeat(32));
        assert!(read_anchors(&root, &wrong).is_err());
        let plan = plan_value(&source, &data::profile().unwrap());
        assert_eq!(plan["layerCount"], 1);
        assert_eq!(plan["physicalDatabaseBytes"], 128 * 1024 * 1024);
        assert_eq!(plan["requestBytes"], 20_992);
        assert_eq!(plan["replyBytes"], 81_920);
        let bytes = serde_json::to_vec(&plan).unwrap();
        assert!(
            !String::from_utf8(bytes)
                .unwrap()
                .contains(input["records"][0]["txid"].as_str().unwrap())
        );
        for entry in input["records"].as_array().unwrap() {
            let txid = entry["txid"].as_str().unwrap();
            let decoded = data::decode_bucket(&source.buckets[data::key_row(txid).unwrap()], txid)
                .unwrap()
                .unwrap();
            assert_eq!(&decoded, entry);
        }
        drop(guard);
    }

    #[test]
    fn canonical_source_anchors_reject_conflicts_missing_detail_and_excess_count() {
        let root = std::env::temp_dir().join(format!(
            "global-anchor-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        let guard = Staging(root.clone());
        let mut first = record(1, 4000);
        first["coverage"]["blocks"] =
            json!([{"height":1,"hash":"11".repeat(32)},{"height":2,"hash":"33".repeat(32)}]);
        let path = root.join("source.json");
        let input = json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[first.clone()]});
        fs::write(&path, serde_json::to_vec(&input).unwrap()).unwrap();
        assert_eq!(
            read_source(&path).unwrap().summary["canonicalAnchorCount"],
            3
        );
        first["coverage"]["blocks"][0]["hash"] = json!("44".repeat(32));
        fs::write(
            &path,
            serde_json::to_vec(
                &json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[first.clone()]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(read_source(&path).is_err());
        first["coverage"]["blocks"] = json!([{"height":2,"hash":"33".repeat(32)}]);
        fs::write(
            &path,
            serde_json::to_vec(
                &json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[first.clone()]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(read_source(&path).is_err());
        first["coverage"].as_object_mut().unwrap().remove("blocks");
        let mut second = record(2, 4000);
        second["detail"]["blockHash"] = json!("55".repeat(32));
        fs::write(&path,serde_json::to_vec(&json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[first.clone(),second]})).unwrap()).unwrap();
        assert!(read_source(&path).is_err());
        first["coverage"]["blocks"]=json!((0..2048).map(|height|json!({"height":height,"hash":if height==1 {"11".repeat(32)} else {"33".repeat(32)}})).collect::<Vec<_>>());
        fs::write(
            &path,
            serde_json::to_vec(
                &json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[first]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            read_source(&path)
                .err()
                .unwrap()
                .contains("2048 canonical-anchor")
        );
        drop(guard);
    }

    #[test]
    fn real_native_one_query_evaluates_two_mapped_layers_with_exact_rows() {
        use zakura_pir_client::transparent::native::TableClientExt as _;
        // Reduced row width is TEST ONLY. The public client and manifest retain
        // the strict 2048 x 65536 geometry. This exercises the exact pinned P8
        // key/query/packing algebra, persistent format and same-query reuse.
        let production = data::profile().unwrap();
        let mut profile =
            TableProfile::new(data::SCHEMA, data::GEOMETRY, data::TABLE, 2048, 2048).unwrap();
        // First-dimension masks also bind the column count upstream. Copy the
        // real geometry's masks into this TEST ONLY shorter reply harness, so
        // these are actual global query keys and selections with only one
        // packing block persisted for each test layer.
        profile.masks.clone_from(&production.masks);
        assert_eq!(profile.setup.id(), production.setup.id());
        assert_eq!(
            profile.scheme.request_bytes,
            production.scheme.request_bytes
        );
        let root = std::env::temp_dir().join(format!(
            "global-crypto-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        let guard = Staging(root.clone());
        let databases: Vec<Vec<u8>> = (0..2)
            .map(|layer| {
                (0..profile.rows * profile.row_bytes)
                    .map(|index| {
                        ((index / profile.row_bytes * 17
                            + index % profile.row_bytes * 31
                            + layer * 73)
                            % 256) as u8
                    })
                    .collect()
            })
            .collect();
        let mut layers = Vec::new();
        for (index, database) in databases.iter().enumerate() {
            layers.push(
                prepare_layer(
                    &root.join(format!("{index:03}")),
                    &profile,
                    database,
                    index,
                    "11".repeat(32),
                )
                .unwrap(),
            );
        }
        for selected in [0, 1023, 2047] {
            let (secret, upload) = profile.prepare(selected).unwrap();
            let (keys, query) = profile.parse(&upload).unwrap();
            let mut replies = Vec::new();
            for (index, layer) in layers.iter().enumerate() {
                let loaded =
                    load_layer(&root.join(format!("{index:03}")), &profile, layer).unwrap();
                let intermediate = matvec::multiply(&loaded.database, profile.row_bytes, &query);
                let response = profile
                    .native
                    .pack(&loaded.blocks, &keys, &intermediate)
                    .unwrap();
                assert_eq!(response.len(), profile.scheme.response_bytes);
                let public = fs::read(root.join(format!("{index:03}/public.bin"))).unwrap();
                let decoded = profile.decode(&secret, &public, &response).unwrap();
                assert_eq!(
                    decoded,
                    databases[index]
                        [selected * profile.row_bytes..(selected + 1) * profile.row_bytes]
                );
                replies.extend(response);
            }
            assert_eq!(replies.len(), 2 * profile.scheme.response_bytes);
        }
        let wrong = TableProfile::new(
            data::SCHEMA,
            "different-test-setup",
            data::TABLE,
            2048,
            2048,
        )
        .unwrap();
        assert!(load_layer(&root.join("000"), &wrong, &layers[0]).is_err());
        let mut bad = layers[0].clone();
        bad["preparedFiles"][0]["sha256"] = json!("00".repeat(32));
        assert!(load_layer(&root.join("000"), &profile, &bad).is_err());
        bad = layers[0].clone();
        bad["databaseSha256"] = json!("00".repeat(32));
        assert!(load_layer(&root.join("000"), &profile, &bad).is_err());
        drop(guard);
    }

    #[test]
    fn offline_poison_rebuilds_consistent_pir_but_fails_selected_merkle_authentication() {
        use std::os::unix::fs::MetadataExt;
        use zakura_pir_client::transparent::native::TableClientExt as _;
        let root = std::env::temp_dir().join(format!(
            "global-poison-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        let guard = Staging(root.clone());
        let selected = record(11, 100);
        let selected_id = selected["txid"].as_str().unwrap();
        let selected_row = data::key_row(selected_id).unwrap();
        let unaffected = (12..100)
            .map(|index| record(index, 100))
            .find(|record| data::key_row(record["txid"].as_str().unwrap()).unwrap() != selected_row)
            .unwrap();
        let other_id = unaffected["txid"].as_str().unwrap();
        let other_row = data::key_row(other_id).unwrap();
        let input =
            json!({"schema":SOURCE_SCHEMA,"network":"mainnet","records":[selected,unaffected]});
        write_new(
            &root.join("source.json"),
            &serde_json::to_vec(&input).unwrap(),
        )
        .unwrap();
        let mut source = read_source(&root.join("source.json")).unwrap();
        // Two layers deliberately cover this one-layer bucket. This creates a
        // real all-padding second layer for the poisoned-unused-layer case.
        source.layer_count = 2;
        let production = data::profile().unwrap();
        let mut profile =
            TableProfile::new(data::SCHEMA, data::GEOMETRY, data::TABLE, 2048, 2048).unwrap();
        profile.masks.clone_from(&production.masks);
        let mut original = base_manifest(&source, &production);
        let context = data::manifest_context_id(&original).unwrap();
        original["contextId"] = json!(context);
        let clean = root.join("clean");
        private_directory(&clean).unwrap();
        write_new(&clean.join("anchors.json"), &source.anchor_bytes).unwrap();
        private_directory(&clean.join("layers")).unwrap();
        let mut layers = Vec::new();
        for index in 0..2 {
            let (full, merkle) = data::build_layer(&context, index, 2, &source.buckets).unwrap();
            // TEST ONLY reduced reply storage; all omitted plaintext bytes are
            // zero. Restoring that tail reproduces the actual 64 KiB leaf.
            let narrow: Vec<u8> = full
                .chunks_exact(data::ROW_BYTES)
                .flat_map(|row| row[..profile.row_bytes].iter().copied())
                .collect();
            assert!(
                full.chunks_exact(data::ROW_BYTES)
                    .all(|row| row[profile.row_bytes..].iter().all(|&byte| byte == 0))
            );
            drop(full);
            layers.push(
                prepare_layer(
                    &clean.join("layers").join(format!("{index:03}")),
                    &profile,
                    &narrow,
                    index,
                    merkle,
                )
                .unwrap(),
            );
        }
        original["layers"] = json!(layers);
        original["publicationId"] = json!(data::manifest_id(&original).unwrap());
        write_new(
            &clean.join("manifest.json"),
            &serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        let clean_hashes: Vec<_> = (0..2)
            .map(|index| {
                hex::encode(Sha256::digest(
                    fs::read(clean.join(format!("layers/{index:03}/database.bin"))).unwrap(),
                ))
            })
            .collect();
        for changed in 0..2 {
            let target = root.join(format!("poison-{changed}"));
            private_directory(&target).unwrap();
            let poisoned = write_poison_layers(
                &clean,
                &target,
                &profile,
                &original,
                changed,
                selected_row,
                0,
            )
            .unwrap();
            assert_eq!(poisoned["contextId"], original["contextId"]);
            assert_eq!(poisoned["sourceDigest"], original["sourceDigest"]);
            assert_eq!(poisoned["sourceSummary"], original["sourceSummary"]);
            assert_ne!(poisoned["publicationId"], original["publicationId"]);
            for index in 0..2 {
                assert_eq!(
                    poisoned["layers"][index]["merkleRoot"],
                    original["layers"][index]["merkleRoot"]
                );
                let clean_path = clean.join(format!("layers/{index:03}/database.bin"));
                let target_path = target.join(format!("layers/{index:03}/database.bin"));
                assert_eq!(
                    hex::encode(Sha256::digest(fs::read(&clean_path).unwrap())),
                    clean_hashes[index]
                );
                if index == changed {
                    assert_ne!(
                        fs::metadata(clean_path).unwrap().ino(),
                        fs::metadata(target_path).unwrap().ino()
                    );
                } else {
                    assert_eq!(
                        fs::metadata(clean_path).unwrap().ino(),
                        fs::metadata(target_path).unwrap().ino()
                    );
                }
            }
            for selected in [selected_row, other_row] {
                let (secret, upload) = profile.prepare(selected).unwrap();
                let (keys, query) = profile.parse(&upload).unwrap();
                // Evaluate/decrypt the COMPLETE fixed two-layer bundle before
                // any selected row authentication, including the padding layer.
                let mut decoded = Vec::new();
                for (index, layer) in poisoned["layers"].as_array().unwrap().iter().enumerate() {
                    let loaded =
                        load_layer(&target.join(format!("layers/{index:03}")), &profile, layer)
                            .unwrap();
                    let intermediate =
                        matvec::multiply(&loaded.database, profile.row_bytes, &query);
                    let response = profile
                        .native
                        .pack(&loaded.blocks, &keys, &intermediate)
                        .unwrap();
                    let public =
                        fs::read(target.join(format!("layers/{index:03}/public.bin"))).unwrap();
                    let mut row = profile.decode(&secret, &public, &response).unwrap();
                    assert_eq!(
                        row,
                        loaded.database
                            [selected * profile.row_bytes..(selected + 1) * profile.row_bytes]
                    );
                    row.resize(data::ROW_BYTES, 0);
                    decoded.push(row);
                }
                for (index, row) in decoded.iter().enumerate() {
                    let verified = data::verify_row(
                        row,
                        &context,
                        index,
                        2,
                        selected,
                        poisoned["layers"][index]["merkleRoot"].as_str().unwrap(),
                    );
                    if selected == selected_row && index == changed {
                        assert!(verified.is_err());
                    } else {
                        assert!(verified.is_ok());
                    }
                }
            }
        }
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(clean.join("manifest.json")).unwrap())
                .unwrap(),
            original
        );
        drop(guard);
    }
}
