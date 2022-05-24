{ config, pkgs, userinfo, ... }:

let setup-keys = import ./modules/setup-keys.nix { inherit pkgs; }; in
let set-signing-key = import ./modules/set-signing-key.nix { inherit pkgs; }; in
let setup-devbox-server = import ./modules/setup-devbox-server.nix { inherit pkgs; }; in
let get-uuid = import ./modules/get-uuid.nix { inherit pkgs; }; in
let register-with-github = import ./modules/register-with-github.nix { inherit pkgs; }; in
let awsmfa = import ./modules/awsmfa.nix { inherit pkgs; }; in
let setup-pcloud-rclone = import ./modules/setup-pcloud-remote.nix { inherit pkgs; }; in
let pcloud-backup = import ./modules/backup-folder.nix { inherit pkgs; }; in
let linuxService = {
  gpg-agent = {
    enable = true;
    enableSshSupport = true;
    enableExtraSocket = true;
  };
}; in
let customDir = pkgs.stdenv.mkDerivation {
  name = "oh-my-zsh-custom-dir";
  src = ./zsh_custom;
  installPhase = ''
    mkdir -p $out/
    cp -rv $src/* $out/
  '';
}; in
with pkgs;

let apps = [
  vscode
  slack
]; in

let tools = [
  neofetch
  ngrok
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
  pcloud-backup
  ripgrep
  setup-devbox-server
  set-signing-key
  setup-keys
  get-uuid
  register-with-github
  awscli2
  awsmfa
]; in

{
  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;
  home.packages = (if userinfo.apps then apps ++ tools else tools);

  services = (if userinfo.linux then linuxService else { });

  programs = {
    gpg = {
      enable = true;
    };
    ssh = {
      enable = true;
    };
    git = {
      enable = true;
      userEmail = "${userinfo.email}";
      userName = "${userinfo.gituser}";
      extraConfig = {
        init.defaultBranch = "main";
        pull.rebase = false;
        pull.ff = "only";
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
        if [ -e $HOME/.nix-profile/etc/profile.d/nix.sh ]; then . $HOME/.nix-profile/etc/profile.d/nix.sh; fi
        PATH="$PATH:/$HOME/.local/bin"
        export NIXPKGS_ALLOW_UNFREE=1
        unalias gm
        export AWS_PROFILE=default-mfa
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
          "aws"
        ];
      };
      shellAliases = {

        pcr = "pre-commit run --all"; # run all pre-commit hook


        # core utils
        cat = "bat -p";
        cz = "cat ~/.zshrc";
        sz = "source ~/.zshrc";
        unpack = "tar -xvf";
        pack = "tar -zcvf archive.tar.gz";
        glog = "git log --oneline --decorate --graph";
        devbox = "ssh -A kirin@devbox";

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
