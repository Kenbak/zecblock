//! Explicit offline profiling and opt-in immutable-epoch caching.
//! Neither path changes the default evaluator or the client wire format.
//!
//! Cached admission assumes a trusted root publisher creates controlled inodes,
//! closes every writable descriptor, and never mutates admitted inodes through
//! any alias. Ownership/modes deny writes by the unprivileged query process;
//! metadata checks detect replacement and accidental changes. They cannot make
//! a file-backed mmap safe against a root writer concurrently truncating it.
use super::*;
use rayon::prelude::*;
use std::{os::unix::fs::MetadataExt, time::Instant};
use zakura_pir_client::transparent::native::TableClientExt as _;

type Stages = BTreeMap<String, u64>;
const BENCHMARK_ROW: usize = 0;

fn timed<T>(stages: &mut Stages, name: &str, action: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let result = action();
    *stages.entry(name.to_owned()).or_default() += start.elapsed().as_nanos() as u64;
    result
}

fn pack_timed(
    profile: &TableProfile,
    blocks: &[NativePreprocessed],
    keys: &zakura_pir_server_core::native::NativeKeys,
    intermediate: &[u64],
    stages: &mut Stages,
) -> Result<Vec<u8>, String> {
    if blocks.is_empty() || intermediate.len() != blocks.len() * D {
        return Err("Profile packing shape mismatch".into());
    }
    let prepared = timed(stages, "packingKeyPreparationNs", || {
        blocks[0].prepare_keys(keys)
    })
    .map_err(|error| error.to_string())?;
    // Identical pinned primitives and block order to ProfileQueryExt::pack.
    let packed = timed(stages, "packingMatrixAndFinishNs", || {
        blocks
            .par_iter()
            .zip(intermediate.par_chunks_exact(D))
            .map(|(block, body)| block.prepare_pack(&prepared)?.finish_two_mask(body))
            .collect::<Result<Vec<_>, _>>()
    })
    .map_err(|error| error.to_string())?;
    let response = timed(stages, "responseEncodingNs", || {
        let bodies = packed
            .iter()
            .flat_map(|ciphertext| ciphertext.rows().2.iter().copied())
            .collect::<Vec<_>>();
        profile.native.response(&bodies)
    });
    Ok(response)
}

struct BenchLayer {
    database: Vec<u8>,
    blocks: Vec<NativePreprocessed>,
    public: Vec<u8>,
}

fn load_baseline(
    root: &Path,
    profile: &TableProfile,
    layer: &Value,
    stages: &mut Stages,
) -> Result<BenchLayer, String> {
    ordinary_directory(root)?;
    let size = profile.database_bytes();
    let database = timed(stages, "databaseReadNs", || {
        read_bounded(&root.join("database.bin"), size, size)
    })?;
    let hash = timed(stages, "databaseHashNs", || {
        hex::encode(Sha256::digest(&database))
    });
    if layer["databaseSha256"] != hash {
        return Err("Profile database checksum mismatch".into());
    }
    let public = timed(stages, "publicReadNs", || {
        read_bounded(
            &root.join("public.bin"),
            profile.scheme.public_bytes as u64,
            profile.scheme.public_bytes as u64,
        )
    })?;
    let hash = timed(stages, "publicHashNs", || {
        hex::encode(Sha256::digest(&public))
    });
    if layer["publicSha256"] != hash {
        return Err("Profile public checksum mismatch".into());
    }
    let files = layer["preparedFiles"]
        .as_array()
        .ok_or("Profile prepared files missing")?;
    let mut blocks = Vec::with_capacity(profile.blocks());
    for (index, prepared) in files.iter().enumerate() {
        if prepared["file"] != format!("prepared-{index:02}.bin") {
            return Err("Profile prepared filename mismatch".into());
        }
        let count = prepared["count"]
            .as_u64()
            .ok_or("Profile prepared count missing")? as usize;
        let bytes = prepared["bytes"]
            .as_u64()
            .ok_or("Profile prepared size missing")?;
        let file = timed(stages, "preparedOpenNs", || {
            open_bounded(&root.join(format!("prepared-{index:02}.bin")), bytes, bytes)
        })?;
        let mapping = timed(stages, "preparedMmapNs", || unsafe {
            MmapOptions::new().map(&file)
        })
        .map_err(|error| error.to_string())?;
        let hash = timed(stages, "preparedHashNs", || {
            hex::encode(Sha256::digest(&mapping))
        });
        if &mapping[..8] != b"RNMAP002" || prepared["sha256"] != hash {
            return Err("Profile prepared checksum or mode mismatch".into());
        }
        blocks.extend(
            timed(stages, "preparedParseAndCoefficientValidationNs", || {
                prepared_native::read(mapping, 0, &profile.setup, count)
            })
            .map_err(|error| error.to_string())?,
        );
    }
    let published = timed(stages, "publicPublishCompareNs", || {
        profile.native.publish(&blocks)
    })?;
    if blocks.len() != profile.blocks() || published != public {
        return Err("Profile native setup mismatch".into());
    }
    Ok(BenchLayer {
        database,
        blocks,
        public,
    })
}

