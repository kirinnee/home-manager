# kautopilot-ts

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
