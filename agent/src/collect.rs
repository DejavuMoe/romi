//! Linux-only metric collection, read directly from /proc and statvfs.
//! sysinfo is not used: it misreports memory and disk for this purpose.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use serde::Serialize;

static HOST_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Docker uses a read-only host root and host network/PID/UTS namespaces.
/// Native installations leave ROMI_HOST_ROOT unset and read the ordinary paths.
pub fn init_host_root() -> anyhow::Result<()> {
    let Some(root) = std::env::var_os("ROMI_HOST_ROOT") else { return Ok(()) };
    let root = PathBuf::from(root);
    anyhow::ensure!(root.is_absolute(), "ROMI_HOST_ROOT must be an absolute directory");
    let root = root.canonicalize()?;
    for required in ["proc/stat", "proc/meminfo", "proc/net/dev", "proc/1/mounts"] {
        fs::read_to_string(root.join(required)).map_err(|e| {
            anyhow::anyhow!("cannot read host {required}: {e}; check the read-only host mount")
        })?;
    }
    HOST_ROOT.set(root).map_err(|_| anyhow::anyhow!("host root already initialized"))
}

fn rooted(root: &Path, path: &Path) -> PathBuf {
    root.join(path.strip_prefix("/").unwrap_or(path))
}

fn host_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    HOST_ROOT.get().map_or_else(|| path.to_owned(), |root| rooted(root, path))
}

pub fn mount_table() -> String {
    let path = if HOST_ROOT.get().is_some() { "/proc/1/mounts" } else { "/proc/self/mounts" };
    fs::read_to_string(host_path(path)).unwrap_or_default()
}

/// Interfaces that carry neither this machine's traffic nor its identity:
/// loopback, container and VM networks, and tunnels whose bytes reach the wire
/// a second time inside their carrier.
///
/// Names remain as the conservative fallback for devices whose role cannot be
/// inferred safely. counted_elsewhere additionally consults sysfs so renamed
/// bridges, bonds, tunnels and bridge ports are still excluded from the default
/// sum. An explicit --iface overrides these defaults.
const SKIP_IFACES: &[&str] = &[
    "lo",
    "docker",
    "veth",
    "br-",
    "virbr",
    "tap",
    "tun",
    "wg",
    "tailscale",
    "cni",
    "flannel",
    "podman",
    "fwbr",
    "fwpr",
    "fwln",
    "ifb",
    "gretap",
    "erspan",
    "kube",
    "cali",
    "nerdctl",
    "lxc",
    "cilium",
    "zt",
];
/// Pseudo/virtual filesystems that must not count toward disk totals.
const SKIP_FSTYPES: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "devpts",
    "mqueue",
    "hugetlbfs",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "bpf",
    "configfs",
    "fusectl",
    "binfmt_misc",
    "autofs",
    "squashfs",
    "ramfs",
    "efivarfs",
    "nsfs",
    "overlay",
    "ecryptfs",
    "fuse",
    "rpc_pipefs",
    // Remote storage. `//server/share` passes the device check that excludes
    // `server:/export`, so only the type list keeps a NAS out of this machine's
    // capacity. Each spelling needs its own entry: the flavour rule below
    // matches on a dot, so "nfs" does not cover "nfs4".
    "nfs",
    "nfs4",
    "cifs",
    "smb3",
    "ceph",
    "glusterfs",
    "9p",
];

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Facts {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub virt: String,
    pub cpu_name: String,
    pub cpu_cores: u32,
    pub mem_total: u64,
    pub swap_total: u64,
    pub disk_total: u64,
    pub agent_version: String,
    /// The host's own addresses. The hub sees only the family the agent
    /// connected over, which on a dual-stack host is usually v6.
    pub ipv4: String,
    pub ipv6: String,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Metrics {
    /// Names the span over which the kernel byte counters are comparable.
    /// It is the kernel boot id plus a stable digest of the interfaces summed;
    /// a reboot or a changed interface set therefore makes the Hub re-baseline
    /// instead of booking unrelated lifetime counters as new traffic.
    pub boot_id: String,
    pub uptime: u64,
    pub cpu: f32,
    pub load: [f32; 3],
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub zram_used: Option<u64>,
    pub zram_total: Option<u64>,
    pub zram_devices: Option<u64>,
    pub swap_disk_used: Option<u64>,
    pub swap_disk_total: Option<u64>,
    pub swapfile_used: Option<u64>,
    pub swap_partition_used: Option<u64>,

    pub disk_total: u64,
    pub disk_used: u64,
    /// Kernel lifetime byte counters. The hub accumulates these; the agent
    /// stores nothing and does not attempt to survive a reboot.
    pub net_rx_total: u64,
    pub net_tx_total: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub tcp: u32,
    pub udp: u32,
    pub procs: u32,
}

#[derive(Default)]
pub struct Ifaces {
    only: Vec<String>,
    skip: Vec<String>,
}

impl Ifaces {
    pub fn parse(spec: &str) -> Result<Self, String> {
        if spec.trim().is_empty() {
            return Ok(Self::default());
        }
        let entries: Vec<&str> = spec.split(',').map(str::trim).collect();
        let mut ifaces = Self::default();
        for entry in entries {
            let (list, name) = match entry.strip_prefix('-') {
                Some(name) => (&mut ifaces.skip, name),
                None => (&mut ifaces.only, entry),
            };
            if entry.is_empty()
                || name.is_empty()
                || name.starts_with('-')
                || name.contains(char::is_whitespace)
            {
                return Err(format!(
                    "--iface: {entry:?} is not an interface name; give full names separated by commas"
                ));
            }
            list.push(name.to_owned());
        }
        Ok(ifaces)
    }

    fn counts(&self, sys: &Path, name: &str) -> bool {
        if self.skip.iter().any(|n| n == name) {
            return false;
        }
        if !self.only.is_empty() {
            return self.only.iter().any(|n| n == name);
        }
        !skip_iface(name) && !is_stacked(name) && !counted_elsewhere(sys, name)
    }
}

/// A stable epoch for the exact set of interfaces contributing lifetime
/// counters. Interface ordering in /proc/net/dev is irrelevant.
fn epoch<'a>(boot_id: &str, names: impl Iterator<Item = &'a str>) -> String {
    let mut names: Vec<&str> = names.collect();
    names.sort_unstable();
    let digest = names
        .join("\n")
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{boot_id}/{digest:016x}")
}

