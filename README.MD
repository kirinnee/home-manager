# Home Manager Configurations

My personal [home-manager](https://github.com/nix-community/home-manager) configurations, which include ZSH plugins, configurations and basic binaries used for development.

## Setup New Box
```
curl -L https://raw.githubusercontent.com/kirinnee/home-manager/main/scripts/setup.sh | bash
```

## AutoBackup CLI

Within this home-manager, I created 2 CLI that helps me backup folders to pCloud itself.

1. `setup-rclone-pcloud`
   On a computer with **browser access** and **rclone CLI**, run the following command to obtain a JSON token:

   ```bash
   rclone authorize "pcloud"
   ```

   Run the rclone pcloud setup and paste the token in:

   ```bash
   setup-rclone-pcloud
   ```

2. `backup-pcloud`
   With `setup-rclone-pcloud` completed, you can backup any directory to pCloud's Backup folder:

   ```bash
   backup-pcloud backup ./Workspace desktop1 # => tarballs ./Workspace and send to pClouds's Backup/desktop1 folder
   backup-pcloud backup /home/kirin remote/devbox1 # => tarball /home/kirin and send to pCloud's Backup/remote/devbox1 folder
   ```

3. Restoring
   If you have backed up before, you can easily restore the latest backup with the follow command:
   ```bash
   backup-pcloud restore ./Workspace desktop1 # restores the first commnad previously
   backup-pcloud restore /home/kirin remote/devobx1 # restores the second command previously
   ```

#### Crontab

You can setup auto-backup with cron:

```bash
crontab -e
0 0 * * * sudo -u kirin bash -i -c 'pcloud-backup backup Workspace devbox'
```
