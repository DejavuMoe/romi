//! Local Agent distribution validation and serving.
//!
//! The Hub never downloads an Agent. It reads one root-controlled local
//! directory laid down by the verified Hub installer, validates the exact
//! binary against local metadata, keeps the bytes in memory, and serves only
//! the versioned URL. No request handler touches the filesystem or GitHub.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use axum::body::Bytes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The only Agent target this release supports.
#[cfg(test)]
pub const TARGET: &str = env!("ROMI_BUILD_TARGET");
#[cfg(test)]
pub const ARCHITECTURE: &str = std::env::consts::ARCH;
pub const TARGETS: [&str; 4] = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
];
const MAX_AGENT_BYTES: u64 = 16 * 1024 * 1024;
/// The Agent installer is compiled into the Hub from the reviewed source tree.
/// Serving it from a file path would let an operator substitute arbitrary code
/// without a new Hub binary; embedding keeps the script tied to this version.
pub const INSTALL_SCRIPT: &str = include_str!("../../deploy/agent/install.sh");

#[derive(Clone, Debug)]
pub struct Distribution {
    pub version: String,
    pub target: String,
    pub architecture: String,
    pub sha256: String,
    pub size: u64,
    pub download_path: String,
    binary: Bytes,
    variants: Vec<Distribution>,
}

impl Distribution {
    /// Load and fully validate one local distribution directory.
    ///
    /// `distribution.json` fixes the identity; the file system entry must not
    /// be a symlink, the bytes must match size and SHA-256, and the header must
    /// be a 64-bit little-endian x86-64 ELF. All of that happens once at
    /// startup, so a later file replacement cannot change what is served.
    pub fn load(directory: &Path, expected_version: &str) -> Result<Self> {
        let mut distribution = Self::load_one(directory, expected_version)?;
        for target in TARGETS {
            if target == distribution.target {
                continue;
            }
            let path = directory.join(target);
            if path.exists() {
                let variant = Self::load_one(&path, expected_version)?;
                if variant.target != target {
                    bail!("distribution directory {target} contains {}", variant.target);
                }
                distribution.variants.push(variant);
            }
        }
        Ok(distribution)
    }

    fn load_one(directory: &Path, expected_version: &str) -> Result<Self> {
        let directory = directory
            .canonicalize()
            .with_context(|| format!("distribution directory {} is not readable", directory.display()))?;
        let metadata_path = directory.join("distribution.json");
        reject_symlink(&metadata_path)?;
        if fs::metadata(&metadata_path)?.len() > 64 * 1024 {
            bail!("distribution metadata is too large");
        }
        let text = fs::read_to_string(&metadata_path)
            .with_context(|| format!("cannot read {}", metadata_path.display()))?;
        let metadata: Value = serde_json::from_str(&text)
            .with_context(|| format!("{} is not valid JSON", metadata_path.display()))?;
        let field = |name: &str| -> Result<String> {
            metadata
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .with_context(|| format!("{} is missing string field {name:?}", metadata_path.display()))
        };

        if metadata.get("format").and_then(Value::as_u64) != Some(1) {
            bail!("{}: unsupported distribution format", metadata_path.display());
        }
        if field("project")? != "romi" || field("kind")? != "agent-distribution" {
            bail!("{}: not a romi agent distribution", metadata_path.display());
        }
        let version = field("version")?;
        if version != expected_version {
            bail!(
                "{}: distribution version {version} does not match running romi {expected_version}",
                metadata_path.display()
            );
        }
        let target = field("target")?;
        if !TARGETS.contains(&target.as_str()) {
            bail!("{}: unsupported target {target}", metadata_path.display());
        }
        let architecture = field("architecture")?;
        if architecture != target.split('-').next().unwrap_or("") {
            bail!("{}: unsupported architecture {architecture}", metadata_path.display());
        }
        let filename = field("filename")?;
        if filename != "romi-agent" {
            bail!("{}: expected filename romi-agent, got {filename:?}", metadata_path.display());
        }
        let sha256 = field("sha256")?;
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("{}: sha256 must be 64 hexadecimal characters", metadata_path.display());
        }
        let size = metadata
            .get("size")
            .and_then(Value::as_u64)
            .with_context(|| format!("{} is missing integer field size", metadata_path.display()))?;
        if size == 0 || size > MAX_AGENT_BYTES {
            bail!("{}: size must be between 1 and {MAX_AGENT_BYTES}", metadata_path.display());
        }