#[derive(Default)]
pub struct Collector {
    ifaces: Ifaces,
    prev_cpu: Option<(u64, u64)>,
    prev_net_at: Option<Instant>,
    prev_net: HashMap<String, (u64, u64)>,
}

impl Collector {
    pub fn new(ifaces: Ifaces) -> Self {
        Self { ifaces, ..Self::default() }
    }

    pub fn counted_ifaces(&self) -> Vec<String> {
        let dev = fs::read_to_string(host_path("/proc/net/dev")).unwrap_or_default();
        self.counted(&dev).into_iter().map(|(name, ..)| name.to_owned()).collect()
    }

    fn counted<'a>(&self, dev: &'a str) -> Vec<(&'a str, u64, u64)> {
        net_dev(dev).filter(|(name, ..)| self.ifaces.counts(&host_path(SYS_NET), name)).collect()
    }

    pub fn facts(&self) -> Facts {
        let (v4, v6) = addresses();
        let mem = meminfo();
        let (cpu_name, cpu_cores) = cpuinfo();
        let (disk_total, _) = disk_usage(&real_mount_points());
        Facts {
            hostname: read_trim("/proc/sys/kernel/hostname").unwrap_or_else(|| "unknown".into()),
            os: os_pretty_name(),
            kernel: read_trim("/proc/sys/kernel/osrelease").unwrap_or_else(|| "unknown".into()),
            arch: std::env::consts::ARCH.into(),
            virt: virtualization(),
            cpu_name,
            cpu_cores,
            mem_total: mem.get("MemTotal").copied().unwrap_or(0),
            swap_total: mem.get("SwapTotal").copied().unwrap_or(0),
            disk_total,
            agent_version: env!("CARGO_PKG_VERSION").into(),
            ipv4: v4,
            ipv6: v6,
        }
    }

    pub fn collect(&mut self) -> Metrics {
        self.collect_selected(true, true, true)
    }

    fn collect_selected(&mut self, disks: bool, sockets: bool, processes: bool) -> Metrics {
        let mem = meminfo();
        let (mem_total, mem_used) = mem_used(&mem);
        let (swap_total, swap_used) = swap_used(&mem);
        let swap = swap_sources(&host_path("/"));
        let (disk_total, disk_used) = if disks { disk_usage(&real_mount_points()) } else { (0, 0) };
        let dev = fs::read_to_string(host_path("/proc/net/dev")).unwrap_or_default();
        let counted = self.counted(&dev);
        let (rx_total, tx_total) = totals(&counted);
        let boot_id = epoch(
            &read_trim("/proc/sys/kernel/random/boot_id").unwrap_or_default(),
            counted.iter().map(|(name, ..)| *name),
        );
        let (rx, tx) = self.net_rate(&counted, Instant::now());
        let (tcp, udp) = if sockets { conn_counts() } else { (0, 0) };

        Metrics {
            boot_id,
            uptime: uptime(),
            cpu: self.cpu_percent(),
            load: loadavg(),
            mem_total,
            mem_used,
            swap_total,
            swap_used,
            zram_used: swap.as_ref().map(|s| s.zram_used),
            zram_total: swap.as_ref().map(|s| s.zram_total),
            zram_devices: swap.as_ref().map(|s| s.zram_devices),
            swap_disk_used: swap.as_ref().map(|s| s.swap_disk_used),
            swap_disk_total: swap.as_ref().map(|s| s.swap_disk_total),
            swapfile_used: swap.as_ref().map(|s| s.swapfile_used),
            swap_partition_used: swap.as_ref().map(|s| s.swap_partition_used),

            disk_total,
            disk_used,
            net_rx_total: rx_total,
            net_tx_total: tx_total,
            net_rx: rx,
            net_tx: tx,
            tcp,
            udp,
            procs: if processes { proc_count() } else { 0 },
        }
    }

    fn cpu_percent(&mut self) -> f32 {
        let Some(now) = cpu_jiffies() else {
            return 0.0;
        };
        let pct = self.prev_cpu.map_or(0.0, |prev| busy_percent(prev, now));
        self.prev_cpu = Some(now);
        pct
    }

    /// Calculate rate per interface over devices present in both samples.
    /// A newly appearing device brings an old lifetime counter and therefore
    /// must not become a one-interval burst.
    fn net_rate(&mut self, counted: &[(&str, u64, u64)], now: Instant) -> (u64, u64) {
        let rate = match self.prev_net_at {
            Some(t) => {
                let secs = now.saturating_duration_since(t).as_secs_f64();
                let (rx, tx) = counted
                    .iter()
                    .filter_map(|(name, rx, tx)| {
                        let (prx, ptx) = self.prev_net.get(*name)?;
                        Some((rx.saturating_sub(*prx), tx.saturating_sub(*ptx)))
                    })
                    .fold((0u64, 0u64), |(a, b), (r, t)| (a.saturating_add(r), b.saturating_add(t)));
                if secs <= 0.0 {
                    (0, 0)
                } else {
                    ((rx as f64 / secs) as u64, (tx as f64 / secs) as u64)
                }
            }
            None => (0, 0),
        };
        self.prev_net_at = Some(now);
        self.prev_net = counted.iter().map(|(n, r, t)| ((*n).to_owned(), (*r, *t))).collect();
        rate
    }
}
fn read_trim(path: &str) -> Option<String> {
    fs::read_to_string(host_path(path)).ok().map(|s| s.trim().to_owned())
}

/// Parses /proc/meminfo into bytes keyed by field name.
fn meminfo() -> HashMap<String, u64> {
    parse_meminfo(&fs::read_to_string(host_path("/proc/meminfo")).unwrap_or_default())
}

fn parse_meminfo(text: &str) -> HashMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(':')?;
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            Some((key.to_owned(), kb * 1024))
        })
        .collect()
}

/// `free(1)`'s used column: total minus the kernel's MemAvailable estimate.
/// sysinfo's `used_memory()` counts page cache as used and reads gigabytes high
/// on a host that has been up for a while.
fn mem_used(m: &HashMap<String, u64>) -> (u64, u64) {
    let g = |k: &str| m.get(k).copied().unwrap_or(0);
    let total = g("MemTotal");
    if total == 0 {
        return (0, 0);
    }
    // Absence selects the fallback, not a zero value: a host under real memory
    // pressure reports MemAvailable 0, and treating that as a missing field
    // would understate used memory precisely when it matters.
    let available =
        m.get("MemAvailable").copied().unwrap_or_else(|| g("MemFree") + g("Buffers") + g("Cached"));
    (total, total.saturating_sub(available))
}

