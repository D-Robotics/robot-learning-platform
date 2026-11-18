# Temporary picomatch security patch

This private, development-only fork is picomatch 4.0.7 (MIT), with the code change from upstream pull request [#237](https://github.com/micromatch/picomatch/pull/237), commit `1bf0d04563cb9ce568cf36efc5f6b7187d9911d5`, applied to `lib/parse.js`. The pull request was still unmerged and npm had no patched release when adopted. This is a reviewed local patch, not an official fixed release.

The change collapses a single repeated branch containing a self-repeating star instead of emitting nested unbounded quantifiers. It addresses the single-branch ReDoS cases in [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). Normal glob contracts and the upstream explicit `maxExtglobRecursion: false` opt-out are preserved. This is not a general guarantee that arbitrary regular expressions or an explicit safeguard opt-out are safe.

The original `lib/parse.js` SHA-256 is `4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4`. All remaining runtime files and the MIT license are unchanged from the npm package. The manifest uses the explicit `4.0.7-rdk.1` version and `private: true`; upstream development scripts and development dependencies are omitted from this runtime-only snapshot.

`npm run verify:dependency-security` tests installed transitive resolution, bounded child-process adversarial inputs, and normal glob semantics. It is part of `verify:security`; ordinary npm audit thresholds are unchanged. The fork is absent from production-only installs. Replace the file dependency and override with an official patched release when one is available, then rerun these regressions and the complete CI matrix.