fn metadata_admission(root: &Path) -> Result<(Value, TableProfile), String> {
    ordinary_directory(root)?;
    ordinary_directory(&root.join("layers"))?;
    let manifest: Value = serde_json::from_slice(&read_bounded(
        &root.join("manifest.json"),
        2,
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|error| error.to_string())?;
    let profile = data::validate_manifest(&manifest)?;
    read_anchors(root, &manifest["sourceSummary"])?;
    Ok((manifest, profile))
}

fn process_snapshot() -> Value {
    #[cfg(target_os = "linux")]
    {
        let mut value = json!({"platform":"linux"});
        if let Ok(stat) = fs::read_to_string("/proc/self/stat") {
            if let Some((_, tail)) = stat.rsplit_once(") ") {
                let fields: Vec<_> = tail.split_whitespace().collect();
            let field = |index: usize| fields.get(index).and_then(|word| word.parse::<u64>().ok());
                value["process"] = json!({"minorFaults":field(7),"majorFaults":field(9),"userTicks":field(11),"systemTicks":field(12),"rssPages":field(21)});
            }
        }
        if let Ok(contents) = fs::read_to_string("/proc/self/io") {
            value["io"] = json!(contents);
        }
        if let Ok(contents) = fs::read_to_string("/proc/self/status") {
            value["status"] = json!(
                contents
                    .lines()
                    .filter(
                        |line| ["VmPeak:", "VmSize:", "VmHWM:", "VmRSS:", "Threads:"]
                            .iter()
                            .any(|prefix| line.starts_with(prefix))
                    )
                    .collect::<Vec<_>>()
            );
        }
        if let Ok(contents) = fs::read_to_string("/proc/self/cgroup") {
            if let Some(path) = contents.lines().find_map(|line| line.strip_prefix("0::")) {
                let cgroup = Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/'));
                let mut files = BTreeMap::new();
                for name in [
                    "cpu.max",
                    "cpu.stat",
                    "memory.current",
                    "memory.peak",
                    "memory.high",
                    "memory.max",
                    "memory.events",
                    "io.stat",
                    "io.weight",
                ] {
                    if let Ok(contents) = fs::read_to_string(cgroup.join(name)) {
                        files.insert(name, contents);
                    }
                }
                value["cgroup"] = json!(files);
            }
        }
        value
    }
    #[cfg(not(target_os = "linux"))]
    {
        json!({"platform":std::env::consts::OS,"counters":"Linux proc/cgroup counters unavailable"})
    }
}

struct Evaluation {
    response: Vec<u8>,
    expected: Vec<Vec<u8>>,
    public: Vec<Vec<u8>>,
    stages: Stages,
    layers: Vec<Value>,
}

fn baseline(
    root: &Path,
    profile: &TableProfile,
    manifest: &Value,
    upload: &[u8],
    limit: usize,
) -> Result<Evaluation, String> {
    let mut stages = Stages::new();
    let (keys, query) = timed(&mut stages, "queryParseNs", || profile.parse(upload))?;
    let mut response = Vec::with_capacity(limit * profile.scheme.response_bytes);
    let mut expected = Vec::with_capacity(limit);
    let mut public = Vec::with_capacity(limit);
    let mut layers = Vec::new();
    for (index, layer) in manifest["layers"]
        .as_array()
        .unwrap()
        .iter()
        .take(limit)
        .enumerate()
    {
        let mut times = Stages::new();
        let loaded = load_baseline(
            &root.join("layers").join(format!("{index:03}")),
            profile,
            layer,
            &mut times,
        )?;
        let intermediate = timed(&mut times, "matvecNs", || {
            matvec::multiply(&loaded.database, profile.row_bytes, &query)
        });
        let body = pack_timed(profile, &loaded.blocks, &keys, &intermediate, &mut times)?;
        response.extend(body);
        expected.push(
            loaded.database
                [BENCHMARK_ROW * profile.row_bytes..(BENCHMARK_ROW + 1) * profile.row_bytes]
                .to_vec(),
        );
        public.push(loaded.public);
        for (key, value) in &times {
            *stages.entry(key.clone()).or_default() += value;
        }
        layers.push(json!({"index":index,"stagesNs":times}));
    }
    Ok(Evaluation {
        response,
        expected,
        public,
        stages,
        layers,
    })
}

fn verify_evaluation(
    profile: &TableProfile,
    manifest: &Value,
    secret: &zakura_pir_client::transparent::native::NativeSecret,
    evaluation: &Evaluation,
) -> Result<(), String> {
    if evaluation.response.len() != evaluation.expected.len() * profile.scheme.response_bytes {
        return Err("Profile response length mismatch".into());
    }
    for (index, ((response, public), expected)) in evaluation
        .response
        .chunks_exact(profile.scheme.response_bytes)
        .zip(&evaluation.public)
        .zip(&evaluation.expected)
        .enumerate()
    {
        let decoded = profile.decode(secret, public, response)?;
        if &decoded != expected {
            return Err("Profile decoded row differs from database".into());
        }
        data::verify_row(
            &decoded,
            manifest["contextId"].as_str().unwrap(),
            index,
            manifest["layers"].as_array().unwrap().len(),
            BENCHMARK_ROW,
            manifest["layers"][index]["merkleRoot"].as_str().unwrap(),
        )?;
    }
    Ok(())
}

fn serialize_profile_reply(evaluation: &mut Evaluation) -> Result<(), String> {
    // Measure the same JSON/base64 work without printing or retaining its body.
    timed(&mut evaluation.stages, "jsonBase64SerializationNs", || {
        let framed = json!({"id":0,"response":B64.encode(&evaluation.response)});
        serde_json::to_vec(&framed).map(|bytes| bytes.len())
    })
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn profile_global(root: &Path, options: &[String]) -> Result<(), String> {
    let mut mode = "baseline";
    let mut limit = Some(1usize);
    let mut iterations = 1usize;
    let mut at = 0;
    while at < options.len() {
        let argument = options
            .get(at + 1)
            .ok_or("Profile options require a value")?;
        match options[at].as_str() {
            "--mode" if ["baseline","cached","compare"].contains(&argument.as_str())=>mode=argument,
            "--layers" if argument=="all"=>limit=None,
            "--layers"=>limit=Some(argument.parse().map_err(|_|"Invalid profile layer count")?),
            "--iterations"=>iterations=argument.parse().map_err(|_|"Invalid profile iteration count")?,
            _=>return Err("Usage: profile-global <publication> [--mode baseline|cached|compare] [--layers N|all] [--iterations 1..20]".into()),
        }
        at += 2;
    }
    if !(1..=20).contains(&iterations) {
        return Err("Profile iterations must be between 1 and 20".into());
    }
    let before = process_snapshot();
    let start = Instant::now();
    let (manifest, profile) = metadata_admission(root)?;
    let count = manifest["layers"].as_array().unwrap().len();
    let limit = limit.unwrap_or(count);
    if limit == 0 || limit > count {
        return Err("Profile layer limit exceeds publication".into());
    }
    let metadata_ns = start.elapsed().as_nanos();
    let mut cached = if mode != "baseline" {
        Some(CachedEvaluator::load(root, Some(limit))?)
    } else {
        None
    };
    if cached
        .as_ref()
        .is_some_and(|cache| cache.manifest != manifest)
    {
        return Err("Publication changed between profile metadata and cached admission".into());
    }
    let mut runs = Vec::new();
    for iteration in 0..iterations {
        let encryption = Instant::now();
        let (secret, upload) = profile.prepare(BENCHMARK_ROW)?;
        let encryption_ns = encryption.elapsed().as_nanos();
        let mut prior = None;
        for run_mode in if mode == "compare" && iteration % 2 == 0 {
            vec!["baseline", "cached"]
        } else if mode == "compare" {
            vec!["cached", "baseline"]
        } else {
            vec![mode]
        } {
            let process_before = process_snapshot();
            let start = Instant::now();
            let mut evaluation = if run_mode == "baseline" {
                baseline(root, &profile, &manifest, &upload, limit)?
            } else {
                cached.as_mut().unwrap().evaluate_profile(&upload)?
            };
            serialize_profile_reply(&mut evaluation)?;
            let evaluation_ns = start.elapsed().as_nanos();
            let verify = Instant::now();
            verify_evaluation(&profile, &manifest, &secret, &evaluation)?;
            let verify_ns = verify.elapsed().as_nanos();
            if let Some(expected) = &prior
                && expected != &evaluation.response
            {
                return Err("Baseline/cached encrypted replies differ".into());
            }
            if mode == "compare" && prior.is_none() {
                prior = Some(evaluation.response.clone());
            }
            runs.push(json!({"mode":run_mode,"iteration":iteration,"evaluationWallNs":evaluation_ns,
                "clientVerificationNs":verify_ns,"freshClientPreparationNs":encryption_ns,"stagesNs":evaluation.stages,
                "layers":evaluation.layers,"responseBytes":evaluation.response.len(),"decodedRowsAndMerkleProofsMatch":true,
                "processBefore":process_before,"processAfter":process_snapshot()}));
        }
    }
    let report = json!({"schema":"zecblock-global-profile-v1","publicationId":manifest["publicationId"],"mode":mode,
        "publicationLayers":count,"evaluatedLayers":limit,"completePublication":limit==count,"iterations":iterations,
        "metadataAdmissionNs":metadata_ns,"cachedAdmission":cached.as_ref().map(|cache|&cache.admission),
        "baselineAdmissionScope":"Metadata and anchors only; each baseline run performs full evaluated-layer artifact checks. Cached artifact admission is reported separately.",
        "evaluationTimingScope":"Pinned evaluation stages, benchmark row/public bookkeeping and JSON/base64 encoding; excludes client preparation, post-evaluation verification and socket transport.",
        "comparisonPerformed":mode=="compare","sameCiphertextRepliesByteIdentical":if mode=="compare" {Some(true)} else {None},"runs":runs,"processBeforeAdmission":before,"processAfter":process_snapshot(),
        "scope":"Offline public benchmark only. Prefix evaluation is not a complete protocol response. No query, secret, selected identifier or row contents are reported. Prepared parse and coefficient validation share one upstream API timing; proc/cgroup counters are cumulative snapshots, not per-stage attribution."});
    serde_json::to_writer(io::stdout().lock(), &report).map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    len: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
}
impl Identity {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            len: metadata.len(),
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            links: metadata.nlink(),
            mtime: metadata.mtime(),
            mtime_ns: metadata.mtime_nsec(),
            ctime: metadata.ctime(),
            ctime_ns: metadata.ctime_nsec(),
        }
    }
}

