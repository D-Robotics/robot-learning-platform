# Microduck upstream

The browser simulator is supplied as an immutable, reviewed Pollen Robotics
release. Its source revision and complete asset digests are recorded in
[`microduck-browser-runtime.lock.json`](./microduck-browser-runtime.lock.json); the deployed directory must pass
`MICRODUCK_REQUIRE_NETWORK_BOUNDARY=1 npm run verify:microduck-browser-runtime`
after the overlay installer and before a current-link switch.

- Simulator: https://github.com/pollen-robotics/microduck-simulator
- Robot model and runtime: https://github.com/pollen-robotics/microduck
- RL policies and training assets: https://github.com/pollen-robotics/microduck_rl
- Public demo: https://huggingface.co/spaces/pollen-robotics/microduck-simulator

The upstream repositories' license and model-file terms apply to the
corresponding static assets. Do not add arbitrary model or code uploads to the
public route.

The static release must support the mounted `/mujoco/microduck/` route and
expose the documented `window.rl` controller interface, including the native
custom-policy loader and restore operation. A functioning recorder alone does
not prove that policy loading is supported. Preserve all upstream attribution,
license, and model-file terms when replacing a release.

## Release acquisition and verification

The public repository intentionally does not redistribute the upstream static
bundle. A deployment owner must obtain a release through the upstream project
or an approved internal mirror, record the exact source commit and archive
digest, and only then copy it into the serving directory. The release root
must contain `index.html`.

Example of the verification hand-off (the archive and digest are supplied by
the release owner, not by a browser request):

```bash
set -euo pipefail
MICRODUCK_RELEASE_ARCHIVE=/srv/releases/microduck-simulator-approved.tar.gz
: "${MICRODUCK_RELEASE_SHA256:?set the approved archive SHA-256 before continuing}"
printf '%s  %s\n' "$MICRODUCK_RELEASE_SHA256" "$MICRODUCK_RELEASE_ARCHIVE" | sha256sum -c -
tar -tzf "$MICRODUCK_RELEASE_ARCHIVE" | grep -E '(^|/)index\.html$' >/dev/null
install -d /srv/releases/microduck-simulator-approved
tar -xzf "$MICRODUCK_RELEASE_ARCHIVE" \
  --directory /srv/releases/microduck-simulator-approved --strip-components=1
test -s /srv/releases/microduck-simulator-approved/index.html
```

If the upstream release is built from source instead of an archive, use the
reviewed source revision recorded in the runtime lock, follow the upstream
repository's documented build, and store the resulting build log and digest
alongside the release. A new upstream revision requires a reviewed lock update
and a fresh runtime compatibility check; do not replace assets in place. The
static bundle's own license and attribution
files must remain in the release; the platform cannot infer or replace them.
