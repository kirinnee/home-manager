# Home Manager Configurations

My personal [home-manager](https://github.com/nix-community/home-manager) configurations, which include ZSH plugins, configurations and basic binaries used for development.

## Bun CLIs run dynamically (`bun run` from source)

The in-repo Bun CLIs — **`kautopilot`** (`modules/kautopilot-ts`), **`kloop`**
(`modules/kloop-ts`), **`khost`** (`modules/khost-ts`) — and the external
**`loctl`** are installed as thin `bun run` wrappers that execute the
TypeScript source directly. None of them are built into Nix.

Why: each app's `node_modules` (~280 MB total) was being copied into the Nix
store on every `hms`, and `loctl` was a `path:` flake input that copied its
whole 328 MB checkout. That pushed rebuilds to ~2.5 min. Running from source
dropped eval to ~25s.

Rules to keep it fast:

- ⚠️ **Never commit or leave a `node_modules/` inside any of these app dirs.**
  Bun auto-installs deps into its global cache (`~/.bun/install/cache`) on first
  run. If you `bun install` for local tooling, delete `node_modules` afterward.
- Source edits take effect immediately — no rebuild needed.
- `loctl` is run from its checkout at `/Users/erng/Workspace/work/vungle/loctl`
  (no longer a flake input).

## Setup New Box

Install Basic Dependencies: Nix, Home Manager, and basic applications
```
curl -L https://raw.githubusercontent.com/kirinnee/home-manager/main/scripts/setup.sh | bash
```

## AutoBackup CLI

Within this home-manager, I created a CLI that helps me backup folders to pCloud itself.

1. `backup-pcloud`
   With an rclone `pcloud` remote configured, you can backup any directory to pCloud's Backup folder:

   ```bash
   backup-pcloud backup ./Workspace desktop1 # => tarballs ./Workspace and send to pClouds's Backup/desktop1 folder
   backup-pcloud backup /home/kirin remote/devbox1 # => tarball /home/kirin and send to pCloud's Backup/remote/devbox1 folder
   ```

2. Restoring
   If you have backed up before, you can easily restore the latest backup with the follow command:
   ```bash
   backup-pcloud restore ./Workspace desktop1 # restores the first commnad previously
   backup-pcloud restore /home/kirin remote/devobx1 # restores the second command previously
   ```

#### Crontab

You can setup auto-backup with cron:

```bash
crontab -e
0 0 * * * sudo -u kirin bash -i -c 'pcloud-backup backup Workspace devbox'
```