struct FileGuard {
    path: PathBuf,
    file: File,
    identity: Identity,
}
impl FileGuard {
    fn open(
        path: &Path,
        directory: bool,
        min: u64,
        max: u64,
        enforce: bool,
    ) -> Result<Self, String> {
        let file = if directory {
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK)
                .open(path)
                .map_err(|error| error.to_string())?
        } else {
            open_bounded(path, min, max)?
        };
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if directory != metadata.is_dir() || !directory && !metadata.is_file() {
            return Err("Cached publication artifact type mismatch".into());
        }
        if enforce {
            enforce_artifact_policy(&metadata, directory)?;
        }
        let guard = Self {
            path: path.to_owned(),
            file,
            identity: Identity::from(&metadata),
        };
        guard.check()?;
        Ok(guard)
    }
    fn check(&self) -> Result<(), String> {
        let descriptor = Identity::from(&self.file.metadata().map_err(|error| error.to_string())?);
        let path =
            Identity::from(&fs::symlink_metadata(&self.path).map_err(|error| error.to_string())?);
        if descriptor != self.identity || path != self.identity {
            return Err("Cached publication artifact identity or metadata changed".into());
        }
        Ok(())
    }
    fn bytes(&self) -> Result<Vec<u8>, String> {
        let mut file = self.file.try_clone().map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(self.identity.len as usize);
        file.take(self.identity.len + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 != self.identity.len {
            return Err("Cached publication artifact length changed".into());
        }
        Ok(bytes)
    }
}