/// `free(1)`'s Swap used column: `SwapTotal - SwapFree`, nothing more.
///
/// Subtracting `SwapCached` would imply that pages swapped back in had released
/// their slots. They have not -- the copy on the device still occupies blocks
/// until something else claims them -- and the result runs about a fifth low.
#[derive(Default)]
struct SwapSources {
    zram_used: u64,
    zram_total: u64,
    zram_devices: u64,
    swap_disk_used: u64,
    swap_disk_total: u64,
    swapfile_used: u64,
    swap_partition_used: u64,
}

// Resolve block devices through sysfs device numbers, so aliases are not counted as ordinary swap.
fn swap_sources(root: &Path) -> Option<SwapSources> {
    use std::os::unix::fs::MetadataExt;
    let mut out = SwapSources::default();
    for device in fs::read_dir(root.join("sys/block")).ok()? {
        let device = device.ok()?;
        let name = device.file_name();
        let name = name.to_str()?;
        if !name.strip_prefix("zram").is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
        {
            continue;
        }
        let path = device.path();
        let size = fs::read_to_string(path.join("disksize")).ok()?.trim().parse::<u64>().ok()?;
        if size == 0 {
            continue;
        }
        let stats = fs::read_to_string(path.join("mm_stat")).ok()?;
        out.zram_used = out.zram_used.checked_add(stats.split_whitespace().nth(2)?.parse().ok()?)?;
        out.zram_total = out.zram_total.checked_add(size)?;
        out.zram_devices += 1;
    }
    let swaps = fs::read_to_string(root.join("proc/swaps")).ok()?;
    for line in swaps.lines().skip(1) {
        let cols: Vec<_> = line.split_whitespace().collect();
        if cols.len() != 5 {
            return None;
        }
        let size = cols[2].parse::<u64>().ok()?.checked_mul(1024)?;
        let used = cols[3].parse::<u64>().ok()?.checked_mul(1024)?;
        let is_zram = if cols[1] == "partition" {
            let path = cols[0].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\");
            let dev = fs::metadata(root.join(path.trim_start_matches('/'))).ok()?.rdev();
            let sys =
                root.join(format!("sys/dev/block/{}:{}", rustix::fs::major(dev), rustix::fs::minor(dev)));
            fs::read_link(sys).ok()?.file_name()?.to_str()?.starts_with("zram")
        } else {
            false
        };
        if is_zram {
            continue;
        }
        out.swap_disk_total = out.swap_disk_total.checked_add(size)?;
        out.swap_disk_used = out.swap_disk_used.checked_add(used)?;
        if cols[1] == "file" {
            out.swapfile_used = out.swapfile_used.checked_add(used)?;
        } else if cols[1] == "partition" {
            out.swap_partition_used = out.swap_partition_used.checked_add(used)?;
        } else {
            return None;
        }
    }
    Some(out)
}

fn swap_used(m: &HashMap<String, u64>) -> (u64, u64) {
    let g = |k: &str| m.get(k).copied().unwrap_or(0);
    let total = g("SwapTotal");
    (total, total.saturating_sub(g("SwapFree")))
}

/// Busy share between two `(total, idle)` jiffy readings.
///
/// Split out of [`Collector::cpu_percent`] so the arithmetic can be asserted
/// directly rather than only against a live machine.
fn busy_percent(prev: (u64, u64), now: (u64, u64)) -> f32 {
    let ((pt, pi), (total, idle)) = (prev, now);
    if total <= pt {
        return 0.0;
    }
    let dt = (total - pt) as f32;
    let di = idle.saturating_sub(pi) as f32;
    ((dt - di) / dt * 100.0).clamp(0.0, 100.0)
}

fn cpu_jiffies() -> Option<(u64, u64)> {
    parse_cpu_jiffies(&fs::read_to_string(host_path("/proc/stat")).ok()?)
}

fn parse_cpu_jiffies(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().next()?.strip_prefix("cpu ")?;
    let v: Vec<u64> = line.split_whitespace().filter_map(|f| f.parse().ok()).collect();
    if v.len() < 5 {
        return None;
    }
    // idle and iowait are both time the CPU did no work. guest and guest_nice
    // are already included in user and nice, so the sum stops before them
    // rather than counting that time twice.
    Some((v.iter().take(8).sum(), v[3] + v[4]))
}

fn loadavg() -> [f32; 3] {
    let text = fs::read_to_string(host_path("/proc/loadavg")).unwrap_or_default();
    let mut it = text.split_whitespace();
    let mut next = || it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    [next(), next(), next()]
}

fn uptime() -> u64 {
    fs::read_to_string(host_path("/proc/uptime"))
        .ok()
        .and_then(|t| t.split_whitespace().next()?.parse::<f64>().ok())
        .unwrap_or(0.0) as u64
}

/// The first real address of each family the kernel reports. On a VPS these
/// are the public ones; behind NAT the v4 is private, which is what the machine
/// actually holds -- no external service is consulted.
///
/// Filtered by [`SKIP_IFACES`] alone, so a docker bridge cannot pass for the
/// machine's address. [`is_stacked`] is not applied here: it answers whether
/// bytes were already counted lower down, and a bridge holding the host address
/// is both stacked and this machine.
fn addresses() -> (String, String) {
    let (mut v4, mut v6) = (String::new(), String::new());
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if skip_iface(&iface.name) || iface.is_link_local() || !iface.is_oper_up() {
            continue;
        }
        match iface.ip() {
            std::net::IpAddr::V4(ip) if v4.is_empty() => v4 = ip.to_string(),
            std::net::IpAddr::V6(ip) if v6.is_empty() => v6 = ip.to_string(),
            _ => {}
        }
    }
    (v4, v6)
}

/// Sums the kernel lifetime byte counters of the selected interfaces.
fn totals(counted: &[(&str, u64, u64)]) -> (u64, u64) {
    counted.iter().fold((0u64, 0u64), |(rx, tx), (_, r, t)| (rx.saturating_add(*r), tx.saturating_add(*t)))
}

/// (name, rx bytes, tx bytes) for each interface in /proc/net/dev.
fn net_dev(text: &str) -> impl Iterator<Item = (&str, u64, u64)> {
    text.lines().skip(2).filter_map(|line| {
        let (name, rest) = line.split_once(':')?;
        let mut f = rest.split_whitespace().map(|v| v.parse::<u64>().ok());
        let rx = f.next()??;
        let tx = f.nth(7)??;
        Some((name.trim(), rx, tx))
    })
}

