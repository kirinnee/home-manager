{ pkgs
, lib
, pkgs-llm
, claude-code-pkg
, codex-pkg
, pkgs-unstable
, atomi
, profile
, ...
}:

####################
# Custom Modules #
####################

let
  modules = import ./modules/default.nix { nixpkgs = pkgs; };
  kfleetAssets = ./kfleet;
  linkDirs = prefix: src:
    let entries = builtins.readDir src; in
    builtins.listToAttrs (map
      (name: {
        name = "${prefix}/${name}";
        value = {
          source = src + "/${name}";
          force = true;
        };
      })
      (builtins.filter (name: entries.${name} == "directory") (builtins.attrNames entries)));
  kfleetHomeFiles = {
    ".kfleet/config.yaml" = {
      source = kfleetAssets + "/config.yaml";
      force = true;
    };
    ".kfleet/CLAUDE.md" = {
      source = kfleetAssets + "/CLAUDE.md";
      force = true;
    };
    ".kfleet/CLAUDE.auto.md" = {
      source = kfleetAssets + "/CLAUDE.auto.md";
      force = true;
    };
    ".kfleet/templates" = {
      source = kfleetAssets + "/templates";
      force = true;
    };
  }
  // (linkDirs ".kfleet/skills" (kfleetAssets + "/skills"))
  // (linkDirs ".kfleet/skills-codex" (kfleetAssets + "/skills-codex"));
in

##################
  # Linux Services #
  ##################
let
  linuxService = {
    gpg-agent = {
      enable = true;
      enableSshSupport = true;
      enableExtraSocket = true;
      pinentry.package = if profile.kernel == "linux" then pkgs.pinentry-all else pkgs.pinentry_mac;
      # Cache signing passphrases for 1 month (in-memory; cleared on agent
      # restart/reboot) so headless agents aren't blocked on pinentry.
      defaultCacheTtl = 2592000;
      maxCacheTtl = 2592000;
    };
  };
in

#####################
  # Custom ZSH folder #
  #####################
