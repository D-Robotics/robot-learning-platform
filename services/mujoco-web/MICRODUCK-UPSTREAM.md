# Microduck upstream

The production browser simulator is built from the public Pollen Robotics
repository at commit `1261013e7e28ba2a6878bd76ae573751c0e4b457`.

- Simulator: https://github.com/pollen-robotics/microduck-simulator
- Robot model and runtime: https://github.com/pollen-robotics/microduck
- RL policies and training assets: https://github.com/pollen-robotics/microduck_rl
- Public demo: https://huggingface.co/spaces/pollen-robotics/microduck-simulator

The upstream repositories' license and model-file terms apply to the
corresponding static assets. Do not add arbitrary model or code uploads to the
public route.

The hosted build applies one integration fix in `app/src/game/duck.js`: the
upstream absolute STL directory is resolved against the page URL so roller
assets work under `/mujoco/microduck/`.

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

If the upstream release is built from source instead of an archive, pin the
repositories above to `1261013e7e28ba2a6878bd76ae573751c0e4b457`, follow each
upstream repository's documented build, and store the resulting build log and
digest alongside the release. The static bundle's own license and attribution
files must remain in the release; the platform cannot infer or replace them.
