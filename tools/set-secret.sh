#!/bin/sh
# tools/set-secret.sh — the owner runs this (docs/PLAN.md step 6.3). Nothing it makes enters git.
#
# 1. Asks for the site password twice (not echoed) and bcrypts it locally with php.
# 2. Makes a new random push token.
# 3. Writes secret.php to the server over SSH:
#      <?php return ['password_hash' => <bcrypt>, 'push_token_sha256' => <sha256 of the token>];
#    (the server keeps only the token's digest; site/.htaccess denies secret.php to the web).
# 4. Only after the server has it: writes the token to ~/.config/mhilo-agents/token (mode 600)
#    and the site's push address to ~/.config/mhilo-agents/push-url, where the collector reads them.
#
# Run it again to change the password; it always rotates the push token too.
#
#   SITE_URL=https://agents.example.com SSH_HOST=<host> SSH_PORT=<port> SSH_USER=<user> \
#   DOC_ROOT=<the site's folder on the server> [SSH_KEY=~/.ssh/<your key>] sh tools/set-secret.sh
set -eu
umask 077

die() { printf 'set-secret: %s\n' "$1" >&2; exit 1; }
usage() {
  sed -n '2,20p' "$0" >&2
  exit 2
}

for v in SITE_URL SSH_HOST SSH_PORT SSH_USER DOC_ROOT; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { printf 'set-secret: %s is not set\n\n' "$v" >&2; usage; }
done
case "$SSH_PORT" in *[!0-9]*) die "SSH_PORT must be a number" ;; esac
SITE_URL=${SITE_URL%/}
printf '%s' "$SITE_URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$' || die "SITE_URL must be the site's https:// address, e.g. https://agents.example.com"
printf '%s' "$DOC_ROOT" | grep -Eq '^/[A-Za-z0-9._/-]+$' || die "DOC_ROOT must be an absolute path of plain characters"
printf '%s' "$SSH_USER@$SSH_HOST" | grep -Eq '^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$' || die "SSH_USER or SSH_HOST has unexpected characters"
command -v php >/dev/null 2>&1 || die "php is needed here to make the bcrypt hash"
command -v openssl >/dev/null 2>&1 || die "openssl is needed here to make the push token"
command -v shasum >/dev/null 2>&1 || die "shasum is needed here to digest the push token"
[ -t 0 ] || die "run this in a terminal: it asks for the password"

TOKEN_FILE="${HOME}/.config/mhilo-agents/token"
URL_FILE="${HOME}/.config/mhilo-agents/push-url"
if [ -f "$TOKEN_FILE" ]; then
  printf 'A push token already exists and will be replaced. The collector picks up the new one on its next push or restart. Continue? [y/N] ' >&2
  read -r answer
  case "$answer" in y|Y|yes) ;; *) die "nothing changed" ;; esac
fi

# The password: typed twice, never echoed, never on a command line.
restore() { stty echo 2>/dev/null || true; }
trap restore EXIT INT TERM
printf 'Password for %s: ' "$SITE_URL" >&2
stty -echo
IFS= read -r pw
stty echo
printf '\nThe same again: ' >&2
stty -echo
IFS= read -r pw2
stty echo
printf '\n' >&2
[ "$pw" = "$pw2" ] || die "the two entries differ; nothing changed"
[ "${#pw}" -ge 12 ] || die "use at least 12 characters; nothing changed"

hash=$(printf '%s' "$pw" | php -r 'echo password_hash(stream_get_contents(STDIN), PASSWORD_BCRYPT);')
pw=''; pw2=''
# shellcheck disable=SC2016 # the literal bcrypt prefix
case "$hash" in '$2y$'*) ;; *) die "bcrypt failed; nothing changed" ;; esac

token=$(openssl rand -hex 32)
digest=$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)
printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$' || die "could not digest the token; nothing changed"

# secret.php, written beside api.php through a temporary name so the server never sees half of it.
secret=$(printf "<?php\n// Written by tools/set-secret.sh on %s. Never commit it; site/.htaccess denies it to the web.\nreturn ['password_hash' => '%s', 'push_token_sha256' => '%s'];" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$hash" "$digest")
set -- -p "$SSH_PORT"
if [ -n "${SSH_KEY:-}" ]; then set -- "$@" -i "$SSH_KEY" -o IdentitiesOnly=yes; fi
# DOC_ROOT expands here, on purpose: it was checked above to hold only plain path characters.
# shellcheck disable=SC2029
if ! printf '%s\n' "$secret" | ssh "$@" "$SSH_USER@$SSH_HOST" "umask 077 && cd '$DOC_ROOT' && cat > .secret.php.tmp && chmod 600 .secret.php.tmp && mv .secret.php.tmp secret.php"; then
  die "could not write secret.php on the server; the local token is unchanged"
fi
secret=''

# Only now the local token: a failed upload above leaves the old pair matching.
mkdir -p "$(dirname "$TOKEN_FILE")"
chmod 700 "$(dirname "$TOKEN_FILE")"
tmp="$TOKEN_FILE.tmp.$$"
printf '%s\n' "$token" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$TOKEN_FILE"
token=''
printf '%s/api.php?action=push\n' "$SITE_URL" > "$URL_FILE.tmp.$$" && mv "$URL_FILE.tmp.$$" "$URL_FILE"

printf 'Done. secret.php is on %s in %s; the push token is in %s (mode 600), the push address in %s.\n' "$SSH_HOST" "$DOC_ROOT" "$TOKEN_FILE" "$URL_FILE" >&2
