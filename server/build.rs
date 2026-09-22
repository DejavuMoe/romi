//! Static assets are built explicitly with `make frontend`; no downloads here.
use std::path::Path;

fn main() {
    println!("cargo:rustc-env=ROMI_BUILD_TARGET={}", std::env::var("TARGET").unwrap());
    for path in ["../admin/dist", "target/theme"] {
        println!("cargo:rerun-if-changed={path}");
    }
    for path in ["../admin/dist/index.html", "target/theme/dist/index.html", "target/theme/theme.json"] {
        assert!(Path::new(path).is_file(), "missing {path}; run `make frontend` at the romi root first");
    }
}
