{ config, pkgs, ... }:

let setup-pcloud-rclone = import ./modules/setup-pcloud-remote.nix { inherit pkgs; }; in
let pcloud-backup = import ./modules/backup-folder.nix { inherit pkgs; }; in

let customDir = pkgs.stdenv.mkDerivation {
  name = "oh-my-zsh-custom-dir";
  src = ./zsh_custom;
  installPhase = ''
    mkdir -p $out/
    cp -rv $src/* $out/
  '';
}; in
with pkgs;
{
  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "kirin";
  home.homeDirectory = "/home/kirin";

  # This value determines the Home Manager release that your
  # configuration is compatible with. This helps avoid breakage
  # when a new Home Manager release introduces backwards
  # incompatible changes.
  #
  # You can update Home Manager without changing this value. See
  # the Home Manager release notes for a list of state version
  # changes in each release.
  home.stateVersion = "22.05";

  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;
  home.packages = [
    ngrok
    pcloud-backup
    gnutar
    rclone
    tmux
    procs
    tokei
    du-dust
    cachix
    fd
    kubectl
    docker
    jq
    yq-go
    uutils-coreutils
    setup-pcloud-rclone
    ripgrep
  ];

  services = {
    gpg-agent = {
      enable = true;
      enableSshSupport = true;
      enableExtraSocket = true;
    };
  };

  programs = {
    gpg = {
      enable = true;
      publicKeys = [
        { source = ./gpg_public.asc; }
      ];
    };
    ssh = {
      enable = true;
    };
    git = {
      enable = true;
      userEmail = "kirinnee97@gmail.com";
      userName = "kirinnee";
      signing = {
        key = "35E42CCF101D5C04";
        signByDefault = true;
      };
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
        if [ -e $HOME/.nix-profile/etc/profile.d/nix.sh ]; then . $HOME/.nix-profile/etc/profile.d/nix.sh; fi
        PATH="$PATH:/$HOME/.local/bin"
        export NIXPKGS_ALLOW_UNFREE=1
      '';
      oh-my-zsh = {
        enable = true;
        extraConfig = ''
          ZSH_CUSTOM="${customDir}"
        '';
        plugins = [
          "git"
          "docker"
          "kubectl"
          "pls"
        ];
      };
      shellAliases = {

        # core utils
        cat = "bat -p";
        cz = "cat ~/.zshrc";
        sz = "source ~/.zshrc";
        unpack = "tar -xvf";
        pack = "tar -zcvf archive.tar.gz";
        glog = "git log --oneline --decorate --graph";
        devbox = "ssh kirin@devbox";

        # helm
        h = "helm";
        hi = "helm install";
        hu = "helm uninstall";
        hup = "helm upgrade";

        # linkerd
        h5d = "linkerd";

        # terraform
        tf = "terraform";
        tfa = "terraform apply";
        tfd = "terraform destroy";

        # docker
        dr = "docker run";
        drid = "docker run -id";
        db = "docker build -t";
        deti = "docker exec -ti";
        dridc = "docker run -id -e TERM=xterm-256color";
        dps = "docker ps";
        dpsa = "docker ps -a";

        # nix & friends
        hms = "home-manager switch";
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

        # kubernetes
        kg = "kubectl get";
        kgn = "kubectl get nodes";
        kgpw = "watch -n 0.5 kubectl get pods";
        ktp = "kubectl top pods";
        ktpw = "watch -n 0.5 kubectl top pods";
        ktn = "kubectl top nodes";
        ktnw = "watch -n 0.5 kubectl top nodes";
        kd = "kubectl describe";
        kdel = "kubectl delete";

        # for windows only
        open = "explorer.exe";

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
            rev = "39423112977a8c520962bc11c46ee31e7ca873ca";
            sha256 = "sha256-+UziTYsjgpiumSulrLojuqHtDrgvuG91+XNiaMD7wIs=";
          };
        }
      ];
      zplug = {
        enable = true;
        plugins = [
          # interactive JQ query builder
          {
            name = "ogham/exa";
            tags = [ use:completions/zsh ];
          }
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

}
