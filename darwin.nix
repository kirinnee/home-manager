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
      "zed"
      "cloudflare-warp"
      "aptakube"
      "beekeeper-studio"
      "bruno"
      "voiceink"
      "google-chrome"
      "microsoft-edge"
      "finicky"
      "clickup"
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
  launchd.daemons = {
    # Expose Nix binaries to GUI apps (they don't inherit shell PATH)
    setenv-path = {
      serviceConfig = {
        Label = "setenv.path";
        ProgramArguments = [
          "/bin/launchctl"
          "setenv"
          "PATH"
          "/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        ];
        RunAtLoad = true;
      };
    };
    # Increase max open files limit (default 256 is too low for nix-daemon)
    limit-maxfiles = {
      serviceConfig = {
        Label = "limit.maxfiles";
        ProgramArguments = [
          "/bin/launchctl"
          "limit"
          "maxfiles"
          "65536"
          "524288"
        ];
        RunAtLoad = true;
      };
    };
  };

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
