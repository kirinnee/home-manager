{ config, pkgs, lib, self, profile, ... }:

{
  # ============================================================
  # Nix configuration (manages /etc/nix/nix.conf)
  # ============================================================
  nix.enable = false;

  homebrew = {
    enable = true;
    brews = [ ];
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
  # Pre-activation: ensure Xcode CLT is installed for brew
  # nix-darwin sets xcode-select to the nix SDK, but brew needs real CLT with clang
  # Fail fast with an actionable message if CLT is missing, so brew bundle
  # doesn't blow up mid-activation.
  # ============================================================
  system.activationScripts.clt-symlink.text = ''
    # Test for the real Apple CLT install — not just any clang on PATH.
    # nix-darwin provides its own clang in the Nix SDK, which fools xcrun
    # but brew rejects it. We check the canonical CLT directory and the
    # pkgutil receipt that `xcode-select --install` creates.
    if [ ! -d /Library/Developer/CommandLineTools/usr/bin ] \
       || ! /usr/sbin/pkgutil --pkg-info=com.apple.pkg.CLTools_Executables >/dev/null 2>&1; then
      echo "❌ Xcode Command Line Tools not installed."
      echo "   Run: xcode-select --install"
      echo "   Wait for the installer to finish, then re-run: hms"
      exit 1
    fi
    /usr/bin/xcode-select -s /Library/Developer/CommandLineTools
  '';
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
