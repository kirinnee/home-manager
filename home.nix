{ config, pkgs, ... }:


let userinfo = {
  user = "kirin";
  email = "kirinnee97@gmail.com";
  gituser = "kirinnee";
}; in

import ./home-template.nix { inherit pkgs config userinfo; }
