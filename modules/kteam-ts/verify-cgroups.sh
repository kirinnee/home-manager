#!/usr/bin/env bash
# shellcheck disable=SC2016  # bun -e scripts are deliberately single-quoted
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ${KTEAM_CGROUP_VERIFY_ENV:-} != 1 ]]; then
  export KTEAM_CGROUP_VERIFY_ENV=1
  exec direnv exec "${KTEAM_DIRENV_ROOT:-$repo_dir}" "$0" "$@"
fi

cd "$repo_dir"
unique="${$}-$(date +%s)"
fleet_slice="kteam-verify-${unique}.slice"
verify_parent="kteam-verify-${$}.slice"
agent_id="verify-${unique}"
agent_scope="kteam-agent-${agent_id}-live.scope"

cleanup() {
  systemctl --user stop "$agent_scope" "$fleet_slice" "$verify_parent" >/dev/null 2>&1 || true
  systemctl --user revert "$fleet_slice" "$verify_parent" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$agent_scope" "$fleet_slice" "$verify_parent" >/dev/null 2>&1 || true
  # systemd materializes the shared kteam-verify.slice ancestor for dashed
  # throwaway names. Remove it only when no other verifier child is active.
  if ! systemctl --user list-units --plain --no-legend 'kteam-verify-*.slice' 2>/dev/null | grep -q .; then
    systemctl --user stop kteam-verify.slice >/dev/null 2>&1 || true
    systemctl --user reset-failed kteam-verify.slice >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ "$(uname -s)" == Linux ]] || {
  echo "SKIP: Linux is required"
  exit 0
}
[[ -e /sys/fs/cgroup/cgroup.controllers ]] || {
  echo "FAIL: cgroup v2 is not mounted" >&2
  exit 1
}
systemctl --user show-environment >/dev/null