fn skip_iface(name: &str) -> bool {
    SKIP_IFACES.iter().any(|p| name.starts_with(p))
}

/// Common names for stacked devices, retained as a fallback when sysfs cannot
/// be read. Bare pppN remains eligible because it may be an LTE host's only
/// link; OpenWrt's pppoe-* is explicitly stacked over the WAN device.
fn is_stacked(name: &str) -> bool {
    name.contains('.') || ["bond", "br", "vlan", "vmbr", "pppoe-"].iter().any(|p| name.starts_with(p))
}

const SYS_NET: &str = "/sys/class/net";
const TUNNEL_TYPES: &[&str] = &["65534", "768", "769", "776", "778", "823"];
const TUNNEL_DEVTYPES: &[&str] = &["DEVTYPE=vxlan", "DEVTYPE=geneve"];
const STACKED_DEVTYPES: &[&str] = &["DEVTYPE=bridge", "DEVTYPE=bond"];

/// Whether sysfs shows this interface's bytes are already represented by
/// another interface: bridges/bonds, lower-linked stacked devices, tunnels,
/// and bridge ports. Hardware-backed raw-IP devices remain countable.
fn counted_elsewhere(sys: &Path, name: &str) -> bool {
    let dev = sys.join(name);
    let read = |f: &str| fs::read_to_string(dev.join(f)).unwrap_or_default();
    let uevent = read("uevent");
    let devtype = |set: &[&str]| uevent.lines().any(|l| set.contains(&l));

    let stacked = devtype(STACKED_DEVTYPES)
        || fs::read_dir(&dev).is_ok_and(|mut entries| {
            entries.any(|e| e.is_ok_and(|e| e.file_name().as_encoded_bytes().starts_with(b"lower_")))
        });
    if stacked {
        return true;
    }
    if dev.join("device").exists() {
        return false;
    }
    dev.join("brport").exists() || TUNNEL_TYPES.contains(&read("type").trim()) || devtype(TUNNEL_DEVTYPES)
}
/// A pseudo filesystem, named outright or as a flavour of one such as
/// `fuse.lxcfs`. Matched against the field rather than by building `"{s}."` per
/// candidate, which would allocate a few hundred strings per second.
fn skip_fstype(fstype: &str) -> bool {
    SKIP_FSTYPES.iter().any(|s| fstype == *s || fstype.strip_prefix(s).is_some_and(|r| r.starts_with('.')))
}

/// Mount points backed by real storage, deduplicated by source device so a bind
/// mount or a second subvolume cannot double-count the same disk.
///
/// Re-read every sample rather than cached at startup, otherwise a disk attached
/// later stays invisible until the agent restarts. /proc/self/mounts is a few
/// kilobytes.
fn real_mount_points() -> Vec<String> {
    parse_mounts(&mount_table())
}

fn mount_rows(text: &str) -> Vec<(&str, &str, &str)> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            (f.len() >= 3).then(|| (f[0], f[1], f[2]))
        })
        .collect()
}

fn parse_mounts(text: &str) -> Vec<String> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    let rows = mount_rows(text);
    for (i, &(dev, mount, fstype)) in rows.iter().enumerate() {
        // The table is in mount order and a path resolves to the last mount on
        // it, which is what statvfs below answers for. An earlier entry for the
        // same point remains listed but is no longer reachable: under
        // ProtectHome=yes a host whose /home is its own filesystem has that row
        // sitting beneath a tmpfs, and counting it would book the tmpfs's size
        // as /home's.
        if rows[i + 1..].iter().any(|(_, m, _)| *m == mount) {
            continue;
        }
        if skip_fstype(fstype) {
            continue;
        }
        if !dev.starts_with('/') && fstype != "zfs" && fstype != "btrfs" {
            continue;
        }
        // ZFS datasets and btrfs subvolumes share one pool's free space.
        let key = dev.split('/').next().filter(|_| fstype == "zfs").unwrap_or(dev).to_owned();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(mount.replace("\\040", " "));
    }
    out
}

/// Mount points where a real filesystem sits beneath one this agent does not
/// count, so `statvfs` answers for the layer on top and the one below is absent
/// from the totals.
///
/// The future native unit is expected to set `ProtectHome=yes`, which mounts a tmpfs over
/// /home. Where /home is its own filesystem, `df` on the host and the panel then
/// disagree by its entire size. Reported once at startup, since the discrepancy
/// is otherwise visible only in the totals themselves.
pub fn shadowed_mounts(text: &str) -> Vec<String> {
    let rows = mount_rows(text);
    rows.iter()
        .enumerate()
        .filter(|(i, (dev, mount, fstype))| {
            dev.starts_with('/')
                && !skip_fstype(fstype)
                && rows[i + 1..]
                    .iter()
                    .find(|(_, m, _)| m == mount)
                    .is_some_and(|(_, _, top)| skip_fstype(top))
        })
        .map(|(_, (_, mount, _))| mount.replace("\\040", " "))
        .collect()
}

/// `used = total - free`, exactly what df reports. `total - available` would
/// charge ext4's 5% root reserve to the user and show a fresh disk several
/// percent full.
///
/// Blocking, on the thread that also runs the reporting loop. [`SKIP_FSTYPES`]
/// is what makes that safe: the mounts that hang in D state until a server
/// answers -- nfs, cifs, ceph, fuse -- never reach this call. Removing an entry
/// from that list would let a dead NAS freeze the agent, watchdog included.
fn disk_usage(mounts: &[String]) -> (u64, u64) {
    let mut total = 0u64;
    let mut used = 0u64;
    for m in mounts {
        let Ok(s) = rustix::fs::statvfs(host_path(m)) else { continue };
        let bs = if s.f_frsize > 0 { s.f_frsize } else { s.f_bsize };
        total = total.saturating_add(s.f_blocks.saturating_mul(bs));
        used = used.saturating_add(s.f_blocks.saturating_sub(s.f_bfree).saturating_mul(bs));
    }
    (total, used)
}

/// Socket counts from /proc/net/sockstat, a handful of short lines. Counting
/// lines in /proc/net/tcp would read the whole connection table once a second --
/// hundreds of kilobytes on a busy host, for a number the kernel already keeps.
/// TIME_WAIT sockets live in the v4 `tw` counter for both families, so they are
/// added once.
fn conn_counts() -> (u32, u32) {
    parse_sockstat(
        &fs::read_to_string(host_path("/proc/net/sockstat")).unwrap_or_default(),
        &fs::read_to_string(host_path("/proc/net/sockstat6")).unwrap_or_default(),
    )
}

