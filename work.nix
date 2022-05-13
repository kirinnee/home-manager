{ config, pkgs, ... }:


let userinfo = {
  user = "ernest";
  email = "ernest@tr8.io";
  gituser = "ernest";
}; in

import ./home-template.nix { inherit pkgs config userinfo; }
