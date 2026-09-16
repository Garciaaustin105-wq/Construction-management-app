# Putting sign-in on the laptop NVR

For the test box at 192.168.4.45, which already runs an earlier release. Nothing
here has been run yet: it waits for a go-ahead.

Use `setup/upgrade.sh`, not `setup/install.sh`. install.sh rewrites the systemd
units with its default store roots (`/srv/camplat/disk0,disk1`) unless
`CAMPLAT_STORE_ROOTS` is set to what the box was installed with; upgrade.sh
swaps the program and restarts, and touches nothing else.

## On the Windows PC

1. In `camera-platform`, on a clean tree: compile, run the suites, build.

```bash
/c/Users/garci_9e2kg3l/Projects/lowvoltage-app/node_modules/.bin/tsc -p .
```

```bash
node harness/run-all.mjs
```

```bash
node setup/release.mjs
```

2. Copy the tarball it names (`release/camplat-<sha>.tar.gz`) to the laptop.

```bash
scp -i ~/.ssh/camplat_laptop release/camplat-<sha>.tar.gz ausitn-garcia@192.168.4.45:/tmp/
```

## On the laptop

3. Note what is running now, so a rollback has a target.

```bash
cat /opt/camplat/VERSION; systemctl is-active camplat-recorder camplat-api
```

4. Swap it in. It prints old and new versions, restarts both services, and
   prints the rollback command.

```bash
tar -xzf /tmp/camplat-<sha>.tar.gz -C /tmp ./setup/upgrade.sh && sudo bash /tmp/setup/upgrade.sh /tmp/camplat-<sha>.tar.gz
```

5. Recording must not have stopped: a segment newer than the restart should
   appear within a minute.

```bash
journalctl -u camplat-recorder --since "-2 min" --no-pager | tail -20
```

## First sign-in (from the PC)

6. Open the tunnel, then browse to http://localhost:8088/login.

```bash
ssh -i ~/.ssh/camplat_laptop -N -L 8088:127.0.0.1:8080 ausitn-garcia@192.168.4.45
```

7. The page offers "Create the installer account". Through the tunnel the
   request is loopback, so no activation code is asked for.
8. Accounts page: add a `store` account; add a display and open its link once
   on the TV (the link is shown only once).

## Checks

- Signed out, http://localhost:8088/ goes to /login, and `/cameras` answers 401.
- Store account: Live, Review and System load; Accounts and `/audit` are refused.
- Sign out from the bar at the bottom right lands on /login.
- Display: live wall loads, no bar, and Review is refused.
- `/audit` (installer) shows the sign-ins above.

## Rollback

```bash
sudo mv /opt/camplat /opt/camplat.bad && sudo mv /opt/camplat.old /opt/camplat && sudo systemctl restart camplat-recorder camplat-api
```

Accounts live in `/var/lib/camplat/accounts.json`; the old release ignores it,
and it is picked up again on the next upgrade.

## Still open on that box

Stage-2 tests (camera clock, reboot, kill -9, L1/L2/L4, sealed size, 1 h busy,
85% eviction), then remove `/etc/sudoers.d/90-camplat-stage2`.
