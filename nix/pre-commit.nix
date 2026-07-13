{ packages, formatter, pre-commit-lib }:
pre-commit-lib.run {
  src = ./.;

  # hooks
  hooks = {
    # formatter
    treefmt = {
      enable = true;
      excludes = [ ];
      package = formatter;
    };

    # linters From https://github.com/cachix/pre-commit-hooks.nix
    shellcheck = {
      enable = false;
    };

    a-secrets-sync = {
      enable = true;
      name = "Secrets sync";
      description = "Block commits when secrets.yaml has edits not re-encrypted into secrets.enc.yaml";
      # Runs on every commit (default files regex matches anything staged):
      # drift between the decrypted working copy and the committed ciphertext
      # must never slip past a commit. Skips age-key-free when secrets.yaml
      # is absent (CI / fresh checkout).
      entry = "./scripts/secrets/check.sh";
      language = "system";
      pass_filenames = false;
    };

    a-infisical = {
      enable = true;
      name = "Secrets Scanning";
      description = "Scan for possible secrets";
      entry = "${packages.infisical}/bin/infisical scan . -v";
      language = "system";
      pass_filenames = false;
    };

    a-infisical-staged = {
      enable = true;
      name = "Secrets Scanning (Staged files)";
      description = "Scan for possible secrets in staged files";
      entry = "${packages.infisical}/bin/infisical scan git-changes --staged -v";
      language = "system";
      pass_filenames = false;
    };

    a-shellcheck = {
      enable = true;
      name = "Shell Check";
      entry = "${packages.shellcheck}/bin/shellcheck";
      files = ".*\\.sh$";
      language = "system";
      pass_filenames = true;
    };

    a-gitlint = {
      enable = true;
      name = "Gitlint";
      description = "Lints git commit message";
      entry = "${packages.gitlint}/bin/gitlint --staged --msg-filename .git/COMMIT_EDITMSG";
      language = "system";
      pass_filenames = false;
      stages = [ "commit-msg" ];
    };

    a-enforce-gitlint = {
      enable = true;
      name = "Enforce gitlint";
      description = "Enforce atomi_releaser conforms to gitlint";
      entry = "${packages.sg}/bin/sg gitlint";
      files = "(atomi_release\\.yaml|\\.gitlint)";
      language = "system";
      pass_filenames = false;
    };

    a-enforce-exec = {
      enable = true;
      name = "Enforce Shell Script executable";
      entry = "${packages.atomiutils}/bin/chmod +x";
      files = ".*sh$";
      language = "system";
      pass_filenames = true;
    };

  };
}
