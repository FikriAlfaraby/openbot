#!/bin/bash
# Fork: asks for the Gmail App Password of the community account service without echo, and writes it
# to apps/auth-api/.env.community (git-ignored), the file that the community deploy reads.
set -euo pipefail
file="$(cd "$(dirname "$0")/../.." && pwd)/apps/auth-api/.env.community"
[ -f "$file" ] || { echo "Missing $file. Generate the community secrets first." >&2; exit 1; }
printf 'Gmail App Password (16 letters, spaces are fine): '
IFS= read -rs password
echo
password=${password// /}
[ ${#password} -eq 16 ] || { echo "An App Password has 16 letters. Nothing was saved." >&2; exit 1; }
temporary=$(mktemp "$file.XXXXXX")
grep -v '^EMAIL_SMTP_PASSWORD=' "$file" >"$temporary" || true
printf 'EMAIL_SMTP_PASSWORD=%s\n' "$password" >>"$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$file"
echo "Saved. Tell Claude it is done."
