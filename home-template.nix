{ config, pkgs, pkgs-2405, atomi, profile, ... }:

####################
# Custom Modules #
####################

let modules = import ./modules/default.nix { nixpkgs = pkgs; }; in
let mm = import ./modules/macos/default.nix { nixpkgs = pkgs; inherit profile; }; in

##################
# Linux Services #
##################
let
  linuxService = {
    gpg-agent = {
      enable = true;
      enableSshSupport = true;
      enableExtraSocket = true;
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
{

    # Let Home Manager install and manage itself.
    home.stateVersion = "23.11";
    home.username = "${profile.user}";
    home.homeDirectory = if profile.kernel == "linux" then "/home/${profile.user}" else "/Users/${profile.user}" ;

    programs.home-manager.enable = true;

    #########################
    # Install packages here #
    #########################

    home.packages = ([

      # system
      coreutils
      uutils-coreutils
      jq
      yq-go
      ripgrep
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

      # cncf
      kubectl
      docker
      kubectx
      k9s
      krew
      kubernetes-helm
      kubelogin-oidc
      linkerd
      pkgs-2405.bitwarden-cli

      # tooling
      mmv-go
      neofetch
      rclone
      tokei
      cachix

      #custom modules
      backup-folder
      setup-pcloud-remote
      setup-devbox-server
      set-signing-key
      setup-keys
      get-uuid
      register-with-github
      okta-aws-cli
    ] ++ (if profile.kernel == "linux" then [
      jetbrains.webstorm
      jetbrains.idea-ultimate
      jetbrains.rider
      jetbrains.rust-rover
      jetbrains.goland
    ] else (
        with mm;
        [
      firefox
      arc
      beekeeper-studio
      httpie
      zed
      aptakube

      alt-tab-macos
      rectangle
      raycast
      obsidian
      nerdfonts
    ])));


    ###################################
    # Addtional environment variables #
    ###################################
    home.sessionVariables = {
    };

    ##################
    # Addtional PATH #
    ##################
    home.sessionPath = [
      "$HOME/.local/bin"
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
        };
        includes = [
          { path = "$HOME/.gitconfig"; }
        ];
        lfs = {
          enable = true;
        };
      };

      alacritty = {
        enable = true;
        settings = {
          font = {
            normal = {
              family = "JetBrainsMono Nerd Font";
              style = "Regular";
            };
          };
        };
      };

      bat = {
        enable = true;
      };


      eza = {
        enable = true;
        git = true;
        icons = true;
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
        initExtra = ''
          if [ -e '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh' ]; then
            . '/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh'
          fi
          if [ -e $HOME/.nix-profile/etc/profile.d/nix.sh ]; then . $HOME/.nix-profile/etc/profile.d/nix.sh; fi
          if [ -e $HOME/.secrets ]; then . $HOME/.secrets; fi

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

          bindkey "$${key[Up]}" up-line-or-search
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
          nw = "narwhal";
          wr = "wrangler";
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
          hmsz = "home-manager switch && source ~/.zshrc";
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

          nix-housekeep = "sudo nix-collect-garbage && sudo nix-collect-garbage --delete-old && nix-collect-garbage -d";

        };

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
