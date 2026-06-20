[
  {
    user = "kirin";
    email = "kirinnee97@gmail.com";
    gituser = "kirinnee";
    apps = false;
    arch = "x86_64";
    kernel = "linux";
  }
  {
    user = "ernest";
    email = "kirinnee97@gmail.com";
    gituser = "kirinnee";
    apps = true;
    arch = "aarch64";
    kernel = "darwin";
  }
  {
    user = "erng";
    email = "erng@liftoff.io";
    gituser = "ernest-liftoff";
    apps = true;
    arch = "aarch64";
    kernel = "darwin";
    # Designated host-exposure host: gets the `khost` suite (SSH + CLIProxyAPI
    # over Cloudflare Tunnel). Absent/false on all other profiles -> suite inert.
    tunnelHost = true;
  }
  {
    user = "ernest-liftoff";
    email = "erng@liftoff.io";
    gituser = "ernest-liftoff";
    apps = true;
    arch = "aarch64";
    kernel = "darwin";
  }
]