echo "== enabled: implementation creates a capped child scope =="
KTEAM_VERIFY_SLICE="$fleet_slice" KTEAM_VERIFY_SCOPE="$agent_scope" KTEAM_VERIFY_ID="$agent_id" \
  bun -e '
    import { CgroupController } from "./src/cgroups.ts";
    const fleetSlice = process.env.KTEAM_VERIFY_SLICE;
    const scope = process.env.KTEAM_VERIFY_SCOPE;
    const sessionId = process.env.KTEAM_VERIFY_ID;
    if (!fleetSlice || !scope || !sessionId) throw new Error("verification unit names are missing");
    const cpus = Math.max(1, navigator.hardwareConcurrency);
    const controller = new CgroupController(
      {
        enabled: true,
        fleet: { cpuPercent: 50, memoryPercent: 5 },
        perAgent: { cpuPercent: 25, memoryPercent: 2 },
      },
      { platform: "linux", fleetSlice, nonce: () => "live" },
    );
    const expectedScope = `kteam-agent-${sessionId}-live.scope`;
    if (scope !== expectedScope) throw new Error(`scope mismatch: ${scope}`);
    const view = await controller.describe();
    const expectedAgentCpuUsec = Number.parseInt(view.effective.perAgent.cpuQuota, 10) * 10_000;
    const expectedFleetCpuUsec = Number.parseInt(view.effective.fleet.cpuQuota, 10) * 10_000;
    const humanTimespan = (usec) => {
      const result = Bun.spawnSync(["systemd-analyze", "timespan", `${usec}us`]);
      const output = new TextDecoder().decode(result.stdout);
      const human = output.match(/^\s*Human:\s*(.+)$/m)?.[1]?.trim();
      if (result.exitCode !== 0 || !human) throw new Error(`could not format systemd timespan ${usec}us`);
      return human;
    };
    const parseProperties = (value) =>
      Object.fromEntries(
        value
          .trim()
          .split("\n")
          .filter(line => line.includes("="))
          .map(line => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    const command = await controller.agentCommand(sessionId, [
      "sh",
      "-c",
      `echo process-cgroup:; cat /proc/self/cgroup; echo scope-properties:; systemctl --user show ${scope} -p Slice -p CPUQuotaPerSecUSec -p MemoryMax -p ControlGroup`,
    ]);
    console.log(`host-cpus=${cpus}`);
    const child = Bun.spawn(command, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (code !== 0) process.exit(code);
    const processCgroup = stdout.split("\n").find(line => line.startsWith("0::/"));
    if (!processCgroup?.includes(`/${fleetSlice}/${scope}`))
      throw new Error(`agent was not placed below ${fleetSlice}: ${processCgroup ?? "missing cgroup"}`);
    const scopeProperties = parseProperties(stdout.split("scope-properties:\n")[1] ?? "");
    if (scopeProperties.Slice !== fleetSlice) throw new Error(`scope Slice=${scopeProperties.Slice}`);
    if (scopeProperties.CPUQuotaPerSecUSec !== humanTimespan(expectedAgentCpuUsec))
      throw new Error(
        `scope CPUQuotaPerSecUSec=${scopeProperties.CPUQuotaPerSecUSec}, expected ${humanTimespan(expectedAgentCpuUsec)}`,
      );
    if (Number(scopeProperties.MemoryMax) !== Number(view.effective.perAgent.memoryMax))
      throw new Error(`scope MemoryMax=${scopeProperties.MemoryMax}, expected ${view.effective.perAgent.memoryMax}`);

    const fleetShow = Bun.spawnSync([
      "systemctl",
      "--user",
      "show",
      fleetSlice,
      "-p",
      "CPUQuotaPerSecUSec",
      "-p",
      "MemoryMax",
      "-p",
      "LoadState",
    ]);
    process.stdout.write("fleet-properties:\n");
    process.stdout.write(fleetShow.stdout);
    process.stderr.write(fleetShow.stderr);
    if (fleetShow.exitCode !== 0) process.exit(fleetShow.exitCode);
    const fleetProperties = parseProperties(new TextDecoder().decode(fleetShow.stdout));
    if (fleetProperties.LoadState !== "loaded") throw new Error(`fleet LoadState=${fleetProperties.LoadState}`);
    if (fleetProperties.CPUQuotaPerSecUSec !== humanTimespan(expectedFleetCpuUsec))
      throw new Error(
        `fleet CPUQuotaPerSecUSec=${fleetProperties.CPUQuotaPerSecUSec}, expected ${humanTimespan(expectedFleetCpuUsec)}`,
      );
    if (Number(fleetProperties.MemoryMax) !== Number(view.effective.fleet.memoryMax))
      throw new Error(`fleet MemoryMax=${fleetProperties.MemoryMax}, expected ${view.effective.fleet.memoryMax}`);
    console.log("PASS: observed fleet and agent placement/properties match the configured caps");
  '

echo "== daemon remains outside the tested fleet slice =="
daemon_pid="$(systemctl --user show kteamd.service -p MainPID --value 2>/dev/null || true)"
if [[ ! $daemon_pid =~ ^[1-9][0-9]*$ ]]; then
  daemon_pid="$(sed -n '1p' "${KTEAM_HOME:-$HOME/.kteam}/daemon/pid" 2>/dev/null || true)"
fi
if [[ $daemon_pid =~ ^[1-9][0-9]*$ ]] && [[ -r "/proc/$daemon_pid/cgroup" ]]; then
  daemon_cgroup="$(<"/proc/$daemon_pid/cgroup")"
  echo "$daemon_cgroup"
  if grep -Fq "/$fleet_slice" <<<"$daemon_cgroup"; then
    echo "FAIL: kteamd is inside the fleet slice" >&2
    exit 1
  fi
  echo "PASS: kteamd is outside the fleet cap"
else
  echo "SKIP: no live kteamd PID found (placement check requires a running daemon)"
fi

echo "== disabled: implementation bypasses systemd-run and manager calls =="
bun -e '
  import { CgroupController } from "./src/cgroups.ts";
  let calls = 0;
  const controller = new CgroupController(
    {
      enabled: false,
      fleet: { cpuPercent: 90, memoryPercent: 90 },
      perAgent: { cpuPercent: 25, memoryPercent: 25 },
    },
    {
      platform: "linux",
      runner: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "must not run" };
      },
    },
  );
  const direct = ["sh", "-c", "true"];
  const result = await controller.agentCommand("verify-disabled", direct);
  if (result !== direct || calls !== 0) throw new Error("disabled path did not bypass cgroup setup");
  console.log("PASS: direct argv returned; zero systemd calls");
'

echo "PASS: live cgroup verification completed; throwaway units will be removed"
