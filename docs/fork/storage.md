# Storage on a server (fork, item 4.4)

## What grows

| Data | Place on a self-hosted server | Who cleans it |
|---|---|---|
| Conversations, queues, usage | `/var/lib/openbot/.config/OpenBot/openbot.db` | upstream OpenBot |
| Tickets | `.../OpenBot/fork-tickets.db` (user data folder) | the fork: archive after 30 days (below) |
| Ticket archive | `/var/lib/openbot/OpenBot/fork-archive/tickets-YYYY-MM.jsonl` | you: keep, or move to a bucket |
| Gate observations | `/var/lib/openbot/OpenBot/fork-observations.jsonl` | the fork: moved to `fork-archive/` past 5 MB |
| Agent workspaces, `Shared` | `/var/lib/openbot/OpenBot/Agents`, `.../Shared` | the agents and you |
| Browser sessions of tickets | `.../OpenBot/Partitions/openbot-browser-agent-<hash>` | the fork: cleared when the ticket ends (item 4.3) |
| T3 worktrees | T3 Code's worktree location | T3 Code: turn on **Settings → Worktrees → Cleanup** |
| Keyring (key of the encrypted sign-ins) | `/srv/openbot-hosted/keyrings`, password in `/var/lib/openbot/.config/openbot-hosted/keyring-password` | never delete it alone |

Put `/var/lib/openbot` and `/srv/openbot-hosted` on a block volume, and point T3 Code's
**Worktree location** there too, so the root disk does not fill.

## Ticket archive

Once a day OpenBot moves the tickets that ended (done, failed, cancelled) more than
`archiveAfterDays` ago from `fork-tickets.db` to `fork-archive/tickets-YYYY-MM.jsonl`: one JSON line
per ticket, with its events and the conversations that followed it. A ticket is deleted only after
its line is written; a live ticket is never moved. The files are mode 0600.

```yaml
# fork-config.yaml
storage:
  archiveAfterDays: 30   # 1 to 3650; the default is 30
```

## Daily backup

```sh
sudo bash scripts/fork/openbot-backup install   # copies the script, adds a daily systemd timer
sudo openbot-backup run                         # one backup now
```

Each backup is one archive in `/var/backups/openbot/openbot-<UTC time>.tar.gz` (mode 0600; the
newest 7 stay) with:

- `databases/…`: a consistent copy of `openbot.db` and `fork-tickets.db`, taken with the SQLite
  backup API while OpenBot runs, then checked with `quick_check`;
- `home/…`: the rest of the service user's home folder, without caches and live database files;
- `keyring/keyrings/…`: the keyring. Without it, the sign-ins and keys in the backup cannot be read.
- `MANIFEST`: when, from where, how many databases.

It needs `tar` and `python3` (or the `sqlite3` command). Settings in `/etc/openbot-backup.env`:

| Key | Default | Meaning |
|---|---|---|
| `OPENBOT_BACKUP_USER` | `openbot` | the service user, whose home folder is backed up |
| `OPENBOT_BACKUP_DIR` | `/var/backups/openbot` | where the archives go |
| `OPENBOT_BACKUP_KEEP` | `7` | archives kept there |
| `OPENBOT_BACKUP_BUCKET` | none | `s3://bucket/path` (aws), `gs://bucket/path` (gcloud or gsutil), or an rclone `remote:path` |
| `OPENBOT_BACKUP_AGE_RECIPIENT` | none | encrypt with [age](https://age-encryption.org) to this public key |
| `OPENBOT_BACKUP_GPG_RECIPIENT` | none | or encrypt with gpg to this key |
| `OPENBOT_BACKUP_ALLOW_PLAIN_UPLOAD` | `0` | `1` sends an unencrypted archive to the bucket |

The archive holds the keyring, so whoever has it can read the secrets. An upload is refused unless
the archive is encrypted or `OPENBOT_BACKUP_ALLOW_PLAIN_UPLOAD=1`. Keep the age or gpg private key
off the server. Set a lifecycle rule on the bucket for how long backups stay there.

## Restore

```sh
sudo systemctl stop openbot
age -d -i key.txt openbot-<time>.tar.gz.age > backup.tar.gz   # when encrypted
mkdir restore && tar -xzf backup.tar.gz -C restore
sudo rsync -a restore/home/ /var/lib/openbot/
sudo rsync -a restore/databases/ /var/lib/openbot/
sudo rm -f /var/lib/openbot/.config/OpenBot/openbot.db-wal /var/lib/openbot/.config/OpenBot/openbot.db-shm
sudo rsync -a restore/keyring/ /srv/openbot-hosted/
sudo chown -R openbot:openbot /var/lib/openbot /srv/openbot-hosted
sudo systemctl start openbot
```

Restore the home folder and the keyring of the same backup together.

## Not verified

- The timer and an upload to a real bucket have not run on a VPS; the script's backup, its
  encryption with age and the refusal of a plain upload are tested on Linux.
