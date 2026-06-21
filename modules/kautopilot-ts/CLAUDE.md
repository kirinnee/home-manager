# kautopilot-ts

## Runtime: dynamic (`bun run` from source)

This app is **not built into Nix**. Home Manager installs only a thin wrapper
that runs `bun run …/kautopilot-ts/src/index.ts`, so:

- **Edits to `src/` apply immediately** — no `hms`/rebuild needed.
- There is **no `node_modules` in the repo**. Bun auto-installs dependencies into
  its global cache (`~/.bun/install/cache`) on first run.
- ⚠️ **Do not commit or leave a `node_modules/` here.** A local `node_modules`
  gets copied into the Nix store on every `hms` and makes rebuilds slow. If you
  run `bun install`, delete `node_modules` afterward — the global cache stays
  warm, so the app keeps working.

## Post-test cleanup

After running tests (`bun test`, `vitest run`, etc.), clean up leftover test session dirs from `~/.kautopilot/`:

```bash
# Remove test-* directories
find ~/.kautopilot -maxdepth 1 -type d -name 'test-*' -exec rm -rf {} +

# Remove 8-char session dirs with only logs/ (no status.yaml = abandoned init)
for d in ~/.kautopilot/[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]/; do
  [ -f "$d/status.yaml" ] || rm -rf "$d"
done

# Remove orphaned init dirs with only logs/
for d in ~/.kautopilot/init/*/; do
  contents=$(ls -A "$d" 2>/dev/null)
  [ "$contents" = "logs" ] && rm -rf "$d"
done
```
