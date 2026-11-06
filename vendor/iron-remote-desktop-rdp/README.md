# @devolutions/iron-remote-desktop-rdp, built from source

IronRDP's web RDP client (WebAssembly), which draws RDP sessions in MoMoca's
tabs. It is © Devolutions and the IronRDP contributors, under MIT or Apache-2.0
(`LICENSE-MIT`, `LICENSE-APACHE`); MoMoca does not modify it.

npm's latest release, 0.7.0, predates IronRDP fixes MoMoca needs, notably
"preserve bitmap source stride" (#1486), without which xrdp's screen updates
draw sheared. This copy is built from the IronRDP commit named in
`package.json` (`gitHead`) by `scripts/build-ironrdp.sh`.

Do not edit these files by hand. To update: change `IRONRDP_COMMIT` in the
script, run it, then `npm install`, `npm run build` and
`test/suites/rdptest.mjs`. When an npm release includes the fixes, depend on it
again and delete this folder and the script.
