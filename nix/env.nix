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
  ];

  main = [
    infisical
  ];

  lint = [
    # core
    treefmt
    gitlint
    shellcheck
  ];
}
