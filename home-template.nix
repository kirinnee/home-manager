{ config
, pkgs
, lib
, pkgs-llm
, pkgs-240924
, pkgs-stable
, pkgs-unstable
, pkgs-casks
, atomi
, profile
, ...
}:

####################
# Custom Modules #
####################

let
  modules = import ./modules/default.nix { nixpkgs = pkgs; };
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
  home.stateVersion = "25.11";
  home.username = "${profile.user}";
  home.homeDirectory =
    if profile.kernel == "linux" then "/home/${profile.user}" else "/Users/${profile.user}";

  # Workspace directories setup
  workspace.enable = true;

  # Claude multi-account configuration
  programs.claude-multi = {
    enable = true;
    defaultPackage = pkgs-llm.claude-code;
    defaultAccount = "personal";

    smartWrapper.enable = true;

    aliases = {
      "yolo" = "--dangerously-skip-permissions";
      "ap" = "--dangerously-skip-permissions '/kagent-autopilot'";
    };

    shellIntegration = {
      functions = false;
      showActive = true;
    };

    accounts =
      let
        imported = import ./modules/claude-config/default.nix;
      in
      let
        inherit (imported)
          userConfig
          autoConfig
          auth
          ;
        merge = lib.recursiveUpdate;
      in
      {
        personal = merge userConfig {
          directoryRules = [
            "~"
            "~/.config/home-manager"
            "~/Workspace/personal"
          ];
          env = auth.zai;
        };

        liftoff = merge userConfig {
          directoryRules = [ "~/Workspace/work" ];
          env = auth.anthropic;
        };

        codex = merge userConfig { env = auth.codex; };
        gemini = merge userConfig { env = auth.gemini; };
        ag = merge userConfig { env = auth.ag; };
        zai = merge userConfig { env = auth.zai; };
        cerebras = merge userConfig { env = auth.cerebras; };
        kimi = merge userConfig { env = auth.kimi; };
        seed = merge userConfig { env = auth.seed; };
        mm = merge userConfig { env = auth.mm; };

        auto-anthropic = merge autoConfig { env = auth.anthropic; };
        auto-codex = merge autoConfig { env = auth.codex; };
        auto-gemini = merge autoConfig { env = auth.gemini; };
        auto-ag = merge autoConfig { env = auth.ag; };
        auto-zai = merge autoConfig { env = auth.zai; };
        auto-cerebras = merge autoConfig { env = auth.cerebras; };
        auto-kimi = merge autoConfig { env = auth.kimi; };
        auto-seed = merge autoConfig { env = auth.seed; };
        auto-mm = merge autoConfig { env = auth.mm; };
      };
  };

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
  home.file.".config/claude-statusline.zsh" = {
    source = ./modules/claude-config/statusline.zsh;
    executable = true;
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

  # Finicky config
  home.file.".finicky.js" = {
    source = ./finicky/config.js;
    executable = false;
  };

  home.activation.load-secrets = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export SECRETS_FILE="${./secrets.enc.yaml}"
    ${modules.load-secrets}/bin/load-secrets
  '';

  programs.home-manager.enable = true;

  #########################
  # Install packages here #
  #########################

  home.packages = (
    [

      # system
      coreutils
      uutils-coreutils
      dogdns
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

      tesseract
      age
      sops
      nil
      atomi.cyanprint
      atomi.attic


      # LLM friendly
      atomi.worktrunk
      atomi.ccc
      pkgs-llm.gemini-cli
      pkgs-llm.coderabbit-cli

      # cncf
      kubectl
      docker
      kubectx
      k9s
      krew
      kubernetes-helm
      kubelogin-oidc
      linkerd
      bitwarden-cli
      devenv
      nodejs
      pkgs-unstable.cloudflared

      # tooling
      mmv-go
      neofetch
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
      setup-pcloud-remote
      k8s-update
      load-secrets
      speak
      hms
      kloop
      kloop-dev
      kautopilot
      atomi.clickup_cli
      grafana-loki
      prometheus.cli
      grafanactl

      # AI
      pkgs-unstable.rtk
      gemini-auto

      # liftoff
      awscli2
      pkgs-unstable.acli
      gimme-aws-creds
      ssm-session-manager-plugin

      # claude-code is now managed by claude-multi module

    ]
    ++ (
      if profile.kernel == "linux" then
        [
          pinentry-all
        ]
      else
        [
          pinentry_mac
          xcbuild
          nerd-fonts.jetbrains-mono
        ]
    )
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
  };

  ##################
  # Addtional PATH #
  ##################
  home.sessionPath = [
    "$HOME/.local/bin"
    "$HOME/bin"
    "$HOME/.npm-global/bin"
    "/opt/homebrew/bin"
  ];
  #######################
  # Background services #
  #######################
  services = (if profile.kernel == "linux" then linuxService else { });

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
      matchBlocks = {
        "*" = {
          forwardAgent = false;
          identitiesOnly = false;
        };
        "github-personal" = {
          hostname = "github.com";
          user = "git";
          identitiesOnly = true;
          identityFile = "~/.ssh/id_ed25519_kirin";
        };
        "github-liftoff" = {
          hostname = "github.com";
          user = "git";
          identitiesOnly = true;
          identityFile = "~/.ssh/id_ed25519_vungle";
        };
        "github-atomi" = {
          hostname = "github.com";
          user = "git";
          identitiesOnly = true;
          identityFile = "~/.ssh/id_ed25519_adelphi";
        };
        "*.liftoff.io" = {
          user = "ubuntu";
          forwardAgent = true;
          extraOptions = {
            PasswordAuthentication = "no";
            SendEnv = "LIFTOFF_USER";
            StrictHostKeyChecking = "no";
            UserKnownHostsFile = "/dev/null";
            LogLevel = "ERROR";
            AddKeysToAgent = "yes";
          };
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
      package = pkgs-unstable.direnv;
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
      enableZshIntegration = true;
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
          '';
          zshConfig = lib.mkOrder 1000 ''
            unalias grep
          '';
          wtShell = lib.mkOrder 5000 ''
            if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
          '';
        in
        lib.mkMerge [
          initExtraFirst
          zshConfig
          wtShell
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
          "fd"
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

        fixgpg = "gpgconf --kill gpg-agent";
        vaultlogin = "export VAULT_TOKEN=$(vault login -path=oktaoidc -token-only -method=oidc role=admin)";

        nix-housekeep = "sudo nix-collect-garbage && sudo nix-collect-garbage --delete-old && nix-collect-garbage -d";

        awsp = "export AWS_PROFILE=$(grep '\\[' ~/.aws/credentials | tr -d '[]' | fzf)";
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
        awsl = "unset AWS_PROFILE && gimme-aws-creds && awsp";
        tfi = "tfswitch && tf init && vaultlogin";

        # kautopilot
        kap = "kautopilot";
        kapi = "kautopilot init";
        kaps = "kautopilot start";
        kapst = "kautopilot status";
        kapps = "kautopilot ps";
        kapx = "kautopilot stop";

        # kloop
        kp = "kloop";
        kpi = "kloop init";
        kpr = "kloop run";
        kps = "kloop status";
        kpc = "kloop cancel";
        kpl = "kloop logs";
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
        # live autocomplete
        {
          name = "zsh-autocomplete";
          file = "zsh-autocomplete.plugin.zsh";
          src = pkgs.fetchFromGitHub {
            owner = "marlonrichert";
            repo = "zsh-autocomplete";
            rev = "6d059a3634c4880e8c9bb30ae565465601fb5bd2";
            sha256 = "sha256-0NW0TI//qFpUA2Hdx6NaYdQIIUpRSd0Y4NhwBbdssCs=";
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
