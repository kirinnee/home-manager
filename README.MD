# Home Manager Configurations

My personal [home-manager](https://github.com/nix-community/home-manager) configurations, which include ZSH plugins, configurations and basic binaries used for development.

## Install Home Manager

To use home configuration, home-manager is needed. Here, I will document both the official way and a convenience script.

### Official

1. Install [nix](https://github.com/NixOS/nix#installation)
2. Install [Home Manager](https://nix-community.github.io/home-manager/index.html#sec-install-standalone)
3. You can edit/update the folder `nixpkgs` at `~/.config/nixpkgs`

### Convenience Script

Install Home Manager (and Nix multi-user) from scratch:

```
curl -L https://raw.githubusercontent.com/kirinnee/home-manager/main/scripts/install-home-manager.sh | sh
```

### Cloud-Init

A Ubuntu-based cloud init configuration (which includes my public SSH key and my home-manager configuration) can be found [here](./cloud-init.yaml)