        let binary_path: PathBuf = directory.join(&filename);
        reject_symlink(&binary_path)?;
        let binary_path = binary_path
            .canonicalize()
            .with_context(|| format!("cannot resolve {}", directory.join(&filename).display()))?;
        if !binary_path.starts_with(&directory) {
            bail!("{}: binary escapes the distribution directory", binary_path.display());
        }
        if fs::metadata(&binary_path)?.len() != size {
            bail!("Agent size does not match metadata");
        }
        let bytes =
            fs::read(&binary_path).with_context(|| format!("cannot read {}", binary_path.display()))?;
        if bytes.len() as u64 != size {
            bail!("{}: binary is {} bytes, metadata says {size}", binary_path.display(), bytes.len());
        }
        let actual = hex::encode(Sha256::digest(&bytes));
        if actual != sha256.to_ascii_lowercase() {
            bail!("{}: binary SHA-256 does not match distribution metadata", binary_path.display());
        }
        if !is_elf(&bytes, &architecture) {
            bail!("{}: binary ELF architecture does not match {architecture}", binary_path.display());
        }

        let download_path = format!("/agent/v{}/{}", version, target);
        Ok(Self {
            version,
            target,
            architecture,
            sha256,
            size,
            download_path,
            binary: Bytes::from(bytes),
            variants: vec![],
        })
    }

    pub fn select(&self, target: &str) -> Option<&Self> {
        if target == self.target {
            Some(self)
        } else {
            self.variants.iter().find(|v| v.target == target)
        }
    }

    /// Public metadata only: no filesystem path, no secret, no build log.
    pub fn metadata(&self) -> Value {
        json!({
            "format": 1,
            "project": "romi",
            "kind": "agent-distribution",
            "version": self.version,
            "target": self.target,
            "architecture": self.architecture,
            "filename": "romi-agent",
            "sha256": self.sha256,
            "size": self.size,
            "download": self.download_path,
        })
    }

    pub fn binary(&self) -> Bytes {
        self.binary.clone()
    }
}

#[cfg(test)]
impl Distribution {
    /// In-memory fixture for route tests; full load validation is covered by
    /// the distribution tests above.
    pub(crate) fn test_fixture(version: &str, bytes: &[u8]) -> Self {
        Self {
            version: version.to_owned(),
            target: TARGET.to_owned(),
            architecture: ARCHITECTURE.to_owned(),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            download_path: format!("/agent/v{version}/{TARGET}"),
            binary: Bytes::copy_from_slice(bytes),
            variants: vec![],
        }
    }
}

fn reject_symlink(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).with_context(|| format!("cannot stat {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("{} must not be a symlink", path.display());
    }
    if !metadata.is_file() {
        bail!("{} must be a regular file", path.display());
    }
    Ok(())
}

