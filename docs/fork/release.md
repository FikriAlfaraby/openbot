# Fork releases and the VPS (phase 0)

The fork builds its own Linux server release, so that the VPS installs and updates the fork, not
upstream OpenBot. Upstream's `release.yml` runs only in `nightly-labs/openbot`.

## What points at the fork

| File | What it reads |
|---|---|
| `electron-builder.yml` `publish.owner` | the update feed in the packaged app |
| `scripts/install-server.sh` `RELEASES` | the first install on the VPS |
| `scripts/hosting/openbot-hosted-update` `RELEASES` | the update timer on the VPS |
| `src/main/host-release-service.ts` | the "update available" check in Server settings |

The provider runtime blocklist (`provider-runtime-releases.ts`) stays on upstream on purpose: it
blocks CLI releases with known problems.

## Version scheme

The server updater accepts only `X.Y.Z` and moves only to a newer version (`sort -V`). A fork build
is `<upstream major>.<upstream minor>.<upstream patch × 1000 + build>`:

| Upstream | Fork builds |
|---|---|
| 0.58.0 | 0.58.1, 0.58.2, … |
| 0.58.3 | 0.58.3001, 0.58.3002, … |
| 0.59.0 | 0.59.1, … |

## Cut a release

1. On `main`, run `bun run release:patch` for the next fork build of the same upstream version
   (0.58.0 → 0.58.1 → 0.58.2). It sets `package.json` and moves `changelog.d/` into `CHANGELOG.md`.
   After an upstream sync to 0.58.3, set the version to 0.58.3001 by hand with its `CHANGELOG.md`
   section.
2. Push the tag: `git tag v0.58.1 && git push origin v0.58.1`.
3. `fork-release.yml` builds the x64 and arm64 AppImages, checks them, and publishes the GitHub
   release with `latest-linux.yml`, `latest-linux-arm64.yml` and `SHA256SUMS.txt`.

A manual run (Actions → Fork release → Run workflow) builds without publishing, or publishes when
`publish` is on.

## Install on the VPS

On Ubuntu 24.04 (arm64 or x64) with systemd:

```sh
curl -fsSL https://raw.githubusercontent.com/FikriAlfaraby/openbot/main/scripts/install-server.sh | sudo bash
sudo openbot login
openbot mobile-connect   # scan the QR code with the phone app
```

The script on `main` must be the fork's script. Before the fork's work is on `main`, use the branch
in the URL instead of `main`.

To keep the data off the root disk, mount a block volume at `/var/lib/openbot` and
`/srv/openbot-hosted` before the install. Back up both together: the keyring in
`/srv/openbot-hosted` holds the key of the encrypted data.

## Not verified

- The workflow has not run yet; it needs the fork on GitHub with Actions turned on.
- An install from the fork's release on a real VPS has not been tested.