fn parse_sockstat(v4: &str, v6: &str) -> (u32, u32) {
    let stat = |text: &str, prefix: &str, key: &str| {
        text.lines()
            .find_map(|line| {
                let mut fields = line.strip_prefix(prefix)?.split_whitespace();
                while let Some(word) = fields.next() {
                    if word == key {
                        return fields.next()?.parse::<u32>().ok();
                    }
                }
                None
            })
            .unwrap_or(0)
    };
    (
        stat(v4, "TCP:", "inuse") + stat(v4, "TCP:", "tw") + stat(v6, "TCP6:", "inuse"),
        stat(v4, "UDP:", "inuse") + stat(v6, "UDP6:", "inuse"),
    )
}

fn proc_count() -> u32 {
    fs::read_dir(host_path("/proc"))
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
                .count() as u32
        })
        .unwrap_or(0)
}

fn cpuinfo() -> (String, u32) {
    let text = fs::read_to_string(host_path("/proc/cpuinfo")).unwrap_or_default();
    let name = text
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            matches!(k.trim(), "model name" | "Model" | "cpu model").then(|| v.trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    let cores = text.lines().filter(|l| l.starts_with("processor")).count().max(1) as u32;
    (name, cores)
}

fn os_pretty_name() -> String {
    fs::read_to_string(host_path("/etc/os-release"))
        .or_else(|_| fs::read_to_string(host_path("/usr/lib/os-release")))
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| Some(l.strip_prefix("PRETTY_NAME=")?.trim_matches('"').to_owned()))
        })
        .unwrap_or_else(|| "Linux".into())
}