let
  customDir = pkgs.stdenv.mkDerivation {
    name = "oh-my-zsh-custom-dir";
    src = ./zsh_custom;
    installPhase = ''
      mkdir -p $out/
      cp -rv $src/* $out/
    '';
  };
in
with pkgs;
with modules;
rec {
  imports = [
    ./modules/workspace
  ];

  # Nix configuration
  nix = {
    package = pkgs.nix;
    settings = {
      # Core features
      experimental-features = "nix-command flakes";
      always-allow-substitutes = true;

      # Substituters
      substituters = [
        "https://cache.nixos.org?priority=41"
        "https://nix-community.cachix.org?priority=42"
        "https://numtide.cachix.org?priority=43"
      ];

      # Trusted public keys
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
        "numtide.cachix.org-1:2ps1kLBUWjxIneOy1Ik6cQjb41X0iXVXeHigGmycPPE="
      ];

      # Performance
      max-jobs = "auto";

      # Bash prompt
      bash-prompt-prefix = "(nix:$name) ";

      # Nix path
      nix-path = "nixpkgs=flake:nixpkgs";

      # Trusted users (Linux typically uses wheel group)
      trusted-users = [
        "root"
        profile.user
      ];
    };

    # Include user's custom nix.conf for settings not covered above
    extraOptions = ''
      fallback = true
      upgrade-nix-store-path-url = https://install.determinate.systems/nix-upgrade/stable/universal
      !include ${home.homeDirectory}/nix.conf
    '';
  };
  # Let Home Manager install and manage itself.
  home.stateVersion = "26.05";
  home.username = "${profile.user}";
  home.homeDirectory =
    if profile.kernel == "linux" then "/home/${profile.user}" else "/Users/${profile.user}";

  # Workspace directories setup
  workspace.enable = true;

  programs.multi-gh = {
    enable = true;
    defaultAccount = "personal";
    defaultPackage = pkgs-unstable.gh;
    smartWrapper.enable = true;
    accounts = {
      personal = {
        directoryRules = [
          "~"
          "~/.config/home-manager"
          "~/Workspace/personal"
        ];
        username = "kirinnee";
      };
      atomi = {
        directoryRules = [ "~/Workspace/atomi" ];
        username = "adelphi-liong";
      };
      durian = {
        directoryRules = [ "~/Workspace/durian" ];
        username = "adelphi-durian";
      };
      liftoff = {
        directoryRules = [ "~/Workspace/work" ];
        username = "ernest-liftoff";
      };
    };
  };

  programs.multi-gws = {
    enable = true;
    defaultAccount = "lo";
    smartWrapper.enable = true;
    accounts = {
      lo = {
        directoryRules = [ "~/Workspace/work" ];
      };
      per = {
        directoryRules = [
          "~"
          "~/.config/home-manager"
          "~/Workspace/personal"
        ];
      };
    };
  };

  # Claude Code statusline (prettified, version-controlled)
  # kfleet source assets. Home Manager owns the top-level config/assets, while
  # kfleet owns generated wrappers and per-agent homes.
  home.file = kfleetHomeFiles // {
    ".config/claude-statusline.zsh" = {
      source = ./kfleet/statusline.zsh;
      executable = true;
    };

    ".oci/oci_cli_rc".text = ''
      [DEFAULT]
      compartment-id = ocid1.compartment.oc1..aaaaaaaaqcssiaa6caj3wc4p64r4kdko5szck4kkak2tajgslduij4kzeyhq
    '';

    ".finicky.js" = {
      source = ./finicky/config.js;
      executable = false;
    };

    # Nightly backup runner (Linux boxes; unit files further below)
    ".local/bin/box-backup" = {
      enable = profile.kernel == "linux";
      source = ./scripts/box/backup.sh;
      executable = true;
    };
  };

  # On darwin, home-manager's nix module is suppressed when embedded in nix-darwin,
  # so ~/.config/nix/nix.conf never gets created. Create it explicitly to pick up ~/nix.conf
  # (which load-secrets populates with access-tokens from sops).
  xdg.configFile."nix/nix.conf" = lib.mkIf (profile.kernel == "darwin") {
    text = ''
      !include ${home.homeDirectory}/nix.conf
    '';
  };

  # Worktrunk config
  xdg.configFile."worktrunk/config.toml".source = ./worktrunk/config.toml;

  # Nightly restic backup of ~/Workspace -> R2 (Linux boxes only; inert on
  # darwin). The runner derives everything from sops at runtime, so the unit
  # is static. Retention: keep 7 daily (scripts/box/backup.sh). Lingering is
  # granted by cloud-init (system layer), activation below enables the timer.
  xdg.configFile."systemd/user/box-backup.service" = {
    enable = profile.kernel == "linux";
    text = ''
      [Unit]
      Description=Restic backup of ~/Workspace to R2

      [Service]
      Type=oneshot
      ExecStart=%h/.local/bin/box-backup
    '';
  };
  xdg.configFile."systemd/user/box-backup.timer" = {
    enable = profile.kernel == "linux";
    text = ''
      [Unit]
      Description=Nightly restic backup (keep 7 days)

      [Timer]
      OnCalendar=*-*-* 03:00:00
      Persistent=true
      RandomizedDelaySec=15m

      [Install]
      WantedBy=timers.target
    '';
  };

  home.activation.load-secrets = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export SECRETS_FILE="${./secrets.enc.yaml}"
    ${modules.load-secrets}/bin/load-secrets
  '';

  # Compile repo-shipped terminfo entries (modules/terminfo/*.terminfo) into
  # ~/.terminfo — the ONE directory every ncurses (Ubuntu's, nix's, macOS's)
  # searches. Fixes terminals absent from stock DBs (Ghostty's xterm-ghostty:
  # dead backspace, tput errors, zle key lookups) on every OS declaratively.
  home.activation.install-terminfo = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    for tf in ${./modules/terminfo}/*.terminfo; do
      ${pkgs.ncurses}/bin/tic -x -o "$HOME/.terminfo" "$tf" 2>/dev/null \
        || echo "⚠️  tic failed for $tf"
    done
  '';

  home.activation.kfleet-apply = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ${modules.kfleet}/bin/kfleet apply
  '';

  home.activation.enable-backup-timer = lib.hm.dag.entryAfter [ "writeBoundary" ] (
    lib.optionalString (profile.kernel == "linux") ''
      export XDG_RUNTIME_DIR="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
      if [ -d "$XDG_RUNTIME_DIR" ]; then
        systemctl --user daemon-reload || true
        systemctl --user enable --now box-backup.timer || true
      fi
    ''
  );

  programs.home-manager.enable = true;

  #########################
  # Install packages here #
  #########################

  home.packages = (
    [
      loctl

      # AI agent CLIs. Provides the underlying `claude` binary on PATH; the
      # per-account wrappers in ~/.kfleet/bin (claude-<name>, codex-<name>, …),
      # generated by `kfleet` from repo-managed kfleet/config.yaml, exec it.
      # NOTE: `codex` is NOT installed here on darwin — it comes from the
      # system/app install (kfleet's codex-<name> wrappers resolve `codex`
      # from PATH). Linux boxes DO get it from nix — see the
      # profile.kernel == "linux" optionals at the end of this list.
      claude-code-pkg

      # system
      coreutils
      uutils-coreutils
      doggo
      jq
      yq-go
      ripgrep
      gnugrep
      nano
      unixtools.watch
      gnutar
      tmux
      dust
      fd
      procs
      dua
      navi
      tealdeer
      zenith
      stern
      google-cloud-sdk
      syncthing
      tailscale

      tesseract
      age
      sops
      restic # box nightly backups -> R2 (scripts/box/backup.sh)
      nil
      atomi.cyanprint
      atomi.attic


      # LLM friendly
      atomi.worktrunk
      atomi.ccc
      pkgs-llm.coderabbit-cli

      # cncf
      kubectl
      pkgs-unstable.docker # stable's docker_28 is flagged insecure; unstable's is not
      kubectx
      k9s
      krew
      kubernetes-helm
      kubelogin-oidc
      linkerd
      bitwarden-cli
      devenv
      nodejs
      bun
      pkgs-unstable.cloudflared
      pkgs-unstable.zellij

      # tooling
      mmv-go
      fastfetch
      rclone
      tokei
      cachix

      # LSPs
      typescript-language-server
      gopls
      pyright
      rust-analyzer

      #custom modules
      backup-folder
      k8s-update
      load-secrets
      hms
      k8s-merge
      oci-oke-allow-my-ip
      kloop
      kautopilot
      kteam
      kteamd
      klaude
      kodex
      kfleet
      kloge
      atomi.clickup_cli
      atomi.nsc
      grafana-loki
      prometheus.cli
      grafanactl

      # AI
      pkgs-unstable.rtk


      # liftoff
      awscli2
      pkgs-unstable.acli
      # gimme-aws-creds 2.8.2 requires okta >=2.9.0,<3.0.0, but nixpkgs 26.05
      # ships okta 3.1.0 (APIClient -> ApiClient, restructured SDK), which breaks
      # it at runtime. Rebuild it against a pinned okta 2.9.13. See nix/okta-2.9.13.nix.
      ((gimme-aws-creds.override {
        python3 = pkgs.python3.override {
          packageOverrides = pyfinal: pyprev: {
            okta = pyfinal.callPackage ./nix/okta-2.9.13.nix { };
          };
        };
      }).overridePythonAttrs (_: { doCheck = false; }))
      ssm-session-manager-plugin

      # oracle cloud
      oci-cli


    ]
    ++ (
      if profile.kernel == "linux" then
        [
          pinentry-all
        ]
      else
        [
          pinentry_mac
          nerd-fonts.jetbrains-mono
        ]
    )
    # Host-exposure suite (SSH + CLIProxyAPI over Cloudflare Tunnel). Only the
    # designated tunnel host gets the `khost` controller; inert everywhere else.
    ++ lib.optionals (profile.tunnelHost or false) [
      khost
    ]
    # codex CLI (nightly, sadjow/codex-cli-nix) for the kfleet codex-<name>
    # wrappers. Linux boxes only: on darwin it stays the system/app install
    # (see the claude-code-pkg note).
    ++ lib.optionals (profile.kernel == "linux") [
      codex-pkg
    ]
  );

  ###################################
  # Addtional environment variables #
  ###################################
  home.sessionVariables = {
    REPOS = "$HOME/Workspace/work/liftoff";
    SOPS_AGE_KEY_FILE = "$HOME/.config/sops/age/keys.txt";
    EDITOR = "nano";
    VAULT_ADDR = "https://vault.ops.vungle.io";
    CU_TEAM_ID = "9018863174";
    OCI_CLI_REGION = "us-ashburn-1";
    COMPARTMENT_ID = "ocid1.compartment.oc1..aaaaaaaaqcssiaa6caj3wc4p64r4kdko5szck4kkak2tajgslduij4kzeyhq";
    K8S_EKS_EXTRA_CLUSTER_SPECS = "us-east-1:eks-llm-us-east-1";
    OCI_OKE_ENDPOINT = "PUBLIC_ENDPOINT";
    OCI_OKE_CONTROL_PLANE_NSG_ID = "ocid1.networksecuritygroup.oc1.iad.aaaaaaaa2zqs4wmn6h7wl4mux3zqbwukb6ya3cxq6i76mdhxpxqyfbnepydq";

  };

  ##################
  # Addtional PATH #
  ##################
  home.sessionPath = [
    "$HOME/.kfleet/bin" # kfleet-generated agent wrappers (claude-<name>, codex-<name>, …)
    "$HOME/.local/bin"
    "$HOME/bin"
    "$HOME/.npm-global/bin"
    "/opt/homebrew/bin"
  ];
  #######################
  # Background services #
  #######################
  services = (if profile.kernel == "linux" then linuxService else { });

  # NOTE: the kloop/kautopilot dashboards are no longer managed here. They run as
  # self-installed per-user services (launchd on macOS, systemd --user on Linux)
  # via the binaries themselves: `kloop service install` / `kautopilot service
  # install`. Nix only distributes the binaries; it does not own the daemon.

  ##########################
  # Program Configurations #
  ##########################
  programs = {
    gpg = {
      enable = true;
    };

    ssh = {
      enable = true;
      enableDefaultConfig = false;
      # Machine-local host entries (nix config is read-only): scripts/box/up.sh
      # writes ~/.ssh/config.d/box.conf ("Host box" -> the provisioned box) so
      # `ssh box` / `zed ssh://box/...` work. Glob: no files -> silently ignored.
      includes = [ "~/.ssh/config.d/*.conf" ];
      settings = {
        "*" = {
          ForwardAgent = false;
          IdentitiesOnly = false;
        };
        "github-personal" = {
          HostName = "github.com";
          User = "git";
          IdentitiesOnly = true;
          IdentityFile = "~/.ssh/id_ed25519_kirin";
        };
        "github-liftoff" = {
          HostName = "github.com";
          User = "git";
          IdentitiesOnly = true;
          IdentityFile = "~/.ssh/id_ed25519_vungle";
        };
        "github-atomi" = {
          HostName = "github.com";
          User = "git";
          IdentitiesOnly = true;
          IdentityFile = "~/.ssh/id_ed25519_adelphi";
        };
        "github-durian" = {
          HostName = "github.com";
          User = "git";
          IdentitiesOnly = true;
          IdentityFile = "~/.ssh/id_ed25519_durian";
        };
        "*.liftoff.io" = {
          User = "ubuntu";
          ForwardAgent = true;
          PasswordAuthentication = "no";
          SendEnv = "LIFTOFF_USER";
          StrictHostKeyChecking = "no";
          UserKnownHostsFile = "/dev/null";
          LogLevel = "ERROR";
          AddKeysToAgent = "yes";
        };
      };
    };

    git = {
      enable = true;
      settings = {
        user.email = "${profile.email}";
        user.name = "${profile.gituser}";
        init.defaultBranch = "main";
        push.autoSetupRemote = true;
        branch.autosetuprebase = "always";
        pull.rebase = true;
        rebase.autoStash = true;
      };
      includes = [
        {
          condition = "gitdir:~/Workspace/work/";
          contents = {
            commit.gpgSign = true;
            "url \"github-liftoff:\"".insteadOf = "git@github.com:";
            user = {
              email = "erng@liftoff.io";
              name = "ernest-liftoff";
            };
          };
        }
        {
          condition = "gitdir:~/.config/home-manager/";
          contents = {
            commit.gpgSign = true;
            "url \"github-personal:\"".insteadOf = "git@github.com:";
            user = {
              email = "kirinnee97@gmail.com";
              name = "kirinnee";
              signingkey = "0xA0F1D9B42BE0F85B"; # infisical-scan:ignore
            };
          };
        }
        {
          condition = "gitdir:~/Workspace/personal/";
          contents = {
            commit.gpgSign = true;
            "url \"github-personal:\"".insteadOf = "git@github.com:";
            user = {
              email = "kirinnee97@gmail.com";
              name = "kirinnee";
              signingkey = "0xA0F1D9B42BE0F85B"; # infisical-scan:ignore
            };
          };
        }
        {
          condition = "gitdir:~/Workspace/atomi/";
          contents = {
            commit.gpgSign = true;
            "url \"github-atomi:\"".insteadOf = "git@github.com:";
            user = {
              email = "adelphi@atomi.cloud";
              name = "adelphi-liong";
              signingkey = "0x2F9E1DE31CB0061C"; # infisical-scan:ignore
            };
          };
        }
        {
          condition = "gitdir:~/Workspace/durian/";
          contents = {
            commit.gpgSign = true;
            "url \"github-durian:\"".insteadOf = "git@github.com:";
            user = {
              email = "adelphi@durian.cloud";
              name = "adelphi-durian";
              signingkey = "0x2DBF2E4B6651BDD6"; # infisical-scan:ignore
            };
          };
        }
      ];
      lfs.enable = true;
    };

    bat.enable = true;

    delta = {
      enable = true;
      enableGitIntegration = true;
      options = {
        navigate = true;
        side-by-side = true;
        theme = "Monokai Extended";
        features = "decorations";

        decorations = {
          file-style = "lightcoral bold ul";
          file-decoration-style = "blue ul";
          file-modified-label = "#";
          hunk-header-style = "line-number syntax bold";
          hunk-header-decoration-style = "lightcoral box";
          hunk-header-line-number-style = "lightcoral ul";
          hunk-label = "";
        };
      };
    };

    eza = {
      enable = true;
      git = true;
      icons = "auto";
    };

    broot = {
      enable = true;
      enableZshIntegration = true;
    };

    direnv = {
      enable = true;
      package = pkgs-unstable.direnv.overrideAttrs (_: {
        doCheck = false;
      });
      stdlib = ''
        : "''${XDG_CACHE_HOME:="''${HOME}/.cache"}"
        declare -A direnv_layout_dirs
        direnv_layout_dir() {
            local hash path
            echo "''${direnv_layout_dirs[$PWD]:=$(
                hash="$(sha1sum - <<< "$PWD" | head -c40)"
                path="''${PWD//[^a-zA-Z0-9]/-}"
                echo "''${XDG_CACHE_HOME}/direnv/layouts/''${hash}''${path}"
            )}"
        }
      '';
      enableZshIntegration = true;
      nix-direnv.enable = true;
    };

    fzf = {
      enable = true;
      enableZshIntegration = true;
    };
    zoxide = {
      enable = true;
      # Integration is initialized manually at the very end of the zshrc (see
      # `zoxideShell` below). Home Manager's built-in integration injects zoxide
      # too early — before zsh-autocomplete/fzf/wt register their own chpwd
      # hooks — which trips zoxide's doctor ("initialize zoxide at the end").
      enableZshIntegration = false;
      options = [ "--cmd cd" ];
    };

    zsh = {
      enable = true;
      enableCompletion = false;
      initContent =
        let
          initExtraFirst = lib.mkOrder 550 ''
            if [ -e '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh' ]; then
              . '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh'
            fi
            if [ -e $HOME/.nix-profile/etc/profile.d/nix.sh ]; then . $HOME/.nix-profile/etc/profile.d/nix.sh; fi
            if [ -e $HOME/.secrets ]; then . $HOME/.secrets; fi

            # Keep zsh-autocomplete's live menus, but make redraws less aggressive
            # around multi-line prompts.
            zstyle ':autocomplete:*' delay 0.12
            zstyle ':autocomplete:list-choices:*' list-lines 8
            zstyle ':autocomplete:history-incremental-search-backward:*' list-lines 6
          '';
          zshConfig = lib.mkOrder 1000 ''
            unalias grep

            awsp() {
              local profile

              profile="$(
                awk -F'[][]' '/^\[/{print $2}' "$HOME/.aws/credentials" \
                  | fzf --prompt='AWS profile> '
              )" || return

              if [ -n "$profile" ]; then
                export AWS_PROFILE="$profile"
                echo "AWS_PROFILE=$AWS_PROFILE"
              fi
            }

            awsl() {
              unset AWS_PROFILE

              if [ "$#" -gt 0 ]; then
                gimme-aws-creds --profile "$1" || return
              else
                gimme-aws-creds || return
                gimme-aws-creds --profile awspayer || return
              fi

              awsp
            }

            awspayer() {
              unset AWS_PROFILE
              gimme-aws-creds --profile awspayer || return
              export AWS_PROFILE=awspayer
              echo "AWS_PROFILE=$AWS_PROFILE"
              aws sts get-caller-identity
            }

          '';
          # zsh-autocomplete rebinds Up/Down to its async history MENU, which is
          # the widget that deadlocks the whole shell on big histories. Rebind
          # the arrows (both CSI and SS3 encodings) to zsh's builtin prefix
          # history search — cannot hang — and leave the plugin's menus on
          # Tab/PgUp-PgDn. Runs late (after plugin + OMZ init) so it wins.
          keybindShell = lib.mkOrder 4500 ''
            () {
              local key
              for key in '^[[A' '^[OA'; do bindkey "$key" up-line-or-search; done
              for key in '^[[B' '^[OB'; do bindkey "$key" down-line-or-search; done
            }
          '';
          wtShell = lib.mkOrder 5000 ''
            if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
          '';
          # Initialize zoxide LAST so its chpwd hook stays after zsh-autocomplete,
          # fzf and wt. Otherwise zoxide's doctor warns it isn't initialized at
          # the end of the shell config.
          zoxideShell = lib.mkOrder 5500 ''
            eval "$(zoxide init zsh --cmd cd)"

            # Agent shells can restore chpwd_functions from a pre-init snapshot,
            # removing zoxide's hook after .zshrc has loaded. Repair the missing
            # hook on the next zoxide-powered cd instead of emitting the generic
            # "initialize zoxide at the end" warning (it is already last here).
            __zoxide_doctor() {
              typeset -ga chpwd_functions
              if (( ''${chpwd_functions[(Ie)__zoxide_hook]:-0} == 0 )); then
                chpwd_functions+=(__zoxide_hook)
              fi
            }
          '';
        in
        lib.mkMerge [
          initExtraFirst
          zshConfig
          keybindShell
          wtShell
          zoxideShell
        ];

      oh-my-zsh = {
        enable = true;
        extraConfig = ''
          ZSH_CUSTOM="${customDir}"
        '';
        plugins = [
          "kubectl"
          "dotnet"
          "golang"
          "helm"
          "node"
          "git"
          "docker"
          "pls"
          "aws"
        ];
      };

      shellAliases = {
        dal = "direnv allow";
        pcr = "pre-commit run --all"; # run all pre-commit hook
        cz = "cat ~/.zshrc";
        sz = "source ~/.zshrc";
        unpack = "tar -xvf";
        pack = "tar -zcvf archive.tar.gz";
        glog = "git log --oneline --decorate --graph";
        devbox = "ssh kirin@$DEVBOX";
        wr = "wrangler";
        rc = "open \"/nix/store/$(ls /nix/store | grep raycast | grep -v '.drv')\"";
        cyan = "cyanprint";
        sgci = "sg committer install";
        gundo = "git reset --soft HEAD~1";
        slog = "stern --only-log-lines -o raw";
        slogl = "stern --only-log-lines -o raw -l app.kubernetes.io/name";

        # helm
        h = "helm";
        hi = "helm install";
        hu = "helm uninstall";
        hup = "helm upgrade";

        # linkerd
        l5d = "linkerd";

        # terraform
        tf = "terraform";
        tfa = "terraform apply";
        tfd = "terraform destroy";

        # docker
        dr = "docker run";
        dk = "docker kill";
        drm = "docker rm";
        drid = "docker run -id";
        db = "docker build -t";
        deti = "docker exec -ti";
        dridc = "docker run -id -e TERM=xterm-256color";
        dps = "docker ps";
        dpsa = "docker ps -a";
        dpsm = "docker ps --format 'table{{.ID}}\t{{.Names}}\t{{.Image}}'";
        dockerize = "docker --context default run --rm -it -v $(pwd):/workspace -w /workspace";

        # nix & friends
        hmg = "home-manager generations";
        ns = "nix shell";

        # zellij
        zla = "zellij a";
        zls = "zellij -s";
        zlls = "zellij ls";
        zld = "zellij delete-all-sessions";

        # kubernetes
        kg = "kubectl get";
        kc = "kubectl create";
        kgn = "kubectl get nodes";
        kgp = "kubectl get pods";
        kdes = "kubectl describe";
        kgs = "kubectl get service";
        kgpw = "watch -n 0.5 kubectl get pods";
        ktp = "kubectl top pods";
        ktpw = "watch -n 0.5 kubectl top pods";
        ktn = "kubectl top nodes";
        ktnw = "watch -n 0.5 kubectl top nodes";
        kd = "kubectl describe";
        kdel = "kubectl delete";
        kctx = "kubectx";
        kns = "kubens";
        kdbg = "kubectl debug -it --image nicolaka/netshoot";
        ooami = "oci-oke-allow-my-ip";

        fixgpg = "gpgconf --kill gpg-agent";
        vaultlogin = "export VAULT_TOKEN=$(vault login -path=oktaoidc -token-only -method=oidc role=admin)";

        nix-housekeep = "sudo nix-collect-garbage && sudo nix-collect-garbage --delete-old && nix-collect-garbage -d";

        aec2ls = "aws ec2 describe-instances --filters \"Name=instance-state-name,Values=running\" --query \"Reservations[].Instances[].[InstanceId, Tags[?Key=='Name'].Value | [0]]\" --output text --region us-east-1";
        aec2eti = "aws ssm start-session --target";
        aec2del = "aws ec2 terminate-instances --instance-ids";
        configterm = "POWERLEVEL9K_CONFIG_FILE=\"$HOME/.config/home-manager/p10k-config/.p10k.zsh\" p10k configure";

        wts = "wt select";
        wtc = "wt switch -c";
        wtcz = "wt switch -c -x 'zed .'";
        wtz = "wt switch -x 'zed .'";
        wtrm = "wt remove";

        # liftoff
        tfi = "tfswitch && tf init && vaultlogin";

        # kautopilot
        kap = "kautopilot";
        kapi = "kautopilot init";
        kaps = "kautopilot start";
        kapst = "kautopilot status";
        kapps = "kautopilot ps";
        kapx = "kautopilot stop";

        # klaude
        kat = "klaude at";
        kn = "klaude -n";

        # kteam
        kt = "kteam";
        ktps = "kteam ps";
        ktr = "kteam recommend";

        # kloop
        kp = "kloop";
        kpi = "kloop init";
        kpr = "kloop run";
        kps = "kloop status";
        kpc = "kloop cancel";
        kpl = "kloop logs";
        # Restart the self-installed kloop dashboard service (picks up edited src/).
        kpsr = "kloop service restart";
        klg = "tail -f ./.kagent/run.log";
        vpr = "gh pr view --web";

      }
      // (
        if profile.kernel == "linux" then
          {
            cursor = "/mnt/c/Users/Hoengager/AppData/Local/Programs/cursor/resources/app/bin/cursor";
          }
        else
          { }
      );

      plugins = [
        {
          name = "powerlevel10k";
          src = pkgs.zsh-powerlevel10k;
          file = "share/zsh-powerlevel10k/powerlevel10k.zsh-theme";
        }
        # p10k config
        {
          name = "powerlevel10k-config";
          src = ./p10k-config;
          file = ".p10k.zsh";
        }
        # live autocomplete — track a recent rev: the 2023 pin had the
        # notorious deadlocks (Up-arrow hangs, spurious INT prompt status,
        # "_autocomplete__is_glob not found" when mixed with OMZ's compinit)
        # that upstream fixed over 2024-2026.
        {
          name = "zsh-autocomplete";
          file = "zsh-autocomplete.plugin.zsh";
          src = pkgs.fetchFromGitHub {
            owner = "marlonrichert";
            repo = "zsh-autocomplete";
            rev = "20f6c34f20270084b21211428afb6d2534aae8e9";
            sha256 = "sha256-M8gWOg/9ohkG2NiLVSGERINcmHJCfoES5IG2GBllrRo=";
          };
        }
        {
          name = "you-should-use";
          src = pkgs.zsh-you-should-use;
          file = "share/zsh/plugins/you-should-use/you-should-use.plugin.zsh";
        }
      ];
    };
  };
}
