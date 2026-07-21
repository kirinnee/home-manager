// `khost init` — scaffold ~/.khost/config.yaml + ~/.khost/alloy.alloy. Run once
// after install; edit the two files, then `khost doctor` / `khost up`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import pc from 'picocolors';
import { alloyConfigFile, configDir, configFile } from './deps';
import { ok, warn } from './exec';

const CONFIG_TEMPLATE = `# khost — per-box config. Plaintext (this dir lives in your home, never a repo).
# All knobs, routes, Cloudflare creds and the machine id live here.

# Tunnel name (khost-<machine>) + the {machine} route token. Omit → hostname.
# machine: lombp

ssh:
  # port: darwin defaults to 2222 (private khost sshd); linux uses the system
  # sshd port (22). Set only to override.
  mesh_listen: auto         # darwin only: auto = detect live WARP mesh IP; "" = loopback only

tunnel:
  protocol: http2           # http2 | quic

# Required for the tunnel. Env wins if set (CLOUDFLARE_API_TOKEN /
# CLOUDFLARE_ACCOUNT_ID) — leave blank here to keep secrets out of plaintext.
# Token needs Tunnel:Edit, Zone:Read, DNS:Edit, Access: Apps and Policies Write.
cloudflare:
  account_id: ""
  api_token: ""

access:
  # Externally-managed reusable Access policy to attach to protected apps.
  # khost looks it up by exact name; it never creates/updates/deletes it.
  policy: primordial-ernestOnly

# Public hostnames routed through the tunnel. {machine} expands to the id above.
routes: []
#  - hostname: kauto.{machine}.example.com
#    service: http://localhost:47317
#  - hostname: kloop.{machine}.example.com
#    service: http://localhost:47316

# khost's own Prometheus self-metrics exporter (khost metrics serve):
# ssh-into-self, alloy/docker up, tunnel + route drift, Cloudflare creds.
metrics:
  port: 47319

# Grafana Alloy metrics collector. Scrapes the local kloop/kautopilot/kfleet
# exporters; remote_write ships them out. Token: env wins
# (ALLOY_REMOTE_WRITE_PASSWORD) — leave password blank here to keep it out of
# plaintext. Edit the scrape/remote_write wiring itself in ~/.khost/alloy.alloy.
alloy:
  port: 12345
  remote_write:
    url: ""        # e.g. https://prometheus-prod-XX.grafana.net/api/prom/push
    username: ""   # Grafana Cloud instance id
    password: ""   # API token — or set ALLOY_REMOTE_WRITE_PASSWORD in the env
`;

// Starter Grafana Alloy config: scrape the local exporters; ship nowhere until
// the user fills in a remote_write target. Valid as-is (forward_to = [] just
// drops the scraped series, but they still show in the Alloy UI).
const ALLOY_TEMPLATE = `// khost-managed Grafana Alloy config.
// Edit:  khost alloy edit      then  khost alloy restart
// UI:    http://localhost:12345
//
// Scrapes the local kloop / kautopilot / kfleet / khost Prometheus exporters. To
// ship the data out, uncomment the prometheus.remote_write block below and set
// the scrape's forward_to to [prometheus.remote_write.default.receiver].

logging {
  level  = "info"
  format = "logfmt"
}

prometheus.scrape "khost_local" {
  targets = [
    { __address__ = "host.docker.internal:47316", job = "kloop"      },
    { __address__ = "host.docker.internal:47317", job = "kautopilot" },
    { __address__ = "host.docker.internal:47318", job = "kfleet"     },
    { __address__ = "host.docker.internal:47319", job = "khost"      },
  ]
  scrape_interval = "30s"
  forward_to      = []   // <- [prometheus.remote_write.default.receiver] once configured below
}

// Ship metrics to Grafana Cloud / Mimir. The url + token come from khost config
// (alloy.remote_write.*) or the env (ALLOY_REMOTE_WRITE_*) — khost injects them
// into this container, so no secret needs to live in this file. Uncomment, then
// set the scrape's forward_to (above) to [prometheus.remote_write.default.receiver].
// prometheus.remote_write "default" {
//   endpoint {
//     url = sys.env("ALLOY_REMOTE_WRITE_URL")
//     basic_auth {
//       username = sys.env("ALLOY_REMOTE_WRITE_USERNAME")
//       password = sys.env("ALLOY_REMOTE_WRITE_PASSWORD")
//     }
//   }
// }
`;

export function init(opts: { force?: boolean } = {}): void {
  mkdirSync(configDir, { recursive: true });

  if (existsSync(configFile) && !opts.force) {
    warn(`exists: ${configFile} (use --force to overwrite)`);
  } else {
    writeFileSync(configFile, CONFIG_TEMPLATE, { mode: 0o600 });
    ok(`wrote ${configFile}`);
  }

  if (existsSync(alloyConfigFile) && !opts.force) {
    warn(`exists: ${alloyConfigFile} (use --force to overwrite)`);
  } else {
    writeFileSync(alloyConfigFile, ALLOY_TEMPLATE, { mode: 0o600 });
    ok(`wrote ${alloyConfigFile} (Grafana Alloy starter)`);
  }

  console.log(pc.bold('\nnext steps:'));
  console.log(`  1. edit ${configFile}   (cloudflare creds, routes, alloy.remote_write)`);
  console.log(`  2. edit ${alloyConfigFile}   (scrape targets; uncomment remote_write to ship)`);
  console.log('  3. khost doctor && khost up');
}
