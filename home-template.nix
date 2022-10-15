{ config, pkgs, userinfo, atomi, linux, ... }:

####################
# Custom Modules #
####################


let modules = import ./modules/default.nix { nixpkgs = pkgs; }; in

####################
  # Upstream Mutator #
  ####################

let mutator = import ./upstream.nix; in

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


let
  output = {
    # Let Home Manager install and manage itself.
    programs.home-manager.enable = true;

    #########################
    # Install packages here #
    #########################

    home.packages = [

      # system
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

      # cncf
      kubectl
      docker
      kubectx
      k9s
      krew
      kubernetes-helm
      kubelogin-oidc
      atomi.narwhal
      linkerd

      # tooling
      mmv-go
      neofetch
      ngrok
      rclone
      tokei
      cachix

      # aws
      awscli2
      ssm-session-manager-plugin

      #custom modules
      backup-folder
      setup-pcloud-remote
      setup-devbox-server
      set-signing-key
      setup-keys
      get-uuid
      register-with-github


    ];


    ###################################
    # Addtional environment variables #
    ###################################
    home.sessionVariables = {
      NIXPKGS_ALLOW_UNFREE = "1";
      EDITOR = "code";
      AWS_PROFILE = "default-mfa";
      DEVBOX = "54.251.162.121";
    };

    ##################
    # Addtional PATH #
    ##################
    home.sessionPath = [
      "$HOME/.local/bin"
      "$HOME/Downloads/flutter/bin"
      "$HOME/.krew/bin"
    ];
    #######################
    # Background services #
    #######################
    services = (if linux then linuxService else { });

    ##########################
    # Program Configurations #
    ##########################
    programs = {

      vscode = {
        enable = true;
        extensions = [
          vscode-extensions.golang.go
          vscode-extensions.tomoki1207.pdf
          vscode-extensions.github.copilot
          vscode-extensions.hashicorp.terraform
          vscode-extensions.ms-dotnettools.csharp
          #       vscode-extensions.ms-python.python
          vscode-extensions.humao.rest-client
          vscode-extensions.jnoortheen.nix-ide

        ];
      };

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
        userEmail = "${userinfo.email}";
        userName = "${userinfo.gituser}";
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

      bat = {
        enable = true;
      };


      exa = {
        enable = true;
        enableAliases = true;
      };

      broot = {
        enable = true;
        enableZshIntegration = true;
      };

      direnv = {
        enable = true;
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

          unalias gm
        '';

        oh-my-zsh = {
          enable = true;
          extraConfig = ''
            ZSH_CUSTOM="${customDir}"
            zstyle ':completion:*:*:man:*:*' menu select=long search
            zstyle ':autocomplete:*' recent-dirs zoxide
          '';
          plugins = [
            "dotnet"
            "golang"
            "fd"
            "helm"
            "node"
            "poetry"
            "python"
            "git"
            "docker"
            "kubectl"
            "pls"
            "aws"
          ];
        };

        shellAliases = {

          pcr = "pre-commit run --all"; # run all pre-commit hook

          # spacelift
          sc = "spacectl";

          # core utils
          cat = "bat -p";
          cz = "cat ~/.zshrc";
          sz = "source ~/.zshrc";
          unpack = "tar -xvf";
          pack = "tar -zcvf archive.tar.gz";
          glog = "git log --oneline --decorate --graph";
          devbox = "ssh kirin@$DEVBOX";
          nw = "narwhal";

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

          # nix & friends
          hms = "home-manager switch --impure --flake $HOME/home-manager-config#$USER";
          hmsz = "home-manager switch --impure --flake $HOME/home-manager-config#$USER && source ~/.zshrc";
          hmg = "home-manager generations";
          ne = "nix-env";
          ni = "nix-env -i";
          nui = "nix-env --uninstall";
          ns = "nix-shell";
          nsp = "nix-shell -p";
          nb = "nix-build";
          nc = "nix-channel";
          nca = "nix-channel --add";
          ncr = "nix-channel --remove";
          ncu = "nix-channel --update";
          ngc = "nix-collect-garbage";
          ndel = "nix-store --delete";
          nixfindroot = "nix-store -q --roots";
          der = "direnv reload";
          dal = "direnv allow";

          # kubernetes
          kg = "kubectl get";
          kc = "kubectl create";
          kgn = "kubectl get nodes";
          kgpw = "watch -n 0.5 kubectl get pods";
          ktp = "kubectl top pods";
          ktpw = "watch -n 0.5 kubectl top pods";
          ktn = "kubectl top nodes";
          ktnw = "watch -n 0.5 kubectl top nodes";
          kd = "kubectl describe";
          kdel = "kubectl delete";
          kctx = "kubectx";
          kns = "kubens";

          # for windows only
          open = "explorer.exe";

          # gotrade only
          gtmfa = "awsmfa auth -u tr8ernest -t";

        };

        plugins = [
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
              rev = "f52f45a49d2df31e7d7aff1fb599c89b1eacbcef";
              sha256 = "sha256-SmLnp+ccqtYQEzIUbHcyB8Y+mR/6gcf4zjQw9rDGgSg=";
            };
          }
        ];

        zplug = {
          enable = true;
          plugins = [
            {
              name = "ogham/exa";
              tags = [ use:completions/zsh ];
            }
            # interactive JQ query builder
            {
              name = "reegnz/jq-zsh-plugin";
            }
            # make sound when commands longer than 15 seconds completed
            {
              name = "kevinywlui/zlong_alert.zsh";
            }
            # remind you you have aliases
            {
              name = "djui/alias-tips";
            }
            # themes
            {
              name = "romkatv/powerlevel10k";
              tags = [ as:theme depth:1 ];
            }
          ];
        };
      };
    };
  };
in
mutator { outputs = output; system = userinfo.system; nixpkgs = pkgs; }
