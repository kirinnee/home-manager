{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    # enable or disable formatters, see https://github.com/numtide/treefmt-nix#supported-programs
    programs = {
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
      shfmt.enable = true;
      actionlint.enable = true;
    };

    # ui-dist dirs are BUILT artifacts (minified bundles): prettifying them
    # bloats the served JS ~50% and desyncs content from its hashed filename.
    settings.formatter.prettier.excludes = [
      "modules/*/ui-dist/**"
    ];
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