/// ELF64 little-endian `e_machine == EM_X86_64`.
fn is_elf(data: &[u8], architecture: &str) -> bool {
    data.len() >= 20
        && &data[..4] == b"\x7fELF"
        && data[4] == 2
        && data[5] == 1
        && data[18] == if architecture == "aarch64" { 0xb7 } else { 0x3e }
        && data[19] == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(directory: &Path, version: &str, binary: &[u8], overrides: &[(&str, Value)]) {
        fs::create_dir_all(directory).unwrap();
        let mut metadata = serde_json::Map::new();
        metadata.insert("format".into(), json!(1));
        metadata.insert("project".into(), json!("romi"));
        metadata.insert("kind".into(), json!("agent-distribution"));
        metadata.insert("version".into(), json!(version));
        metadata.insert("target".into(), json!(TARGET));
        metadata.insert("architecture".into(), json!(ARCHITECTURE));
        metadata.insert("filename".into(), json!("romi-agent"));
        metadata.insert("sha256".into(), json!(hex::encode(Sha256::digest(binary))));
        metadata.insert("size".into(), json!(binary.len()));
        for (key, value) in overrides {
            metadata.insert((*key).into(), value.clone());
        }
        fs::write(directory.join("distribution.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
        fs::write(directory.join("romi-agent"), binary).unwrap();
    }

    fn elf() -> Vec<u8> {
        let mut data = vec![0u8; 64];
        data[..4].copy_from_slice(b"\x7fELF");
        data[4] = 2;
        data[5] = 1;
        data[18] = if ARCHITECTURE == "aarch64" { 0xb7 } else { 0x3e };
        data[19] = 0;
        data
    }

    #[test]
    fn a_matching_local_distribution_loads_and_exposes_no_path() {
        let base = std::env::temp_dir().join(format!("romi-dist-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let bytes = elf();
        fixture(&base, "0.1.0", &bytes, &[]);
        let distribution = Distribution::load(&base, "0.1.0").unwrap();
        assert_eq!(distribution.download_path, format!("/agent/v0.1.0/{TARGET}"));
        let metadata = distribution.metadata();
        assert!(metadata.get("path").is_none());
        assert_eq!(metadata["sha256"], hex::encode(Sha256::digest(&bytes)));
        assert_eq!(distribution.binary().as_ref(), bytes.as_slice());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn one_hub_serves_each_architecture_and_libc_by_exact_target() {
        let base = std::env::temp_dir().join(format!("romi-dist-matrix-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fixture(&base, "0.0.1", &elf(), &[]);
        for target in TARGETS {
            if target == TARGET {
                continue;
            }
            let arch = target.split('-').next().unwrap();
            let mut bytes = elf();
            bytes[18] = if arch == "aarch64" { 0xb7 } else { 0x3e };
            fixture(
                &base.join(target),
                "0.0.1",
                &bytes,
                &[("target", json!(target)), ("architecture", json!(arch))],
            );
        }
        let loaded = Distribution::load(&base, "0.0.1").unwrap();
        for target in TARGETS {
            let selected = loaded.select(target).unwrap();
            assert_eq!(selected.target, target);
            assert_eq!(selected.download_path, format!("/agent/v0.0.1/{target}"));
            assert!(is_elf(&selected.binary(), &selected.architecture));
        }
        assert!(loaded.select("../../etc/passwd").is_none());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn version_target_architecture_and_filename_are_enforced() {
        let base = std::env::temp_dir().join(format!("romi-dist-reject-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let bytes = elf();
        for override_ in [
            ("version", json!("9.9.9")),
            ("target", json!("riscv64-unknown-linux-gnu")),
            ("architecture", json!("unsupported")),
            ("filename", json!("../evil")),
        ] {
            fixture(&base, "0.1.0", &bytes, std::slice::from_ref(&override_));
            assert!(Distribution::load(&base, "0.1.0").is_err(), "{override_:?}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn wrong_size_hash_and_non_elf_are_rejected() {
        let base = std::env::temp_dir().join(format!("romi-dist-mismatch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let bytes = elf();
        fixture(&base, "0.1.0", &bytes, &[("size", json!(1))]);
        assert!(Distribution::load(&base, "0.1.0").is_err());
        fixture(&base, "0.1.0", &bytes, &[("sha256", json!("0".repeat(64)))]);
        assert!(Distribution::load(&base, "0.1.0").is_err());
        let mut not_elf = bytes.clone();
        not_elf[18] = 0xb7;
        fixture(&base, "0.1.0", &not_elf, &[]);
        assert!(Distribution::load(&base, "0.1.0").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_symlinked_binary_is_rejected() {
        let base = std::env::temp_dir().join(format!("romi-dist-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let bytes = elf();
        fixture(&base, "0.1.0", &bytes, &[]);
        fs::remove_file(base.join("romi-agent")).unwrap();
        let outside = base.with_extension("outside");
        let mut file = fs::File::create(&outside).unwrap();
        file.write_all(&bytes).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("romi-agent")).unwrap();
        assert!(Distribution::load(&base, "0.1.0").is_err());
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&base);
    }
}
