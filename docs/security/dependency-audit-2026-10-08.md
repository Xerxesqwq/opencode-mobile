# Dependency audit — 2026-10-08

## Scope and reproducible baseline

Repository: Xerxesqwq/opencode-mobile. Fresh `main` was
[`16f5af2fcc32bf59a4c60aefd895c57c1e403124`](https://github.com/Xerxesqwq/opencode-mobile/commit/16f5af2fcc32bf59a4c60aefd895c57c1e403124).
Audits used Node 24.19.0 / npm 11.9.0 against registry.npmjs.org, on 2026-10-08 UTC.
`package.json` and `package-lock.json` were read from that checkout before installation.
The previously mentioned 47 findings are historical, not the current baseline.

| npm affected package entries | Critical | High | Moderate | Low | Total |
|---|---:|---:|---:|---:|---:|
| Before, full graph | 3 | 57 | 19 | 9 | 88 |
| Before, `--omit=dev` | 3 | 57 | 19 | 9 | 88 |
| After, full graph | 0 | 22 | 18 | 0 | 40 |
| After, `--omit=dev` | 0 | 22 | 18 | 0 | 40 |

Before: 8 direct / 80 transitive affected package names. After: 5 direct / 35
transitive. All affected installed paths are marked production in this lockfile;
none is dev-only. This does **not** mean they all execute in a production APK:
Expo and React Native list many Node build/development tools as dependencies.
The 88 entries include inherited/metavulnerabilities. There are 62 distinct GHSA
URLs before, 7 after; these are different counting units.

Machine-readable evidence: [before.json](audit-2026-10-08/before.json),
[after.json](audit-2026-10-08/after.json). Each full/omit-dev pair was byte-identical,
so only one copy per state is committed. Audit findings change with the advisory
registry even when the lockfile is unchanged.

SHA-256:
- Baseline package.json: `4d47cd0bd04339a6da7251160fdd9247da7bd5de3362cec718cda8b7e0552067`
- Baseline package-lock.json: `f55c4abbfc9c2de98b5313b97e961ae793f0d34f84871ae5831828373c160979`
- Before audit JSON: `6a468358acd55de985914a3ebe16a23afaf2cdd7ec30c455d154ba8e427d8881`
- After audit JSON: `45d78b16a46011463972fcf2e12bafc2394ad8579c75b0739a74b1ed5ffdd13f`

## Chosen minimal-compatible changes

- Preserve **all direct dependency versions**, including Expo 54.0.34,
  React Native 0.81.5, React 19.1.0, Expo Router 6.0.23, Reanimated and Worklets.
  No native source dependency is upgraded.
- Refresh specifically selected vulnerable transitive packages within their
  declared semver ranges. This removes both Critical advisory roots (`tar` and
  `shell-quote`) and the inherited Critical on `react-devtools-core`.
- Add exactly one scoped override: `@expo/metro-config` → `postcss: 8.5.23`.
  Expo pins `~8.4.32`, which cannot reach the patched 8.5 series. This is a
  same-major JS-only change with CommonJS/default/plugin/source-map compatibility
  tests. 8.5.23 is the first version beyond all currently reported affected ranges.
- Use `npm ci --legacy-peer-deps` in the three non-publishing Android workflow
  jobs, preventing the tested lockfile from being re-resolved during verification.
- Enable the existing, non-publishing F-Droid APK job on pull requests as well
  as release tags. PRs use a separate debug-signing step, and the step that
  references production signing secrets is tag-only; release publishing remains
  tag-only.
- Add an informational full/production audit job with visible summaries and raw
  JSON artifacts. Existing unresolved findings and registry outages do not block
  APK builds. Malformed/error responses fail the summary step, never count as zero.

No `npm audit fix --force` was executed. A non-mutating `npm audit fix ... --dry-run`
was inspected, but its suggested Expo 44 downgrade and React Native 0.87 jump were
rejected. Changes were made via targeted `npm update ... --package-lock-only`,
then the single reviewed override and a clean install.

## Production APK attack-surface assessment

Severity is the upstream advisory severity, not a conclusion about this app.
Source/caller inspection and the actual Android release Hermes export are used
separately from npm's dependency graph. The release source map contains 2,485
modules: among the 15 baseline High/Critical advisory-bearing package families,
only the patched Nanoid runtime appears. Remaining High roots (braces, image-size,
node-forge) have no modules in this JS export. query-string/decode-uri-component
remain bundled, so their Moderate risk is retained despite the qualified routing
analysis below. One Expo CLI Metro bootstrap module is bundled, illustrating why
whole-package labels alone cannot determine which code ships.

No confirmed Critical/High remote APK
exploit was established by this audit. This is not a blanket safety guarantee,
and does not cover Android/Maven/native libraries, platform vulnerabilities,
server-side opencode, or all application logic.

- **Critical `shell-quote` 1.8.3 / inherited `react-devtools-core` 6.1.5:** malicious
  object `.op` values can permit shell injection in callers that build and execute
  commands; later parsing DoS also exists. React Native loads DevTools only in
  development. The app's production HTTP/SSE messages are not shell-quoted or
  executed by this package. Patched to 1.12.0; DevTools version is unchanged.
  [Critical advisory](https://github.com/advisories/GHSA-w7jw-789q-3m8p),
  [parse DoS](https://github.com/advisories/GHSA-395f-4hp3-45gv).
- **Critical `tar` 7.5.15:** crafted archives target Node CLI/build workflows;
  Expo CLI uses it, the APK does not unpack npm tar archives. Patched to 7.5.22,
  also clearing the later High parsing/recursion findings.
  [Advisory](https://github.com/advisories/GHSA-23hp-3jrh-7fpw).
- **High `nanoid` 3.3.12:** this is real bundled runtime code, used by navigation,
  router and portals. The inspected callers use `nanoid()` with default size;
  no attacker-controlled zero/negative size was found. Still patched to 3.3.20
  in the compatible 3.x line.
  [Negative-size advisory](https://github.com/advisories/GHSA-28wg-ghj8-5hjv),
  [zero-size advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8).
- **High build/development families:** Babel/Browserslist, brace-expansion,
  XMLDOM, compression, js-yaml, PostCSS, source-map-js, undici and Node `ws`
  target build inputs, local dev servers, config files, source maps or Node
  networking. The mobile client uses React Native networking and native images;
  these Node packages are not evidence of the same APK attack surface. Compatible
  patched versions were selected where available. Keep dev servers private and
  avoid building untrusted branches/assets with privileged credentials.

### Remaining roots (7 GHSA URLs, 6 packages, 40 affected/inherited entries)

| Package/version | Severity | Why retained and what is actually exposed |
|---|---|---|
| braces 3.0.3 | High | Stack exhaustion from deeply nested glob patterns. No patched published version found; Metro/Jest build file matching, not chat input. Keep repository/config input trusted; revisit upstream fix. |
| image-size 1.2.1 | High (2 advisories) | Malformed JXL/HEIF/ICNS input can loop during asset processing. Patched 2.0.3 is outside Metro's 1.x range and changes its callable/path API. Remote chat images use native React Native Image, not this Node parser. Do not force 2.x without caller adaptation and asset regression coverage. |
| node-forge 1.4.0 | High | RSA signature verification accepts extra nested DigestAlgorithm elements. No patched published version found; Expo development/code-signing helper. This is not Android platform APK-signature verification. |
| decode-uri-component 0.2.2 | Moderate | Malformed percent strings cause exponential decoding. 0.5.0 is ESM-only while query-string 7.1.3 uses CommonJS require. Expo Router selects its fork using URLSearchParams; upstream navigation query-string fallback is not proven reachable in the current app. Reassess if routing configuration changes. |
| sprintf-js 1.0.3 | Moderate | Unbounded precision from attacker-controlled format strings; argparse/config tooling. Published 1.1.3 remains affected. No app-supplied format-string sink found. |
| uuid 7.0.3 | Moderate | v3/v5/v6 caller-buffer bounds issue; xcode tooling uses v4(), not those APIs. Fix starts 11.1.1, outside xcode's 7.x range. Avoid cross-major override for an unused vulnerable API. |

Sources: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[image-size JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq),
[image-size ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr),
[node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv),
[decode-uri-component](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr),
[sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c),
[uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

## Verification

- Baseline: version parity, TypeScript and all **353** existing unit tests passed.
- Changed tree: clean `npm ci --legacy-peer-deps --ignore-scripts --no-audit`,
  version parity and TypeScript passed; **360/360 tests passed**, including new
  PostCSS CommonJS/plugin/source-map tests, Nanoid default behavior, and audit
  summary error-handling tests. The scripts-disabled local install limits
  verification of lifecycle hooks; the APK CI jobs run normal `npm ci`.
- Android production export succeeded with source maps: 5.08 MB Hermes bundle
  and assets generated, exercising actual Metro/Babel/image asset processing.
  This is **not an APK compile or device E2E pass**.
- Full Android APK and F-Droid-flavored APK builds are independently verified by
  the PR's `Build Android APK` workflow (the F-Droid job is now enabled on PRs). Consult the PR check results
  for the exact head SHA; pending or failed CI must not be represented as passed.
- Deterministic Maestro tests are unchanged and their existing path filters do
  not trigger for dependency-only changes; no device E2E pass is claimed here.

Reproduce from the PR head:

```sh
npm ci --legacy-peer-deps
npm run check:versions
npm run typecheck
npm test
CI=1 EXPO_NO_TELEMETRY=1 npx expo export --platform android --source-maps --output-dir dist-audit
npm audit --json > npm-audit.json
npm audit --omit=dev --json > npm-audit-production.json
```

The two audit commands intentionally exit 1 while findings remain.
For APK builds, follow `.github/workflows/build.yml` (JDK17 standard build;
JDK17+21 and source patches for F-Droid). No release/store publishing or tag is
needed to verify a pull request.

## F-Droid / reproducibility impact

No native versions, source replacement files, Gradle targets, Firebase-removal
steps or install-referrer-removal steps change. Release signing configuration
is unchanged; newly enabled PR builds use debug signing only. The
non-publishing F-Droid CI still applies its existing source patches. Transitive
JS package bytes and the generated bundle do change; a new APK cannot be assumed
byte-identical to historical releases.

The build workflow now installs the committed lock with `npm ci`; this improves
repeatability but **does not prove byte-for-byte reproducibility**. The historical
submission metadata still targets upstream dzianisv v0.4.3/versionCode5 and uses
`npm install`. It has not been relabeled as a current fork submission. A future
F-Droid submission needs its own current commit/version/URLs, pinned toolchain,
matching lockfile install, clean rebuild and signature/reproducibility comparison.

The `build-fdroid` job creates the source-patched `app-release-fdroid.apk` artifact.
The separate `publish-fdroid.yml` publishes a full-feature APK to the upstream
self-hosted repository; it is a different path and was not run or modified here.

## Complete baseline inventory

`prod` below is the lockfile classification. Runtime reachability is discussed
above and must not be inferred from this column. Version lists include every
affected instance; raw JSON records the complete paths, advisory ranges/URLs and
inherited dependency chains. After versions for changed paths follow this table.

| Package | Affected locked version(s) before | npm severity before | Root relationship | npm class | After severity |
|---|---|---|---|---|---|
| @babel/core | 7.29.0 | high | transitive | prod | cleared |
| @babel/helper-compilation-targets | 7.28.6 | high | transitive | prod | cleared |
| @babel/helper-define-polyfill-provider | 0.6.8 | high | transitive | prod | cleared |
| @babel/plugin-transform-classes | 7.28.6 | high | transitive | prod | cleared |
| @babel/plugin-transform-function-name | 7.27.1 | high | transitive | prod | cleared |
| @babel/plugin-transform-object-rest-spread | 7.28.6 | high | transitive | prod | cleared |
| @babel/plugin-transform-runtime | 7.29.0 | high | transitive | prod | cleared |
| @expo/cli | 54.0.24 | high | transitive | prod | high |
| @expo/code-signing-certificates | 0.0.6 | high | transitive | prod | high |
| @expo/config | 12.0.13 | moderate | transitive | prod | moderate |
| @expo/config-plugins | 54.0.4 | moderate | transitive | prod | moderate |
| @expo/image-utils | 0.8.14 | low | transitive | prod | cleared |
| @expo/metro | 54.2.0 | high | transitive | prod | high |
| @expo/metro-config | 54.0.15 | high | transitive | prod | high |
| @expo/plist | 0.4.8 | moderate | transitive | prod | cleared |
| @expo/prebuild-config | 54.0.8 | moderate | transitive | prod | moderate |
| @expo/require-utils | 55.0.5 | low | transitive | prod | cleared |
| @expo/xcpretty | 4.4.4 | moderate | transitive | prod | cleared |
| @gorhom/bottom-sheet | 5.2.8 | high | direct | prod | cleared |
| @gorhom/portal | 1.0.14 | high | transitive | prod | cleared |
| @istanbuljs/load-nyc-config | 1.1.0 | moderate | transitive | prod | moderate |
| @jest/environment | 29.7.0 | high | transitive | prod | high |
| @jest/fake-timers | 29.7.0 | high | transitive | prod | high |
| @jest/transform | 29.7.0 | high | transitive | prod | high |
| @react-native/babel-plugin-codegen | 0.81.5 | low | transitive | prod | cleared |
| @react-native/babel-preset | 0.81.5 | high | transitive | prod | cleared |
| @react-native/codegen | 0.81.5 | high | transitive | prod | cleared |
| @react-native/community-cli-plugin | 0.81.5 | high | transitive | prod | high |
| @react-native/dev-middleware | 0.81.5 | high | transitive | prod | cleared |
| @react-navigation/core | 7.17.4 | high | transitive | prod | moderate |
| @react-navigation/native | 7.2.4 | high | direct | prod | cleared |
| @react-navigation/routers | 7.5.5 | high | transitive | prod | cleared |
| @xmldom/xmldom | 0.8.13, 0.9.10 | high | transitive | prod | cleared |
| argparse | 1.0.10 | moderate | transitive | prod | moderate |
| babel-jest | 29.7.0 | low | transitive | prod | high |
| babel-plugin-istanbul | 6.1.1 | high | transitive | prod | moderate |
| babel-plugin-polyfill-corejs2 | 0.4.17 | high | transitive | prod | cleared |
| babel-plugin-polyfill-corejs3 | 0.13.0 | high | transitive | prod | cleared |
| babel-plugin-polyfill-regenerator | 0.6.8 | high | transitive | prod | cleared |
| babel-preset-expo | 54.0.10 | high | transitive | prod | cleared |
| baseline-browser-mapping | 2.10.30 | moderate | transitive | prod | cleared |
| brace-expansion | 1.1.14, 2.1.0, 5.0.6 | high | transitive | prod | cleared |
| braces | 3.0.3 | high | transitive | prod | high |
| browserslist | 4.28.2 | high | transitive | prod | cleared |
| chromium-edge-launcher | 0.2.0 | high | transitive | prod | cleared |
| compression | 1.8.1 | high | transitive | prod | cleared |
| core-js-compat | 3.49.0 | high | transitive | prod | cleared |
| decode-uri-component | 0.2.2 | moderate | transitive | prod | moderate |
| expo | 54.0.34 | high | direct | prod | high |
| expo-asset | 12.0.13 | moderate | transitive | prod | moderate |
| expo-constants | 18.0.13 | moderate | transitive | prod | moderate |
| expo-linking | 8.0.12 | moderate | direct | prod | moderate |
| expo-notifications | 0.32.17 | moderate | direct | prod | moderate |
| expo-router | 6.0.23 | high | direct | prod | moderate |
| glob | 7.2.3 | high | transitive | prod | cleared |
| image-size | 1.2.1 | high | transitive | prod | high |
| istanbul-lib-instrument | 5.2.1 | low | transitive | prod | cleared |
| jest-environment-node | 29.7.0 | high | transitive | prod | high |
| jest-haste-map | 29.7.0 | high | transitive | prod | high |
| jest-message-util | 29.7.0 | high | transitive | prod | high |
| js-yaml | 3.14.2, 4.1.1 | high | transitive | prod | moderate |
| metro | 0.83.3 | high | transitive | prod | high |
| metro-babel-transformer | 0.83.3 | low | transitive | prod | cleared |
| metro-config | 0.83.3 | low | transitive | prod | high |
| metro-file-map | 0.83.3 | high | transitive | prod | high |
| metro-transform-plugins | 0.83.3 | low | transitive | prod | cleared |
| metro-transform-worker | 0.83.3 | low | transitive | prod | high |
| micromatch | 4.0.8 | high | transitive | prod | high |
| minimatch | 3.1.5 | high | transitive | prod | cleared |
| nanoid | 3.3.12 | high | transitive | prod | cleared |
| node-forge | 1.4.0 | high | transitive | prod | high |
| plist | 3.1.1 | moderate | transitive | prod | cleared |
| postcss | 8.4.49 | high | transitive | prod | cleared |
| query-string | 7.1.3 | moderate | transitive | prod | moderate |
| react-devtools-core | 6.1.5 | critical | transitive | prod | cleared |
| react-native | 0.81.5 | high | direct | prod | high |
| react-native-worklets | 0.5.1 | high | direct | prod | cleared |
| rimraf | 3.0.2 | high | transitive | prod | cleared |
| shell-quote | 1.8.3 | critical | transitive | prod | cleared |
| simple-plist | 1.3.1 | moderate | transitive | prod | cleared |
| source-map-js | 1.2.1 | high | transitive | prod | cleared |
| sprintf-js | 1.0.3 | moderate | transitive | prod | moderate |
| tar | 7.5.15 | critical | transitive | prod | cleared |
| test-exclude | 6.0.0 | high | transitive | prod | cleared |
| undici | 6.25.0 | high | transitive | prod | cleared |
| uuid | 7.0.3 | moderate | transitive | prod | moderate |
| ws | 6.2.3, 7.5.10, 8.20.1 | high | transitive | prod | cleared |
| xcode | 3.0.1 | moderate | transitive | prod | moderate |

## Exact lockfile version changes

| Installed path | Before | After |
|---|---|---|
| `node_modules/@babel/code-frame` | 7.29.0 | 7.29.7 |
| `node_modules/@babel/compat-data` | 7.29.3 | 7.29.7 |
| `node_modules/@babel/core` | 7.29.0 | 7.29.7 |
| `node_modules/@babel/generator` | 7.29.1 | 7.29.8 |
| `node_modules/@babel/helper-compilation-targets` | 7.28.6 | 7.29.7 |
| `node_modules/@babel/helper-globals` | 7.28.0 | 7.29.7 |
| `node_modules/@babel/helper-module-imports` | 7.28.6 | 7.29.7 |
| `node_modules/@babel/helper-module-transforms` | 7.28.6 | 7.29.7 |
| `node_modules/@babel/helper-string-parser` | 7.27.1 | 7.29.7 |
| `node_modules/@babel/helper-validator-identifier` | 7.28.5 | 7.29.7 |
| `node_modules/@babel/helper-validator-option` | 7.27.1 | 7.29.7 |
| `node_modules/@babel/helpers` | 7.29.2 | 7.29.10 |
| `node_modules/@babel/parser` | 7.29.3 | 7.29.9 |
| `node_modules/@babel/template` | 7.28.6 | 7.29.7 |
| `node_modules/@babel/traverse` | 7.29.0 | 7.29.10 |
| `node_modules/@babel/types` | 7.29.0 | 7.29.8 |
| `node_modules/@expo/xcpretty/node_modules/js-yaml` | 4.1.1 | 4.3.2 |
| `node_modules/@react-native/codegen/node_modules/brace-expansion` | 1.1.14 | 1.1.21 |
| `node_modules/@react-native/dev-middleware/node_modules/ws` | 6.2.3 | 6.2.6 |
| `node_modules/@xmldom/xmldom` | 0.8.13 | 0.8.15 |
| `node_modules/baseline-browser-mapping` | 2.10.30 | 2.11.27 |
| `node_modules/brace-expansion` | 5.0.6 | 5.0.12 |
| `node_modules/browserslist` | 4.28.2 | 4.29.3 |
| `node_modules/caniuse-lite` | 1.0.30001793 | 1.0.30001815 |
| `node_modules/compression` | 1.8.1 | 1.8.2 |
| `node_modules/electron-to-chromium` | 1.5.357 | 1.5.451 |
| `node_modules/expo/node_modules/brace-expansion` | 2.1.0 | 2.1.7 |
| `node_modules/expo/node_modules/ws` | 8.20.1 | 8.22.0 |
| `node_modules/js-yaml` | 3.14.2 | 3.15.2 |
| `node_modules/nanoid` | 3.3.12 | 3.3.20 |
| `node_modules/node-releases` | 2.0.44 | 2.0.58 |
| `node_modules/plist/node_modules/@xmldom/xmldom` | 0.9.10 | 0.9.12 |
| `node_modules/postcss` | 8.4.49 | 8.5.23 |
| `node_modules/react-native/node_modules/brace-expansion` | 1.1.14 | 1.1.21 |
| `node_modules/react-native/node_modules/ws` | 6.2.3 | 6.2.6 |
| `node_modules/rimraf/node_modules/brace-expansion` | 1.1.14 | 1.1.21 |
| `node_modules/shell-quote` | 1.8.3 | 1.12.0 |
| `node_modules/source-map-js` | 1.2.1 | 1.2.2 |
| `node_modules/tar` | 7.5.15 | 7.5.22 |
| `node_modules/test-exclude/node_modules/brace-expansion` | 1.1.14 | 1.1.21 |
| `node_modules/undici` | 6.25.0 | 6.29.0 |
| `node_modules/update-browserslist-db` | 1.2.3 | 1.3.4 |
| `node_modules/ws` | 7.5.10 | 7.5.13 |
