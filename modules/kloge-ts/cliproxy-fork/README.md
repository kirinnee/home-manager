# Maintained CLIProxyAPI model-catalog fork

This directory builds a local CLIProxyAPI image without requiring a separate
GitHub fork. `build.sh` clones the immutable upstream source recorded in
`upstream.env`, verifies the commit, upserts `models.overlay.json` by model ID,
and builds the upstream Dockerfile as `kloge-cliproxy:patched`.

The overlay changes only the embedded
`internal/registry/models/models.json`. Runtime must use `--local-model`, or a
remote catalog refresh can replace the patched catalog. kloge adds that command
automatically when `KLOGE_IMAGE=kloge-cliproxy:patched` is rendered.

Build and opt in:

```bash
kloge build
KLOGE_IMAGE=kloge-cliproxy:patched kloge render
kloge up
```

The build command does not render, restart, or otherwise touch a running kloge
service. The image remains opt-in; without `KLOGE_IMAGE`, kloge continues to
render `eceasy/cli-proxy-api:latest` with its normal pull behavior.

To add another model, add one JSON block to the matching provider array in
`models.overlay.json` and rebuild. The build replaces an existing object with
the same ID, so it stays safe when upstream later ships that model itself. To
bump CLIProxyAPI, update the ref, immutable commit, and release date in
`upstream.env`; the build verifies the ref and validates the merged catalog.

The patched image is local to the Docker host. `kloge push` does not transfer
Docker images, so build the same tag on a remote host before rendering/pushing
a compose file that selects it.
