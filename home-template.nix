{ config, pkgs, lib, pkgs-240924, pkgs-2505, pkgs-unstable, pkgs-casks, atomi, profile, ... }:

####################
# Custom Modules #
####################

let modules = import ./modules/default.nix { nixpkgs = pkgs; }; in

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
      trusted-users = [ "root" profile.user ];
    };

    # Include user's custom nix.conf for settings not covered above
    extraOptions = ''
      fallback = true
      upgrade-nix-store-path-url = https://install.determinate.systems/nix-upgrade/stable/universal
      !include ${home.homeDirectory}/nix.conf
    '';
  };
  # Let Home Manager install and manage itself.
  home.stateVersion = "25.05";
  home.username = "${profile.user}";
  home.homeDirectory = if profile.kernel == "linux" then "/home/${profile.user}" else "/Users/${profile.user}";


  home.activation.load-secrets = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export SECRETS_FILE="${./secrets.enc.yaml}"
    ${modules.load-secrets}/bin/load-secrets
  '';

  programs.home-manager.enable = true;

  #########################
  # Install packages here #
  #########################

  home.packages = ([

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
    du-dust
    fd
    procs
    dua
    navi
    tealdeer
    zenith
    gh
    stern
    tesseract
    age
    sops
    atomi.cyanprint
    atomi.attic

    # cncf
    kubectl
    docker
    kubectx
    k9s
    krew
    kubernetes-helm
    kubelogin-oidc
    linkerd
    pkgs-240924.bitwarden-cli
    devenv
    httplz
    nodejs


    # tooling
    mmv-go
    neofetch
    rclone
    tokei
    cachix

    #custom modules
    backup-folder
    setup-pcloud-remote
    k8s-update
    load-secrets

    # liftoff
    awscli2
    pkgs-240924.gimme-aws-creds
    ssm-session-manager-plugin

    pkgs-unstable.claude-code
  ] ++ (if profile.kernel == "linux" then [
    pinentry-all
  ] else [
    pinentry_mac
    xcbuild
    nerd-fonts.jetbrains-mono
  ]
  ));


  ###################################
  # Addtional environment variables #
  ###################################
  home.sessionVariables = {
    REPOS = "$HOME/Workspace/work/liftoff";
    SOPS_AGE_KEY_FILE = "$HOME/.config/sops/age/keys.txt";
    EDITOR = "nano";
    VAULT_ADDR = "https://vault.ops.vungle.io";
  };

  ##################
  # Addtional PATH #
  ##################
  home.sessionPath = [
    "$HOME/.local/bin"
    "$HOME/bin"
    "$HOME/.npm-global/bin"
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
      extraConfig = ''
        Host github-personal
        HostName github.com
        User git
        PreferredAuthentications publickey
        IdentityFile ~/.ssh/id_ed25519_kirin
        IdentitiesOnly=yes

        Host github-liftoff
        HostName github.com
        User git
        PreferredAuthentications publickey
        IdentityFile ~/.ssh/id_ed25519_vungle
        IdentitiesOnly=yes

        Host github-atomi
        HostName github.com
        User git
        PreferredAuthentications publickey
        IdentityFile ~/.ssh/id_ed25519_adelphi
        IdentitiesOnly=yes 

        Host *.liftoff.io
        User ubuntu
        PasswordAuthentication no
        ForwardAgent yes
        SendEnv LIFTOFF_USER
        StrictHostKeyChecking no
        UserKnownHostsFile /dev/null
        LogLevel ERROR
        AddKeysToAgent yes
      '';
    };

    git = {
      delta = {
        enable = true;
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
      enable = true;
      userEmail = "${profile.email}";
      userName = "${profile.gituser}";
      extraConfig = {
        init.defaultBranch = "main";
        push.autoSetupRemote = "true";
        branch.autosetuprebase = "always";
        pull.rebase = "true";
        rebase.autoStash = "true";
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
      lfs = {
        enable = true;
      };
    };

    bat.enable = true;

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
      nix-direnv = {
        enable = true;
      };
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
      initContent = ''
        if [ -e '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh' ]; then
          . '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh'
        fi
        if [ -e $HOME/.nix-profile/etc/profile.d/nix.sh ]; then . $HOME/.nix-profile/etc/profile.d/nix.sh; fi
        if [ -e $HOME/.secrets ]; then . $HOME/.secrets; fi

        # attic login atomicloud https://atomi-attic-app.fly.dev "$ATTIC_TOKEN"

        () {
           local -a prefix=( '\e'{\[,O} )
           local -a up=( $${^prefix}A ) down=( $${^prefix}B )
           local key=
           for key in $up[@]; do
              bindkey "$key" up-line-or-history
           done
           for key in $down[@]; do
              bindkey "$key" down-line-or-history
           done
        }

        unalias grep

        bindkey "$${key[Up]}" up-line-or-search

        update_env_by_dir() {
          case "$PWD" in
            ~/Workspace/work*)
              export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
              ;;
            ~/Workspace/atomi*|~/Workspace/personal*)
              export CLAUDE_CONFIG_DIR="$HOME/.claude"
              ;;
            *)
              unset CLAUDE_CONFIG_DIR
              ;;
          esac
        }

        autoload -U add-zsh-hook
        add-zsh-hook chpwd update_env_by_dir
        update_env_by_dir

        # Clear old aliases before defining function
        unalias hmsz 2>/dev/null || true

        # hmsz - apply config and reload zsh (works on both darwin and linux)
        ${
          if profile.kernel == "darwin" then ''
            hmsz() {
              sudo /run/current-system/sw/bin/darwin-rebuild switch --flake ~/.config/home-manager#${profile.user} && source ~/.zshrc
            }

            nix-init() {
              cd ~/.config/home-manager
              nix build ".#darwinConfigurations.${profile.user}.config.system.build.toplevel"
              sudo ./result/sw/bin/darwin-rebuild switch --flake .#${profile.user}
              rm -f result
              cd -
            }

          '' else ''
            hmsz() {
              home-manager switch && source ~/.zshrc
            }
          ''
        }
      '';

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
        hms = "home-manager switch";
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

        # liftoff
        awsl = "unset AWS_PROFILE && gimme-aws-creds && awsp";
        cc = "claude --dangerously-skip-permissions";
      } // (if profile.kernel == "linux" then {
        cursor = "/mnt/c/Users/Hoengager/AppData/Local/Programs/cursor/resources/app/bin/cursor";
      } else { });

      plugins = [
        {
          name = "powerlevel10k";
          src = pkgs.zsh-powerlevel10k;

          file = "\${PREFIX}share/zsh-powerlevel10k/powerlevel10k.zsh-theme";
        }
        # p10k config
        {
          name = "powerlevel10k-config";
          src = ./p10k-config;
          file = "\${PREFIX}.p10k.zsh";
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