fn enforce_artifact_policy(metadata: &fs::Metadata, directory: bool) -> Result<(), String> {
    let expected = if directory { 0o750 } else { 0o640 };
    if metadata.uid() != 0 || metadata.mode() & 0o7777 != expected {
        return Err(
            "Cached mode requires root-owned 0750 directories and root-owned 0640 ordinary files"
                .into(),
        );
    }
    Ok(())
}

fn enforce_process_policy() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let uid = unsafe { libc::geteuid() };
        if uid == 0
            || unsafe { libc::getuid() } != uid
            || unsafe { libc::getgid() } != unsafe { libc::getegid() }
        {
            return Err("Cached evaluator requires an unprivileged non-root query identity".into());
        }
        let status = fs::read_to_string("/proc/self/status").map_err(|error| error.to_string())?;
        let ids = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .ok_or("Cached mode cannot validate query identities")?;
        if ids
            .split_whitespace()
            .any(|value| value.parse::<u32>().ok() != Some(uid))
        {
            return Err("Cached evaluator rejects saved or filesystem root privileges".into());
        }
        for key in ["CapEff:", "CapPrm:", "CapAmb:"] {
            let value = status
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .ok_or("Cached mode cannot validate process capabilities")?;
            if u64::from_str_radix(value.trim(), 16)
                .map_err(|_| "Invalid process capability status")?
                != 0
            {
                return Err("Cached evaluator rejects privileged process capabilities".into());
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("Cached evaluator security admission currently requires Linux".into())
    }
}