fn virtualization() -> String {
    if fs::metadata(host_path("/proc/vz")).is_ok() {
        return "openvz".into();
    }
    if fs::metadata(host_path("/proc/xen")).is_ok() {
        return "xen".into();
    }
    if fs::metadata(host_path("/.dockerenv")).is_ok() {
        return "docker".into();
    }
    if let Some(t) = read_trim("/sys/hypervisor/type") {
        return t.to_lowercase();
    }
    for path in ["/sys/class/dmi/id/product_name", "/sys/class/dmi/id/sys_vendor"] {
        let Some(v) = read_trim(path) else { continue };
        let l = v.to_lowercase();
        for k in ["kvm", "vmware", "virtualbox", "qemu", "hyper-v", "xen", "bochs", "amazon", "google"] {
            if l.contains(k) {
                return k.into();
            }
        }
    }
    if fs::read_to_string(host_path("/proc/cpuinfo")).is_ok_and(|t| t.contains("hypervisor")) {
        "vm".into()
    } else {
        "none".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "explicit collection microbenchmark; no network or service installation"]
    fn collector_ablation() {
        let variants = [
            ("full", true, true, true),
            ("no-disks", false, true, true),
            ("no-sockets", true, false, true),
            ("no-processes", true, true, false),
        ];
        let mut results = Vec::new();
        for repeat in 1..=3 {
            for index in 0..variants.len() {
                let (name, disks, sockets, processes) =
                    variants[if repeat % 2 == 0 { variants.len() - 1 - index } else { index }];
                let mut collector = Collector::new(Ifaces::default());
                let mut times = Vec::with_capacity(1000);
                for _ in 0..1000 {
                    let started = Instant::now();
                    let metrics = collector.collect_selected(disks, sockets, processes);
                    std::hint::black_box(metrics);
                    times.push(started.elapsed().as_secs_f64() * 1_000_000.0);
                }
                times.sort_by(f64::total_cmp);
                results.push(serde_json::json!({"variant":name,"repeat":repeat,"samples":times.len(),
                    "p50_us":times[500],"p95_us":times[950],"p99_us":times[990]}));
            }
        }
        let report =
            serde_json::json!({"kind":"hot collection calls, not connected Agent RSS", "runs":results});
        if let Ok(path) = std::env::var("ROMI_COLLECTOR_REPORT") {
            fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        }
        println!("{report}");
    }

    #[test]
    fn container_paths_keep_host_mounts_under_the_read_only_root() {
        let root = Path::new("/host");
        assert_eq!(rooted(root, Path::new("/proc/1/mounts")), Path::new("/host/proc/1/mounts"));
        assert_eq!(rooted(root, Path::new("/var/lib/data")), Path::new("/host/var/lib/data"));
        let mounts = parse_mounts("/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /data ext4 rw 0 0\n");
        let mapped: Vec<_> = mounts.iter().map(|m| rooted(root, Path::new(m))).collect();
        assert_eq!(mapped, vec![PathBuf::from("/host/"), PathBuf::from("/host/data")]);
    }

    #[test]
    fn memory_matches_free_not_sysinfo() {
        // Real /proc/meminfo from a 3.8 GiB host holding 2.5 GiB of cache.
        let m = parse_meminfo(
            "MemTotal:        4008884 kB\nMemFree:          602756 kB\nMemAvailable:    2947484 kB\n\
             Buffers:          129100 kB\nCached:          2351560 kB\nSReclaimable:     154008 kB\n\
             Shmem:              2176 kB\nSwapTotal:       1048572 kB\nSwapFree:         987264 kB\n\
             SwapCached:        13280 kB\n",
        );
        let (total, used) = mem_used(&m);
        assert_eq!(total, 4008884 * 1024);
        assert_eq!(used, (4008884 - 2947484) * 1024, "must match the `free` used column");
        // Counting cache as used would report ~3.3 GiB here.
        assert!(used < (total - g_cached(&m)), "page cache must not count as used");

        // free's Swap used column is total - free. SwapCached is not
        // subtracted: those pages still occupy their blocks on the device.
        let (st, su) = swap_used(&m);
        assert_eq!(st, 1048572 * 1024);
        assert_eq!(su, (1048572 - 987264) * 1024, "must match the `free` swap used column");
    }

    fn g_cached(m: &HashMap<String, u64>) -> u64 {
        m.get("Cached").copied().unwrap_or(0)
    }

    #[test]
    fn memory_falls_back_when_memavailable_is_absent() {
        let m = parse_meminfo("MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 300 kB\n");
        assert_eq!(mem_used(&m), (1000 * 1024, 400 * 1024));
        assert_eq!(mem_used(&HashMap::new()), (0, 0));
    }

    #[test]
    fn cpu_percent_needs_a_baseline_then_uses_deltas() {
        assert_eq!(parse_cpu_jiffies("cpu  40 0 35 925 0 0 0 0 0 0\n"), Some((1000, 925)));
        // The last two columns are guest and guest_nice, already counted in
        // user and nice: 80 busy jiffies, not 1080.
        assert_eq!(parse_cpu_jiffies("cpu  10 10 10 10 10 10 10 10 500 500\n"), Some((80, 20)));
        assert!(parse_cpu_jiffies("garbage").is_none());

        // 100 more jiffies since the baseline, 25 idle => 75% busy. Asserted
        // against the function the binary runs rather than a copy of the
        // formula, which would not catch busy and idle being swapped.
        assert_eq!(busy_percent((1000, 925), (1100, 950)), 75.0);
        assert_eq!(busy_percent((1000, 925), (1100, 1025)), 0.0, "a fully idle interval is 0% busy");
        // A counter that moved backwards indicates a reboot, not 100% busy.
        assert_eq!(busy_percent((1000, 925), (500, 400)), 0.0);
        // The first call has no baseline, so it reports 0.
        assert_eq!(Collector::default().cpu_percent(), 0.0);
    }

    #[test]
    fn socket_counts_come_from_sockstat_not_the_connection_table() {
        let v4 = "sockets: used 226\nTCP: inuse 78 orphan 1 tw 7 alloc 85 mem 119\nUDP: inuse 2 mem 150\n";
        let v6 = "TCP6: inuse 1\nUDP6: inuse 4\n";
        // Matches counting lines in /proc/net/tcp{,6}: TIME_WAIT sockets are
        // held in the v4 `tw` field for both families.
        assert_eq!(parse_sockstat(v4, v6), (86, 6));
        assert_eq!(parse_sockstat("", ""), (0, 0));
    }

    /// Totals over constructed /proc/net/dev text, without consulting the host's sysfs.
    fn sum(dev: &str, ifaces: &Ifaces) -> (u64, u64) {
        totals(
            &net_dev(dev).filter(|(n, ..)| ifaces.counts(Path::new("/nonexistent"), n)).collect::<Vec<_>>(),
        )
    }

    #[test]
    fn net_counts_a_wire_byte_once_however_many_devices_book_it() {
        let dev = "Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n\
                   eth0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n\
                     lo: 9999 1 0 0 0 0 0 0 9999 2 0 0 0 0 0 0\n\
              docker0: 5555 1 0 0 0 0 0 0 5555 2 0 0 0 0 0 0\n\
            veth9a1b2c: 5555 1 0 0 0 0 0 0 5555 2 0 0 0 0 0 0\n\
                  wg0: 300 1 0 0 0 0 0 0 400 2 0 0 0 0 0 0\n\
           tailscale0: 300 1 0 0 0 0 0 0 400 2 0 0 0 0 0 0\n\
                 tun0: 300 1 0 0 0 0 0 0 400 2 0 0 0 0 0 0\n\
                 tap0: 300 1 0 0 0 0 0 0 400 2 0 0 0 0 0 0\n\
            fwln100i0: 300 1 0 0 0 0 0 0 400 2 0 0 0 0 0 0\n\
             ifb4eth0: 1000 1 0 0 0 0 0 0 1000 2 0 0 0 0 0 0\n\
                bond0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n\
                  br0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n\
                vmbr0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n\
             eth0.100: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n\
              vlan100: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n\
            pppoe-wan: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n";
        assert_eq!(sum(dev, &Ifaces::default()), (1000, 2000));
    }

    #[test]
    fn a_stacked_device_loses_its_bytes_but_keeps_its_address() {
        for name in ["bond0", "br0", "vmbr0", "eth0.100", "vlan100", "pppoe-wan"] {
            assert!(is_stacked(name), "{name}: the lower device already counted these bytes");
            assert!(!skip_iface(name), "{name} is where a host address lives");
        }
        for name in [
            "lo",
            "docker0",
            "veth9a1b2c",
            "br-6cd9538131d7",
            "virbr0",
            "wg0",
            "tun0",
            "tap0",
            "fwln100i0",
            "ifb4eth0",
            "gretap0",
            "erspan0",
            "lxc9f2c1e",
            "cilium_host",
        ] {
            assert!(skip_iface(name), "{name} is not this machine");
        }
        assert!(!skip_iface("eth0") && !is_stacked("eth0"));
    }

    #[test]
    fn the_kernel_tells_a_copy_whatever_the_interface_is_called() {
        let sys = std::env::temp_dir().join(format!("romi-agent-sys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&sys);
        for (name, ty, extra) in [
            ("he-ipv6", 776, &[][..]),
            ("nebula1", 65534, &[]),
            ("gre1", 778, &[]),
            ("vx100", 1, &["DEVTYPE=vxlan"]),
            ("lan", 1, &["lower_eth0"]),
            ("lxdbr0", 1, &["DEVTYPE=bridge"]),
            ("uplink", 1, &["DEVTYPE=bond"]),
            ("wan", 1, &["device", "lower_eth0"]),
            ("wwan0", 65534, &["device"]),
            ("venet0", 65535, &[]),
            ("mv0", 1, &[]),
            ("eth0", 1, &["device"]),
            ("vnet0", 1, &["brport"]),
            ("eno1", 1, &["device", "brport"]),
            ("up1", 1, &["master"]),
        ] {
            let dir = sys.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("type"), format!("{ty}\n")).unwrap();
            for e in extra {
                match e.strip_prefix("DEVTYPE=") {
                    Some(_) => fs::write(dir.join("uevent"), format!("{e}\nINTERFACE={name}\n")).unwrap(),
                    None => fs::create_dir(dir.join(e)).unwrap(),
                }
            }
        }
        for name in ["he-ipv6", "nebula1", "gre1", "vx100", "lan", "wan", "lxdbr0", "uplink", "vnet0"] {
            assert!(counted_elsewhere(&sys, name), "{name}: another interface counts these bytes");
        }
        for name in ["wwan0", "venet0", "mv0", "eth0", "eno1", "up1", "absent0"] {
            assert!(!counted_elsewhere(&sys, name), "{name} is this machine's own link");
        }
        fs::remove_dir_all(&sys).unwrap();
    }

    #[test]
    fn iface_names_what_is_counted_over_every_built_in_rule() {
        let dev = "header\nheader\n\
                   eth0: 50 1 0 0 0 0 0 0 1000 2 0 0 0 0 0 0\n\
                   eth1: 1008 1 0 0 0 0 0 0 60 2 0 0 0 0 0 0\n\
                 eth1.7: 500 1 0 0 0 0 0 0 30 2 0 0 0 0 0 0\n\
              pppoe-wan: 1000 1 0 0 0 0 0 0 52 2 0 0 0 0 0 0\n\
                  vmbr0: 7 1 0 0 0 0 0 0 9 2 0 0 0 0 0 0\n";
        let with = |spec: &str| sum(dev, &Ifaces::parse(spec).unwrap());
        assert_eq!(with(""), (1058, 1060));
        assert_eq!(with("pppoe-wan"), (1000, 52));
        assert_eq!(with("vmbr0"), (7, 9));
        assert_eq!(with("eth1.7"), (500, 30));
        assert_eq!(with("-eth0"), (1008, 60));
        assert_eq!(with("eth0,eth1,-eth0"), (1008, 60));
        assert_eq!(with("eth9"), (0, 0));

        for bad in ["eth0 eth1", "-", "eth0,-", "--eth0", "eth0,,eth1"] {
            assert!(Ifaces::parse(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_epoch_changes_whenever_the_summed_set_does() {
        let e = |names: &[&str]| epoch("boot", names.iter().copied());
        assert!(e(&["eth0"]).starts_with("boot/"));
        assert_ne!(e(&["eth0"]), e(&["eth0", "lxdbr0"]));
        assert_ne!(e(&["eth0"]), e(&["eth1"]));
        assert_ne!(e(&["eth0"]), e(&[]));
        assert_eq!(e(&["eth1", "eth0"]), e(&["eth0", "eth1"]));
    }

    #[test]
    fn net_rate_counts_each_interface_against_its_own_last_reading() {
        let mut c = Collector::default();
        let t0 = Instant::now();
        let at = |secs| t0 + std::time::Duration::from_secs(secs);
        assert_eq!(c.net_rate(&[("eth0", 1000, 2000)], t0), (0, 0));
        assert_eq!(c.net_rate(&[("eth0", 1200, 2400)], at(2)), (100, 200));
        assert_eq!(c.net_rate(&[("eth0", 50, 60)], at(4)), (0, 0));
        assert_eq!(c.net_rate(&[("eth0", 250, 460), ("eth1", 9_000_000, 9_000_000)], at(6)), (100, 200));
        assert_eq!(c.net_rate(&[("eth0", 450, 860), ("eth1", 9_000_200, 9_000_400)], at(8)), (200, 400));
    }
    /// Two independent guards reject a mount: its filesystem type, and whether
    /// its source looks like a device. Most entries trip both, so the table
    /// includes a line that only one of them catches.
    #[test]
    fn mounts_drop_pseudo_filesystems_and_duplicate_devices() {
        let mounts = parse_mounts(
            "/dev/vda1 / ext4 rw 0 0\n\
             proc /proc proc rw 0 0\n\
             tmpfs /run tmpfs rw 0 0\n\
             /dev/loop0 /snap/core24/1 squashfs ro 0 0\n\
             none /mnt/scratch ext4 rw 0 0\n\
             /dev/vda1 /var/lib/bind ext4 rw 0 0\n\
             overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0\n\
             /home/.ecryptfs/u/.Private /home/u ecryptfs rw 0 0\n\
             /dev/vdb1 /data xfs rw 0 0\n\
             /mnt/disk1:/mnt/disk2 /pool fuse.mergerfs rw 0 0\n\
             //nas/backup /mnt/nas cifs rw 0 0\n\
             tank/set1 /tank zfs rw 0 0\n\
             tank/set2 /tank/sub zfs rw 0 0\n",
        );
        // /snap/... is a real device holding a pseudo filesystem, rejected only
        // by the fstype list; one squashfs per snap would otherwise add a full
        // copy of each to the disk total. /mnt/scratch is the inverse, a real
        // filesystem whose source is not a path, caught only by the device
        // check. //nas/backup and the mergerfs pool are a third case: sources
        // that pass for a device while holding either remote storage or a second
        // view of mounts already counted. Only the fstype list excludes those,
        // and only `fuse` as a whole covers the pool. A block device behind a
        // fuse driver mounts as `fuseblk` and still counts. The ecryptfs row is
        // a fourth: a stacked mount whose source is a directory on the filesystem
        // beneath it, so it passes the device check and carries a source of its
        // own past the dedup, while statvfs reports that filesystem again.
        assert_eq!(mounts, vec!["/", "/data", "/tank"]);
    }

    /// A future native unit is expected to run this agent with
    /// `ProtectHome=yes`, which systemd implements by mounting a tmpfs over
    /// /home. Both rows remain in the table, but a path resolves to the upper
    /// one, so counting the row underneath would book the tmpfs's size -- half
    /// of RAM by default -- as that of a filesystem statvfs is never asked
    /// about.
    #[test]
    fn a_shadowed_filesystem_is_not_counted_as_the_one_mounted_over_it() {
        let table = "/dev/vda1 / ext4 rw 0 0\n\
                     /dev/vdb1 /home ext4 rw 0 0\n\
                     tmpfs /home tmpfs ro,size=409600k 0 0\n";
        assert_eq!(parse_mounts(table), vec!["/"]);
        // The shadowed mount is named, or the panel simply disagrees with df.
        assert_eq!(shadowed_mounts(table), vec!["/home"]);
        // A point mounted once is not shadowed, however many others exist.
        assert!(shadowed_mounts("/dev/vda1 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n").is_empty());
    }

    #[test]
    fn real_host_collection_is_sane() {
        let mut c = Collector::default();
        let f = c.facts();
        assert!(!f.hostname.is_empty() && f.cpu_cores >= 1 && f.mem_total > 0);
        assert_eq!(f.agent_version, env!("CARGO_PKG_VERSION"), "the report carries the romi version");
        // Whatever this host reports must parse, and a virtual bridge must not
        // be selected.
        assert!(f.ipv4.is_empty() || f.ipv4.parse::<std::net::Ipv4Addr>().is_ok());
        assert!(f.ipv6.is_empty() || f.ipv6.parse::<std::net::Ipv6Addr>().is_ok());
        assert!(!f.ipv4.is_empty() || !f.ipv6.is_empty(), "a reachable host has at least one address");
        // The prefix filter is the only guard keeping a docker bridge out.
        assert!(!f.ipv4.starts_with("172.17."), "a virtual bridge is not this machine's address");
        let m = c.collect();
        assert!(!m.boot_id.is_empty(), "boot_id drives reboot detection");
        assert!(!c.counted_ifaces().is_empty(), "a reachable host counts at least one interface");
        assert!(m.mem_used > 0 && m.mem_used < m.mem_total);
        assert!(m.disk_used <= m.disk_total && m.disk_total > 0);
        assert!((0.0..=100.0).contains(&m.cpu));
    }
}

#[cfg(test)]
mod crosscheck {
    use super::*;

    /// The accuracy rule, checked against the tools it names. Constructed /proc
    /// text can only show that the arithmetic is right; it cannot show that the
    /// right field was read, which is the failure this agent exists to prevent.
    ///
    /// Every figure `free` and `df` report is compared, swap included: an
    /// omitted metric is one nothing verifies.
    ///
    /// The tolerance covers movement between the two readings and sits an order
    /// of magnitude below every wrong answer -- the root reserve `df` excludes
    /// and the page cache sysinfo counts as used are both gigabytes.
    ///
    /// Values are printed, so `cargo test crosscheck -- --nocapture` shows them.
    #[test]
    fn memory_and_disk_agree_with_free_and_df_on_this_machine() {
        let mut c = Collector::default();
        let m = c.collect();
        let gib = |b: u64| b as f64 / 1024.0 / 1024.0 / 1024.0;
        println!("mem  used={:.2}G total={:.2}G", gib(m.mem_used), gib(m.mem_total));
        println!("disk used={:.2}G total={:.2}G", gib(m.disk_used), gib(m.disk_total));
        println!("swap used={:.2}G total={:.2}G", gib(m.swap_used), gib(m.swap_total));
        println!("net  rx_total={} tx_total={}", m.net_rx_total, m.net_tx_total);

        const TOLERANCE: u64 = 64 * 1024 * 1024;
        let close = |ours: u64, theirs: u64, what: &str| {
            let drift = ours.abs_diff(theirs);
            assert!(drift < TOLERANCE, "{what}: ours={ours} theirs={theirs} drift={drift}");
        };

        // free(1) row "Mem:": total, used, free, shared, buff/cache, available.
        // procps-ng before 4.0 reports "used" as total - free - buff/cache,
        // while this agent intentionally reports total - MemAvailable. Compare
        // against free's own available column when present so both procps
        // generations check the same semantic.
        let free = tool("free", &["-b"]);
        let fields: Vec<&str> =
            free.lines().nth(1).expect("free prints a Mem: row").split_whitespace().skip(1).collect();
        let parse = |value: &str| value.parse::<u64>().expect("a byte count");
        let total = parse(fields.first().copied().expect("free total column"));
        assert_eq!(m.mem_total, total, "MemTotal is not free's total");
        let expected_used = match fields.get(5) {
            Some(available) => total.saturating_sub(parse(available)),
            None => parse(fields.get(1).copied().expect("free used column")),
        };
        close(m.mem_used, expected_used, "memory");

        // free(1) row "Swap:": total, used, free. The tolerance is far tighter
        // than for memory because the miscount it catches -- subtracting
        // SwapCached -- is single-digit MiB, which the memory tolerance would
        // admit. Swap moves slowly enough for a megabyte to suffice.
        const SWAP_TOLERANCE: u64 = 1024 * 1024;
        let mut row = free.lines().nth(2).expect("free prints a Swap: row").split_whitespace().skip(1);
        assert_eq!(
            m.swap_total,
            parse(row.next().expect("free swap total column")),
            "SwapTotal is not free's swap total"
        );
        let theirs = parse(row.next().expect("free swap used column"));
        let drift = m.swap_used.abs_diff(theirs);
        assert!(drift < SWAP_TOLERANCE, "swap: ours={} theirs={theirs} drift={drift}", m.swap_used);

        // df(1) counts the root reserve as free, which is f_bfree rather than
        // f_bavail. Compared against a single filesystem, since df is asked
        // about one while the metric sums every mount.
        let (disk_total, disk_used) = disk_usage(&["/".to_owned()]);
        let df = tool("df", &["-B1", "--output=size,used", "/"]);
        let mut row = df.lines().nth(1).expect("df prints a data row").split_whitespace();
        let parse = |v: Option<&str>| v.expect("df column").parse::<u64>().expect("a byte count");
        assert_eq!(disk_total, parse(row.next()), "f_blocks is not df's size");
        close(disk_used, parse(row.next()), "disk");
    }

    /// A missing tool is a failure rather than grounds for passing quietly:
    /// this test is worthless if it can skip the comparison it exists for.
    fn tool(program: &str, args: &[&str]) -> String {
        let out = std::process::Command::new(program)
            .args(args)
            .env("LC_ALL", "C")
            .output()
            .unwrap_or_else(|e| panic!("{program}(1) is what these numbers are checked against: {e}"));
        assert!(out.status.success(), "{program} exited with {}", out.status);
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
}

#[cfg(test)]
mod swap_source_tests {
    use super::*;
    #[test]
    fn unconfigured_and_unreadable_swap_are_distinct() {
        let root = std::env::temp_dir().join(format!("romi-swap-{}", std::process::id()));
        fs::create_dir_all(root.join("sys/block/zram0")).unwrap();
        fs::create_dir_all(root.join("proc")).unwrap();
        fs::write(root.join("sys/block/zram0/disksize"), "0").unwrap();
        fs::write(root.join("proc/swaps"), "Filename Type Size Used Priority\n").unwrap();
        let empty = swap_sources(&root).unwrap();
        assert_eq!(empty.zram_devices, 0);
        assert_eq!(empty.swap_disk_used, 0);
        fs::write(root.join("sys/block/zram0/disksize"), "1024").unwrap();
        fs::write(root.join("sys/block/zram0/mm_stat"), "900 400 512 0 0").unwrap();
        fs::write(root.join("proc/swaps"), "Filename Type Size Used Priority\n/swapfile file 100 20 -1\n")
            .unwrap();
        let used = swap_sources(&root).unwrap();
        assert_eq!(used.zram_used, 512);
        assert_eq!(used.zram_devices, 1);
        assert_eq!(used.swap_disk_used, 20 * 1024);
        assert_eq!(used.swapfile_used, 20 * 1024);
        fs::remove_file(root.join("sys/block/zram0/mm_stat")).unwrap();
        assert!(swap_sources(&root).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
