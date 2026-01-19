{ config, pkgs, lib, self, profile, ... }:

{
  # ============================================================
  # Nix configuration (manages /etc/nix/nix.conf)
  # ============================================================
  nix.enable = false;
  # nix.settings = {
  #   experimental-features = "nix-command flakes";
  #   always-allow-substitutes = true;

  #   substituters = [
  #     "https://cache.nixos.org?priority=41"
  #     "https://nix-community.cachix.org?priority=42"
  #     "https://numtide.cachix.org?priority=43"
  #   ];

  #   trusted-public-keys = [
  #     "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
  #     "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
  #     "numtide.cachix.org-1:2ps1kLBUWjxIneOy1Ik6cQjb41X0iXVXeHigGmycPPE="
  #   ];

  #   max-jobs = "auto";
  #   bash-prompt-prefix = "(nix:$name) ";
  #   nix-path = "nixpkgs=flake:nixpkgs";
  #   trusted-users = [ "root" profile.user ];
  # };

  # nix.extraOptions = ''
  #   fallback = true
  #   upgrade-nix-store-path-url = https://install.determinate.systems/nix-upgrade/stable/universal
  #   !include ${config.users.users.${profile.user}.home}/nix.conf
  # '';


  homebrew = {
    enable = true;
    brews = [
    ];
    casks = [
      "firefox"
      "cursor"
      "discord"
      "1password"
      "slack"
      "raycast"
      "obsidian"
      "alt-tab"
      "rectangle"
      "jetbrains-toolbox"
      "orbstack"
      "beeper"
      "ghostty"
      "lark"
      "zoom"
      "zen"
      "cloudflare-warp"
      "aptakube"
      "beekeeper-studio"
      "bruno"
    ];
    masApps = { };
  };

  # ============================================================
  # System Packages (installed to /run/current-system/sw)
  # ============================================================
  environment.systemPackages = with pkgs; [
  ];

  # ============================================================
  # System Shell (creates /etc/zshrc)
  # ============================================================
  programs.zsh.enable = true;

  # ============================================================
  # macOS Defaults (system settings)
  # ============================================================
  system.defaults = {
    # Finder settings
    finder = {
      AppleShowAllExtensions = true;
      FXPreferredViewStyle = "clmv";
    };

    # Dock settings
    dock = {
      autohide = false;
      orientation = "left";
      # tilesize = 48;
    };

    # Trackpad
    trackpad = {
      Clicking = true;
      TrackpadRightClick = true;
    };
  };

  # ============================================================
  # Launch Daemons & Agents (background services)
  # ============================================================
  launchd.daemons = { };

  # ============================================================
  # System state & tracking
  # ============================================================
  system.configurationRevision = self.rev or "dirty";
  system.stateVersion = 5;

  # Primary user for nix-darwin (required for homebrew, defaults, etc.)
  system.primaryUser = profile.user;

  nixpkgs.hostPlatform = "${profile.arch}-${profile.kernel}";

  # Declare macOS user
  users.users.${profile.user}.home = "/Users/${profile.user}";
}
