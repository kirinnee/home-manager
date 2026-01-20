{ config, pkgs, lib, self, profile, ... }:

{
  # ============================================================
  # Nix configuration (manages /etc/nix/nix.conf)
  # ============================================================
  nix.enable = false;

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
      "voiceink"
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
