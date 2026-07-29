# Two-level cgroup caps

## Goals and boundaries

Kteam agents run in tmux panes, but the tmux server and `kteamd` are control-plane
processes. The caps must contain only agent workloads. The existing
`kteamd.service` remains unchanged, including its load-bearing
`KillMode=process`.

This design targets Linux with a systemd user manager and cgroup v2. macOS keeps
the launch path unchanged and reports cgroups as unsupported.

## Layout

```text
user@UID.service
├── app.slice/kteamd.service              kteamd (never capped here)
├── app.slice/tmux-spawn-*.scope          tmux server/control processes
└── kteam.slice/kteam-fleet.slice         fleet aggregate cap
    ├── kteam-agent-<id>-<nonce>.scope    one agent cap
    ├── kteam-agent-<id>-<nonce>.scope    one agent cap
    └── ...
```

`systemd-run --user --scope` is executed by the generated pane `launch.sh`
immediately before the harness. The tmux pane begins in tmux's own spawn scope;
`systemd-run` moves the launcher/harness process tree into a child of
`kteam-fleet.slice`. The daemon never invokes itself through that wrapper, so
its `/proc/<pid>/cgroup` path remains outside the fleet slice.

Scope names include a nonce. This avoids a relaunch racing a previous transient
scope that is still deactivating. `--collect` removes a scope after its agent
exits. Running scopes are discovered from the pane PID's cgroup path rather than
by reconstructing the nonce.

## Settings schema

The existing `~/.kteam/daemon/config.json` gains one deep-merged block:

```json
{
  "cgroups": {
    "enabled": true,
    "fleet": {
      "cpuPercent": 90,
      "memoryPercent": 90
    },
    "perAgent": {
      "cpuPercent": 25,
      "memoryPercent": 25
    }
  }
}
```

Percentages are shares of host capacity, not systemd's one-core percentage:

- `cpuPercent: 90` on an 8-CPU host becomes `CPUQuota=720%`.
- `memoryPercent: 90` on a 32 GiB host becomes a `MemoryMax` byte value near
  28.8 GiB.

The per-agent defaults allow at most 25% of the host to one runaway agent while
the parent still bounds the sum at 90%. Values must be finite and in `(0, 100]`;
each per-agent value must not exceed its fleet counterpart.

The block is configurable through the daemon's existing authenticated settings
mechanism: daemon config JSON, a GET/PATCH API, and a `kteam cgroups config
[set]` CLI surface. No second config file is introduced.

Linux defaults the feature on. Non-Linux defaults it off so launchd systems do
not opt into a facility they cannot provide.

## Apply and restart semantics

Enabling or changing limits:

1. Persist the validated settings in the existing daemon config.
2. Apply the fleet slice properties with
   `systemctl --user set-property --runtime kteam-fleet.slice`.
3. Find each live pane's `kteam-agent-*.scope` from `/proc/<pane-pid>/cgroup`
   and hot-apply the per-agent properties with `systemctl set-property`.
4. Report any running pane that is not already in a kteam agent scope as
   `restartRequired`; it cannot be safely adopted by the user manager after it
   was launched. New/relaunched panes use the new settings.

Config changes share the same serialization barrier as pane bootstrap. A PATCH
therefore cannot inspect the fleet in the gap between choosing a direct/scoped
launch command and tmux creating that pane. Concurrent PATCH requests are also
ordered against one another.

CPU quota and memory max changes are therefore hot for already-managed agents.
Lowering `MemoryMax` below an agent's working set can make the kernel reclaim or
OOM that agent; the API/CLI reports the applied value rather than pretending the
change is harmless.

At daemon boot, fleet-slice preparation is started without putting `kteamd`
inside it. An enabled agent launch waits for successful preparation. Failure to
reach the user manager fails that agent launch clearly but leaves the daemon/API
serviceable.

Disabling:

- New and relaunched panes bypass `systemd-run` completely; the generated
  launcher directly `exec`s the harness.
- No `CPUQuota=infinity` or `MemoryMax=infinity` writes are used.
- Already-running managed agents cannot be safely reparented, so they retain
  their current caps and are returned as `restartRequired`. Restarting those
  agents removes the old transient scopes and launches them through the direct
  path. This is intentionally explicit instead of silently claiming a live
  disable.
- If a pane's cgroup placement cannot be read, its state is unknown rather than
  assumed uncapped. The response includes a warning and conservatively reports
  that session as `restartRequired`.

## Tests and live verification

Fixture tests inject the command runner, host CPU/RAM capacity, platform, pane
PID lookup, and `/proc` reads. They prove:

- percentage-to-systemd conversion;
- the disabled path returns the original command and performs no manager call;
- enabled launches use one child scope under the fleet slice with both caps;
- fleet and existing per-agent updates issue the expected hot-apply commands;
- unmanaged running panes are reported as restart-required;
- an unreadable cgroup is warning + restart-required, including while disabling;
- a settings PATCH waits for an in-flight pane bootstrap;
- a daemon cgroup outside the fleet slice is recognized as outside.

`verify-cgroups.sh` uses uniquely named throwaway user units and cleans them in a
trap. It demonstrates real cgroup-v2 placement/properties, checks the live
daemon's cgroup is outside the tested fleet slice, and exercises the
implementation's disabled bypass. It does not mutate `kteamd.service` or the
real `kteam-fleet.slice`.