fn enforce_ancestors(root: &Path) -> Result<(), String> {
    for ancestor in root.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err("Cached publication ancestors must be root-owned directories without group or other writes".into());
        }
    }
    Ok(())
}

struct CachedLayer {
    database: Mmap,
    blocks: Vec<NativePreprocessed>,
    public: Vec<u8>,
}
struct CachedEvaluator {
    manifest: Value,
    profile: TableProfile,
    layers: Vec<CachedLayer>,
    guards: Vec<FileGuard>,
    admission: Value,
}
impl CachedEvaluator {
    fn load(root: &Path, limit: Option<usize>) -> Result<Self, String> {
        enforce_process_policy()?;
        ordinary_directory(root)?;
        let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
        enforce_ancestors(&root)?;
        Self::load_inner(&root, limit)
    }

    fn load_inner(root: &Path, limit: Option<usize>) -> Result<Self, String> {
        // Production cache construction has no permissive admission branch.
        let enforce = true;
        let process_before = process_snapshot();
        let start = Instant::now();
        let mut stages = Stages::new();
        let mut guards = Vec::new();
        guards.push(FileGuard::open(root, true, 0, 0, enforce)?);
        guards.push(FileGuard::open(&root.join("layers"), true, 0, 0, enforce)?);
        guards.push(FileGuard::open(
            &root.join("manifest.json"),
            false,
            2,
            MAX_MANIFEST_BYTES,
            enforce,
        )?);
        let manifest: Value = serde_json::from_slice(&guards.last().unwrap().bytes()?)
            .map_err(|error| error.to_string())?;
        let profile = data::validate_manifest(&manifest)?;
        guards.push(FileGuard::open(
            &root.join("anchors.json"),
            false,
            2,
            MAX_ANCHOR_BYTES,
            enforce,
        )?);
        read_anchors(root, &manifest["sourceSummary"])?;
        let total = manifest["layers"].as_array().unwrap().len();
        let limit = limit.unwrap_or(total);
        if limit == 0 || limit > total {
            return Err("Invalid cached layer prefix".into());
        }
        let mut layers = Vec::with_capacity(limit);
        let mut layer_reports = Vec::new();
        for (index, layer) in manifest["layers"]
            .as_array()
            .unwrap()
            .iter()
            .take(limit)
            .enumerate()
        {
            let path = root.join("layers").join(format!("{index:03}"));
            let mut times = Stages::new();
            guards.push(FileGuard::open(&path, true, 0, 0, enforce)?);
            let size = profile.database_bytes();
            let database_guard = timed(&mut times, "databaseOpenNs", || {
                FileGuard::open(&path.join("database.bin"), false, size, size, enforce)
            })?;
            let database = timed(&mut times, "databaseMmapNs", || unsafe {
                MmapOptions::new().map(&database_guard.file)
            })
            .map_err(|error| error.to_string())?;
            let hash = timed(&mut times, "databaseHashNs", || {
                hex::encode(Sha256::digest(&database))
            });
            if layer["databaseSha256"] != hash {
                return Err("Cached database checksum mismatch".into());
            }
            guards.push(database_guard);
            let public_guard = timed(&mut times, "publicOpenNs", || {
                FileGuard::open(
                    &path.join("public.bin"),
                    false,
                    profile.scheme.public_bytes as u64,
                    profile.scheme.public_bytes as u64,
                    enforce,
                )
            })?;
            let public = timed(&mut times, "publicReadNs", || public_guard.bytes())?;
            let hash = timed(&mut times, "publicHashNs", || {
                hex::encode(Sha256::digest(&public))
            });
            if layer["publicSha256"] != hash {
                return Err("Cached public setup checksum mismatch".into());
            }
            guards.push(public_guard);
            let mut blocks = Vec::with_capacity(profile.blocks());
            for (part, prepared) in layer["preparedFiles"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                let bytes = prepared["bytes"]
                    .as_u64()
                    .ok_or("Missing cached prepared size")?;
                let count = prepared["count"]
                    .as_u64()
                    .ok_or("Missing cached prepared count")? as usize;
                let guard = timed(&mut times, "preparedOpenNs", || {
                    FileGuard::open(
                        &path.join(format!("prepared-{part:02}.bin")),
                        false,
                        bytes,
                        bytes,
                        enforce,
                    )
                })?;
                let mapping = timed(&mut times, "preparedMmapNs", || unsafe {
                    MmapOptions::new().map(&guard.file)
                })
                .map_err(|error| error.to_string())?;
                let hash = timed(&mut times, "preparedHashNs", || {
                    hex::encode(Sha256::digest(&mapping))
                });
                if &mapping[..8] != b"RNMAP002" || prepared["sha256"] != hash {
                    return Err("Cached prepared checksum or mode mismatch".into());
                }
                blocks.extend(
                    timed(
                        &mut times,
                        "preparedParseAndCoefficientValidationNs",
                        || prepared_native::read(mapping, 0, &profile.setup, count),
                    )
                    .map_err(|error| error.to_string())?,
                );
                guards.push(guard);
            }
            let published = timed(&mut times, "publicPublishCompareNs", || {
                profile.native.publish(&blocks)
            })?;
            if blocks.len() != profile.blocks() || published != public {
                return Err("Cached setup identity mismatch".into());
            }
            layers.push(CachedLayer {
                database,
                blocks,
                public,
            });
            for (key, value) in &times {
                *stages.entry(key.clone()).or_default() += value;
            }
            layer_reports.push(json!({"index":index,"stagesNs":times}));
        }
        for guard in &guards {
            guard.check()?;
        }
        let admission = json!({"wallNs":start.elapsed().as_nanos(),"stagesNs":stages,"layers":layer_reports,
            "processBefore":process_before,"processAfter":process_snapshot(),"trustedRootImmutablePublisherRequired":true,
            "residentMemoryGuarantee":"Mappings retain virtual addresses, not a promise that all artifact pages fit RAM. Kernel/cgroup residency limits remain authoritative."});
        Ok(Self {
            manifest,
            profile,
            layers,
            guards,
            admission,
        })
    }

