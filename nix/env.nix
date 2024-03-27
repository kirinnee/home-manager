{ pkgs, packages }:
with packages;
{
  system = [
    bash
    coreutils
    gnugrep
    jq
  ];

  dev = [
    pls
    git
  ];

  main = [
    infisical
  ];

  lint = [
    # core
    treefmt
    shellcheck
  ];
}
