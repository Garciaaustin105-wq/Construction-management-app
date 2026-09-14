# Old desktop to Linux test box

This sheet turns the old Windows desktop into a small Linux test box. Stage 1 proves the recorder's test suite passes on real Linux. You will need the desktop itself, a monitor, a USB keyboard, a wired network cable from the desktop to the home router, and two USB sticks of 4 GB or more (one can be reused). Plan for about an hour, mostly waiting; no camera is needed yet, and nothing on the Windows PC's network settings changes.

## 1. Before you wipe it

1. **Installing Debian erases the desktop's drive completely.** Copy off anything you want to keep first.
2. Write down the specs and send them to Claude: processor model, memory (GB), and each drive's size and whether it is an SSD or a hard drive.
3. On Windows, **Settings > System > About** shows the processor and installed RAM.
4. **Disk Management** (right-click the Start button) shows the drives.
5. If Windows will not start, skip steps 3 and 4; section 5 prints the specs on Linux.

## 2. Make the Debian USB stick (on the Windows PC)

1. On the Windows PC, download the **Debian 13 "netinst" image for amd64** from debian.org only: https://www.debian.org/distrib/ (the small installer, about 700 MB, file name like debian-13.x.x-amd64-netinst.iso).
2. Download **Rufus** from rufus.ie.
3. Plug in USB stick 1. **The stick will be erased**, so check it holds nothing you need.
4. In Rufus, pick the stick in the device list.
5. Click **SELECT** and choose the .iso file, then click Start.
6. If Rufus asks for ISO or DD mode, **choose DD Image mode**.
7. Eject the stick when Rufus is done.

## 3. BIOS settings

1. Plug the stick into the desktop and power it on.
2. Tap the **boot menu or setup key** while it starts. It is often F12, F11, F10, Esc, F2 or Del; the exact key varies by maker and is shown briefly on the first screen.
3. If the BIOS has it, set **Restore on AC Power Loss** to Power On, so the box comes back on by itself after a power cut. If the setting is not there, skip it.
4. Set the desktop to **boot from the USB stick**. If the setting is not there, skip it.
5. **Secure Boot can stay on**; Debian supports it.

## 4. Install Debian

1. Make sure the network cable to the router is plugged in **before** you start the installer; the network then configures itself.
2. At the boot menu, choose **Graphical install**.
3. Answer the language, location and keyboard questions however you like.
4. Hostname: **camplat-test**.
5. Domain: **leave it blank** and continue.
6. Root password: **leave it completely blank** and press Continue. Then your own user gets sudo, the admin command.
7. Full name and username: your choice. A short lowercase username such as austin is easiest. **Pick a password and remember it.**
8. Partitioning: choose **Guided - use entire disk**.
9. If two drives are listed, pick **the smaller one or the SSD** for the system and do not touch the other drive.
10. Choose "All files in one partition", then **confirm Yes** to write the changes to the disk.
11. Package mirror: pick your country, then **deb.debian.org**.
12. Popularity contest: **No**.
13. Software selection: **untick "Debian desktop environment" and "GNOME"**, keep "standard system utilities" ticked, and leave "SSH server" unticked for now.
14. GRUB boot loader: **Yes**, installed on the same system drive.
15. When it says so, remove the stick and let it reboot.
16. It starts up to a black text login screen. **That is correct.**

## 5. First login: ffmpeg and Node 24

1. Log in with your username and password. **The password does not show while typing**; that is normal.
2. Refresh the package lists:

```bash
sudo apt update
```

3. Install ffmpeg (the video and audio toolkit) and a few helpers:

```bash
sudo apt install -y ffmpeg curl ca-certificates xz-utils
```

4. Add the NodeSource package source, then install Node 24:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
```

```bash
sudo bash nodesource_setup.sh
```

```bash
sudo apt install -y nodejs
```

5. Check the version. **It should start with v24**, followed by more numbers:

```bash
node -v
```

6. Print the specs for Claude (ROTA 1 means a spinning hard drive, 0 means an SSD):

```bash
lscpu | grep "Model name"
```

```bash
free -h
```

```bash
lsblk -d -o NAME,SIZE,ROTA,MODEL
```

## 6. Run the stage 1 check

1. Claude builds the program file, camplat-<commit>.tar.gz, and tells you where it is on the Windows PC.
2. Copy that file onto USB stick 2, or onto stick 1 reformatted in Windows as exFAT.
3. Plug the stick into the desktop.
4. List the drives and **find the stick by its size**; it is usually sdb with a partition sdb1:

```bash
lsblk
```

5. Mount the stick:

```bash
sudo mount /dev/sdb1 /mnt
```

6. Make a folder for the program and unpack the file into it:

```bash
mkdir -p ~/camplat
```

```bash
tar -xzf /mnt/camplat-*.tar.gz -C ~/camplat
```

7. Run the stage 1 check. **It installs nothing and starts nothing.** It takes a few minutes:

```bash
bash ~/camplat/setup/stage1-check.sh
```

8. The last line says **RESULT: PASS or RESULT: FAIL**, then "saved:" with a file name in your home folder.

## 7. Send the result back

1. Copy the result file onto the stick:

```bash
sudo cp ~/stage1-*.txt /mnt/
```

2. Unmount the stick so it is safe to unplug:

```bash
sudo umount /mnt
```

3. Plug the stick into the Windows PC, **copy the stage1 txt file to the Desktop**, and tell Claude it is there.
4. The file holds no passwords. **PASS or FAIL are both useful**: a FAIL tells us what differs on Linux.

## If something goes wrong

- **Boot menu does not show the stick:** try another USB port (the back of the PC), or recreate the stick in DD mode.
- **No network during install:** check the cable. The installer can continue without it, but step 5 needs it.
- **"sudo: command not found" or not in sudoers:** a root password was set in step 4. Reinstall with it blank, or ask Claude.
- **mount says wrong fs type:** the stick partition may be sdc1; check lsblk again.
- **Anything else:** take a photo of the screen and send it to Claude.