    fn check(&self) -> Result<(), String> {
        for guard in &self.guards {
            guard.check()?;
        }
        Ok(())
    }

    fn evaluate_profile(&mut self, upload: &[u8]) -> Result<Evaluation, String> {
        let mut stages = Stages::new();
        timed(&mut stages, "cachedIdentityBeforeNs", || self.check())?;
        let (keys, query) = timed(&mut stages, "queryParseNs", || self.profile.parse(upload))?;
        let mut response =
            Vec::with_capacity(self.layers.len() * self.profile.scheme.response_bytes);
        let mut expected = Vec::new();
        let mut public = Vec::new();
        let mut layer_reports = Vec::new();
        for (index, layer) in self.layers.iter().enumerate() {
            let mut times = Stages::new();
            let intermediate = timed(&mut times, "matvecNs", || {
                matvec::multiply(&layer.database, self.profile.row_bytes, &query)
            });
            let body = pack_timed(
                &self.profile,
                &layer.blocks,
                &keys,
                &intermediate,
                &mut times,
            )?;
            response.extend(body);
            expected.push(
                layer.database[BENCHMARK_ROW * self.profile.row_bytes
                    ..(BENCHMARK_ROW + 1) * self.profile.row_bytes]
                    .to_vec(),
            );
            public.push(layer.public.clone());
            for (key, value) in &times {
                *stages.entry(key.clone()).or_default() += value;
            }
            layer_reports.push(json!({"index":index,"stagesNs":times}));
        }
        timed(&mut stages, "cachedIdentityAfterNs", || self.check())?;
        Ok(Evaluation {
            response,
            expected,
            public,
            stages,
            layers: layer_reports,
        })
    }

