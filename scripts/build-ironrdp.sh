#!/usr/bin/env bash
# Build IronRDP's web package (@devolutions/iron-remote-desktop-rdp) from
# source into vendor/iron-remote-desktop-rdp, the copy MoMoca's RDP tabs use.
#
# npm's 0.7.0 predates IronRDP fixes that RDP tabs need (bitmap source
# stride, #1486: xrdp's screen updates drew sheared). Until a release carries
# them, this builds a pinned commit the way IronRDP's `cargo xtask web build`
# does. Bump IRONRDP_COMMIT, run this, run test/suites/rdptest.mjs, commit.
#
# Local patches in scripts/ironrdp-patches/*.patch apply on top, in order:
#   0001-desktop-scale-factor  `desktopScaleFactor(percent)` extension, so a
#                              Retina tab logs in at 200% instead of 100%.
# Make a new one with `git diff` in the checkout. Drop a patch once the
# pinned commit carries the change; a patch that no longer applies fails here.
#
# Needs: git, npm, and rustup (https://rustup.rs) with wasm-pack:
#   cargo install wasm-pack --version 0.15.0 --locked
# The Rust toolchain itself comes from IronRDP's rust-toolchain.toml.
#
# Usage: scripts/build-ironrdp.sh [commit]
#   IRONRDP_WORKDIR  checkout to build in (kept between runs, so rebuilds are
#                    incremental); default $TMPDIR/momoca-ironrdp
set -euo pipefail

IRONRDP_COMMIT="${1:-f1e218e58dc60c0579a8aba25e67077bf80be32b}"
WORKDIR="${IRONRDP_WORKDIR:-${TMPDIR:-/tmp}/momoca-ironrdp}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/iron-remote-desktop-rdp"
export PATH="$HOME/.cargo/bin:$PATH"

for tool in git npm rustup cargo wasm-pack; do
  command -v "$tool" >/dev/null || { echo "missing: $tool (see the header of $0)" >&2; exit 1; }
done

if [ ! -d "$WORKDIR/.git" ]; then
  git clone --filter=blob:none https://github.com/Devolutions/IronRDP.git "$WORKDIR"
fi
cd "$WORKDIR"
git fetch --quiet origin "$IRONRDP_COMMIT" 2>/dev/null || git fetch --quiet origin
git checkout --quiet --force "$IRONRDP_COMMIT"
COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=7 HEAD)"
PATCHED=""
for patch in "$ROOT"/scripts/ironrdp-patches/*.patch; do
  [ -e "$patch" ] || continue
  git apply "$patch"
  PATCHED="$PATCHED $(basename "$patch" .patch)"
done
echo "Building IronRDP $COMMIT${PATCHED:+ with${PATCHED}}"

# The pinned toolchain from rust-toolchain.toml, with the WebAssembly target.
TOOLCHAIN="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
rustup toolchain install "$TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown

# The release build from xtask/src/web.rs.
(
  cd crates/ironrdp-web
  RUSTFLAGS='-Ctarget-feature=+simd128,+bulk-memory --cfg getrandom_backend="wasm_js" -Copt-level=s -Ccodegen-units=1 -Cllvm-args=-enable-dfa-jump-thread' \
    wasm-pack build --target web
)

# xtask rewrites the loader so Vite inlines the wasm instead of resolving a URL.
node -e '
  const fs = require("fs");
  const path = "crates/ironrdp-web/pkg/ironrdp_web.js";
  let js = fs.readFileSync(path, "utf8");
  const url = "new URL(\x27ironrdp_web_bg.wasm\x27, import.meta.url)";
  if (!js.includes("wasmUrl")) {
    if (!js.includes(url)) throw new Error("wasm loader pattern not found; xtask/src/web.rs may have changed");
    js = "import wasmUrl from \x27./ironrdp_web_bg.wasm?url\x27;\n\n" + js.replace(url, "wasmUrl");
    fs.writeFileSync(path, js);
  }
'

(
  cd web-client/iron-remote-desktop-rdp
  npm ci --no-audit --no-fund
  npm run build-alone
)

DIST="web-client/iron-remote-desktop-rdp/dist"
mkdir -p "$VENDOR"
cp "$DIST/iron-remote-desktop-rdp.js" "$DIST/index.d.ts" "$VENDOR/"
cp LICENSE-MIT LICENSE-APACHE "$VENDOR/"
node -e '
  const fs = require("fs");
  const [dist, vendor, commit, short, patched] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(dist + "/package.json", "utf8"));
  pkg.version = pkg.version + "-git." + short + (patched ? ".patched" : "");
  pkg.gitHead = commit;
  pkg.files = [...pkg.files, "LICENSE-MIT", "LICENSE-APACHE"];
  fs.writeFileSync(vendor + "/package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$DIST" "$VENDOR" "$COMMIT" "$SHORT" "$PATCHED"

echo "Vendored IronRDP $SHORT into vendor/iron-remote-desktop-rdp"
echo "Next: npm install, npm run build, then test/suites/rdptest.mjs"
