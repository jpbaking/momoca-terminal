/**
 * electron-builder afterPack hook: ad-hoc sign the packaged app as one sealed
 * bundle.
 *
 * Without a Developer ID, electron-builder 25 skips signing entirely and the
 * app ships with Electron's own linker signature (identifier "Electron", no
 * sealed Info.plist or resources). macOS then has no stable identity to attach
 * privacy grants to. Local Network is the one that hurts: the toggle can be on
 * and every connection to the LAN (RDP, SSH, ping) still fails with
 * "No route to host", while hosts on other subnets work.
 *
 * Signing here, as `dev.local.momoca` with the hardened runtime and the app's
 * entitlements, fixes that. A real identity found later by electron-builder
 * re-signs with --force over this, so this never blocks Developer ID builds.
 * Ad-hoc signatures change with every build, so after installing a new build
 * macOS may ask for Local Network access again.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return
  // A universal build packs x64 and arm64 into *-temp dirs first and merges
  // them; signing those would make the two halves differ and break the merge.
  if (context.appOutDir.endsWith('-temp')) return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = join(__dirname, '..', 'build', 'entitlements.mac.plist')

  // --deep signs nested helpers and frameworks inside-out; each takes its
  // identifier from its own Info.plist, so the main bundle becomes
  // dev.local.momoca rather than the stock "Electron".
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-', '--timestamp=none',
    '--options', 'runtime', '--entitlements', entitlements, app
  ], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed  ${app}`)
}
