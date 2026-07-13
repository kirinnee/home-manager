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

### Provision a box on AWS / DigitalOcean / OCI

One command creates the VM (OpenTofu, `infra/<cloud>/`), waits for SSH, and
replicates everything onto it:

```bash
pls box:up -- aws --replicate            # or: digitalocean | oci
pls box:down -- aws                      # destroy it again
```

All three clouds get the SAME setup: x86_64 Ubuntu 24.04, the shared
`infra/cloud-init.yaml.tftpl` first-boot config (creates user `kirin` with the
sops SSH key), SSH-only ingress, and the same `public_ip`/`user` outputs.
Credentials live in sops under `.box.clouds.<cloud>` in `secrets.yaml`
(placeholders are pre-seeded — fill in the ones for the cloud you use):

| cloud          | keys                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `aws`          | `access_key_id`, `secret_access_key`, `region`                                              |
| `digitalocean` | `token`, `region`                                                                            |
| `oci`          | `tenancy_ocid`, `user_ocid`, `fingerprint`, `private_key`, `compartment_ocid`, `region`      |

Tofu state is local and **gitignored** — bring a box down from the same
machine that brought it up.

### One-command remote replication

Already have a box (any VM created with `cloud-init.yaml`)? Replicate this
WHOLE home-manager onto it and clone the Workspace repos, from this machine:

```bash
./scripts/box/replicate.sh kirin@<box-ip>          # or: pls box:replicate -- kirin@<box-ip>
```

It runs three steps:

1. Seeds your local age key (`~/.config/sops/age/keys.txt`) onto the box — the
   only secret pushed over the wire.
2. Runs `scripts/setup.sh` remotely: installs Nix, clones this repo, and
   `home-manager switch --flake .#<profile>` (profile defaults to the remote
   user; the Linux box profile is `kirin`). The `load-secrets` activation step
   decrypts `secrets.enc.yaml` on the box and materializes the SSH keys +
   `github-*` ssh aliases.
3. Runs `scripts/box/clone-stuff.sh` remotely: clones every repo in the
   sops-encrypted manifest into `~/Workspace`, using those sops-provided keys.

The repo manifest lives INSIDE sops (`.box.repos` in `secrets.yaml`) because
this repo is public. Refresh it from your local `~/Workspace` with
`./scripts/box/gen-repos.sh`, then re-encrypt.

## Secrets workflow (SOPS + age)

`secrets.enc.yaml` (committed) ⇄ `secrets.yaml` (gitignored working copy).
Work on the **decrypted** file; encrypt only before committing:

```bash
pls secret:decrypt   # only decrypts if secrets.yaml does NOT exist (never overwrites)
# ... edit secrets.yaml directly ...
pls secret:encrypt   # re-encrypts into secrets.enc.yaml (skips if already in step)
```

The `a-secrets-sync` pre-commit hook blocks any commit while `secrets.yaml`
holds edits that haven't been re-encrypted, so drift can't slip into git.

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