    fn answer(&self, upload: &[u8]) -> Result<Vec<u8>, String> {
        self.check()?;
        if upload.len() != self.profile.scheme.request_bytes {
            return Err(INVALID_QUERY.into());
        }
        let (keys, query) = self.profile.parse(upload)?;
        let mut response =
            Vec::with_capacity(self.layers.len() * self.profile.scheme.response_bytes);
        for layer in &self.layers {
            let intermediate = matvec::multiply(&layer.database, self.profile.row_bytes, &query);
            let body = self
                .profile
                .native
                .pack(&layer.blocks, &keys, &intermediate)?;
            if body.len() != self.profile.scheme.response_bytes {
                return Err("Cached response length mismatch".into());
            }
            response.extend(body);
        }
        self.check()?;
        Ok(response)
    }
}

pub(super) fn serve_global_cached(root: &Path) -> Result<(), String> {
    let evaluator = CachedEvaluator::load(root, None)?;
    eprintln!(
        "Experimental global evaluator ready; all {} layers evaluated per query (cached immutable epoch; trusted root publisher)",
        evaluator.layers.len()
    );
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    while let Some(line) =
        bounded_line(&mut input, MAX_REQUEST_LINE).map_err(|error| error.to_string())?
    {
        // A metadata change invalidates the admitted epoch permanently: exit
        // before operating on mappings and return no successful answer.
        evaluator.check()?;
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
        evaluator.check()?;
        serde_json::to_writer(&mut output, &reply).map_err(|error| error.to_string())?;
        writeln!(&mut output)
            .and_then(|_| output.flush())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> Staging {
        let root = std::env::temp_dir().join(format!(
            "global-profile-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        private_directory(&root).unwrap();
        Staging(root)
    }

    #[test]
    fn descriptor_guards_reject_path_replacement_symlinks_and_metadata_changes() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = scratch("identity");
        let path = root.0.join("file");
        write_new(&path, b"original").unwrap();
        let guard = FileGuard::open(&path, false, 8, 8, false).unwrap();
        guard.check().unwrap();
        fs::rename(&path, root.0.join("old")).unwrap();
        write_new(&path, b"original").unwrap();
        assert!(guard.check().is_err());
        let guard = FileGuard::open(&path, false, 8, 8, false).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(guard.check().is_err());
        symlink(&path, root.0.join("link")).unwrap();
        assert!(FileGuard::open(&root.0.join("link"), false, 8, 8, false).is_err());
        assert!(enforce_artifact_policy(&fs::metadata(&root.0).unwrap(), true).is_err());
    }

    #[test]
    fn production_cached_cli_has_no_privileged_or_non_linux_fallback() {
        #[cfg(not(target_os = "linux"))]
        assert!(enforce_process_policy().is_err());
        #[cfg(target_os = "linux")]
        if unsafe { libc::geteuid() } == 0 {
            assert!(enforce_process_policy().is_err());
        }
        let root = scratch("ownership");
        write_new(&root.0.join("file"), b"x").unwrap();
        assert!(FileGuard::open(&root.0.join("file"), false, 1, 1, true).is_err());
    }

    fn small_profile() -> TableProfile {
        let production = data::profile().unwrap();
        let mut profile =
            TableProfile::new(data::SCHEMA, data::GEOMETRY, data::TABLE, 2048, 2048).unwrap();
        profile.masks.clone_from(&production.masks);
        profile
    }

    #[test]
    fn cached_and_profiled_native_paths_match_baseline_with_full_row_authentication() {
        // TEST ONLY shortened replies keep temporary matrices at 64 MiB.
        // Production CLI admission still derives and enforces 64 KiB rows.
        let root = scratch("crypto");
        private_directory(&root.0.join("layers")).unwrap();
        let profile = small_profile();
        let context = "24".repeat(32);
        let mut buckets = vec![Vec::new(); data::ROWS];
        buckets[0] = b"public benchmark payload".to_vec();
        let mut layers = Vec::new();
        for index in 0..2 {
            let (full, merkle) = data::build_layer(&context, index, 2, &buckets).unwrap();
            assert!(
                full.chunks_exact(data::ROW_BYTES)
                    .all(|row| row[profile.row_bytes..].iter().all(|&byte| byte == 0))
            );
            let narrow = full
                .chunks_exact(data::ROW_BYTES)
                .flat_map(|row| row[..profile.row_bytes].iter().copied())
                .collect::<Vec<_>>();
            drop(full);
            layers.push(
                prepare_layer(
                    &root.0.join("layers").join(format!("{index:03}")),
                    &profile,
                    &narrow,
                    index,
                    merkle,
                )
                .unwrap(),
            );
        }
        let manifest = json!({"contextId":context,"layers":layers,"layerCount":2});
        let baseline_evaluator = GlobalEvaluator {
            root: root.0.clone(),
            manifest: manifest.clone(),
            profile: small_profile(),
        };
        let mut cached_layers = Vec::new();
        let mut guards = Vec::new();
        // Only this private unit-test harness bypasses ownership so it can run
        // without a root install. It exercises the same actual mapped blocks.
        guards.push(FileGuard::open(&root.0, true, 0, 0, false).unwrap());
        guards.push(FileGuard::open(&root.0.join("layers"), true, 0, 0, false).unwrap());
        for (index, layer) in manifest["layers"].as_array().unwrap().iter().enumerate() {
            let path = root.0.join("layers").join(format!("{index:03}"));
            guards.push(FileGuard::open(&path, true, 0, 0, false).unwrap());
            let database_guard = FileGuard::open(
                &path.join("database.bin"),
                false,
                profile.database_bytes(),
                profile.database_bytes(),
                false,
            )
            .unwrap();
            let database = unsafe { MmapOptions::new().map(&database_guard.file) }.unwrap();
            guards.push(database_guard);
            let public = fs::read(path.join("public.bin")).unwrap();
            guards.push(
                FileGuard::open(
                    &path.join("public.bin"),
                    false,
                    public.len() as u64,
                    public.len() as u64,
                    false,
                )
                .unwrap(),
            );
            let prepared = &layer["preparedFiles"][0];
            let blocks = read_mapping(&path.join("prepared-00.bin"), &profile, prepared).unwrap();
            guards.push(
                FileGuard::open(
                    &path.join("prepared-00.bin"),
                    false,
                    prepared["bytes"].as_u64().unwrap(),
                    prepared["bytes"].as_u64().unwrap(),
                    false,
                )
                .unwrap(),
            );
            cached_layers.push(CachedLayer {
                database,
                blocks,
                public,
            });
        }
        let mut cached = CachedEvaluator {
            manifest: manifest.clone(),
            profile: small_profile(),
            layers: cached_layers,
            guards,
            admission: Value::Null,
        };
        for selected in [0, 1023, 2047] {
            let (secret, upload) = profile.prepare(selected).unwrap();
            let original = baseline_evaluator.answer(&upload).unwrap();
            assert_eq!(cached.answer(&upload).unwrap(), original);
            let profiled_baseline = baseline(&root.0, &profile, &manifest, &upload, 2).unwrap();
            assert_eq!(profiled_baseline.response, original);
            let profiled_cached = cached.evaluate_profile(&upload).unwrap();
            assert_eq!(profiled_cached.response, original);
            assert!(
                profiled_baseline
                    .stages
                    .contains_key("preparedParseAndCoefficientValidationNs")
            );
            assert!(!profiled_cached.stages.contains_key("preparedHashNs"));
            for (index, response) in original
                .chunks_exact(profile.scheme.response_bytes)
                .enumerate()
            {
                let mut row = profile
                    .decode(&secret, &cached.layers[index].public, response)
                    .unwrap();
                assert_eq!(
                    row,
                    cached.layers[index].database
                        [selected * profile.row_bytes..(selected + 1) * profile.row_bytes]
                );
                row.resize(data::ROW_BYTES, 0);
                data::verify_row(
                    &row,
                    &context,
                    index,
                    2,
                    selected,
                    manifest["layers"][index]["merkleRoot"].as_str().unwrap(),
                )
                .unwrap();
            }
        }
        // Replacing even a byte-identical public file invalidates the admitted
        // descriptor/path pairing before any subsequent matrix work.
        let path = root.0.join("layers/000/public.bin");
        let bytes = fs::read(&path).unwrap();
        fs::rename(&path, root.0.join("saved-public.bin")).unwrap();
        write_new(&path, &bytes).unwrap();
        let (_, upload) = profile.prepare(0).unwrap();
        assert!(cached.answer(&upload).is_err());
    }
}
