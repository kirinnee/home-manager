# Maintained CLIProxyAPI model-catalog fork

This directory builds a local CLIProxyAPI image without requiring a separate
GitHub fork. `build.sh` clones the immutable upstream source recorded in
`upstream.env`, verifies the commit, upserts `models.overlay.json` by model ID,
applies the pinned patches under `patches/`, and builds the upstream Dockerfile
as `kloge-cliproxy:patched`.

The overlay changes only the embedded
`internal/registry/models/models.json`. Runtime must use `--local-model`, or a
remote catalog refresh can replace the patched catalog. kloge defaults to this
image and adds that command automatically when it renders the compose file.

`patches/0001-management-model-states.patch` adds a redacted `model_states`
projection to the existing authenticated `GET /v0/management/auth-files`
response. Upstream's aggregate `unavailable` flag cannot prove that a specific
model is down because its model-state map is sparse. The projection exposes only
selection state, deadlines, quota booleans, and machine-readable error codes;
it never exposes credential data or free-form error messages. kfleet uses it to
exclude a wrapper only when every enabled credential is blocked for that
wrapper's primary model.

Build and render the default image:

```bash
kloge build
kloge render
kloge up
```

The build command does not render, restart, or otherwise touch a running kloge
service. `KLOGE_IMAGE=eceasy/cli-proxy-api:latest kloge render` is the explicit
rollback path when the maintained image cannot be used.

To add another model, add one JSON block to the matching provider array in
`models.overlay.json` and rebuild. The build replaces an existing object with
the same ID, so it stays safe when upstream later ships that model itself. To
bump CLIProxyAPI, update the ref, immutable commit, and release date in
`upstream.env`, then rebase every patch. The build verifies the ref, validates
the merged catalog, and fails loudly when a patch no longer applies.

The patched image is local to the Docker host. `kloge push` does not transfer
Docker images, so build the same tag on a remote host before rendering/pushing
a compose file that selects it.
