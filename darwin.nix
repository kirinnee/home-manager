{ config, pkgs, lib, self, profile, ... }:

{
  # Nix configuration for darwin (manages /etc/nix/nix.conf)
  nix.settings = {
    # Core features
    experimental-features = "nix-command flakes";
    always-allow-substitutes = true;

    # Substituters (merged from home-manager and flakehub)
    substituters = [
      "https://cache.nixos.org?priority=41"
      "https://nix-community.cachix.org?priority=42"
      "https://numtide.cachix.org?priority=43"
      "https://cache.flakehub.com"
    ];

    # Trusted public keys (merged from home-manager and flakehub)
    trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      "numtide.cachix.org-1:2ps1kLBUWjxIneOy1Ik6cQjb41X0iXVXeHigGmycPPE="
      "cache.flakehub.com-3:hJuILl5sVK4iKm86JzgdXW12Y2Hwd5G07qKtHTOcDCM="
      "cache.flakehub.com-4:Asi8qIv291s0aYLyH6IOnr5Kf6+OF14WVjkE6t3xMio="
      "cache.flakehub.com-5:zB96CRlL7tiPtzA9/WKyPkp3A2vqxqgdgyTVNGShPDU="
      "cache.flakehub.com-6:W4EGFwAGgBj3he7c5fNh9NkOXw0PUVaxygCVKeuvaqU="
      "cache.flakehub.com-7:mvxJ2DZVHn/kRxlIaxYNMuDG1OvMckZu32um1TadOR8="
      "cache.flakehub.com-8:moO+OVS0mnTjBTcOUh2kYLQEd59ExzyoW1QgQ8XAARQ="
      "cache.flakehub.com-9:wChaSeTI6TeCuV/Sg2513ZIM9i0qJaYsF+lZCXg0J6o="
      "cache.flakehub.com-10:2GqeNlIp6AKp4EF2MVbE1kBOp9iBSyo0UPR9KoR0o1Y="
    ];

    # Performance
    max-jobs = "auto";

    # Bash prompt
    bash-prompt-prefix = "(nix:$name) ";

    # Nix path
    nix-path = "nixpkgs=flake:nixpkgs";

    # Trusted users
    trusted-users = [ "root" profile.user ];
  };

  # Include user's custom nix.conf (for settings not covered by nix.settings)
  nix.extraOptions = ''
    fallback = true
    upgrade-nix-store-path-url = https://install.determinate.systems/nix-upgrade/stable/universal
    !include ${config.users.users.${profile.user}.home}/nix.conf
  '';

  # Create /etc/zshrc that loads the nix-darwin environment.
  programs.zsh.enable = true;

  # Set Git commit hash for darwin-version.
  system.configurationRevision = self.rev or "dirty";

  # Used for backwards compatibility, please read the changelog before changing.
  # $ darwin-rebuild changelog
  system.stateVersion = 5;

  # The platform the configuration will be used on.
  nixpkgs.hostPlatform = "${profile.arch}-${profile.kernel}";

  # Declare macOS user
  users.users.${profile.user}.home = "/Users/${profile.user}";
}
