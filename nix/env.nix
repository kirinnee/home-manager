{ pkgs, packages }:
with packages;
{
  system = [
    atomiutils
    sg
  ];

  dev = [
    pls
    git
    gomplate
    # box provisioning (infra/aws|digitalocean|oci via scripts/box/up.sh)
    opentofu
  ];

  main = [
    infisical
    # secrets workflow (scripts/secrets + a-secrets-sync hook); yq via atomiutils
    sops
    age
  ];

  lint = [
    # core
    treefmt
    gitlint
    shellcheck
  ];
}
