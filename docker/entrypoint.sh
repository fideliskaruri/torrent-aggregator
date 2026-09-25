#!/bin/sh
set -eu

for value in "$PUID" "$PGID"; do
    case "$value" in
        ''|*[!0-9]*) echo "PUID and PGID must be positive numeric IDs." >&2; exit 1 ;;
    esac
    if [ "$value" -le 0 ] || [ "$value" -gt 2147483647 ]; then
        echo "PUID and PGID must be between 1 and 2147483647." >&2
        exit 1
    fi
done

if [ "$(id -u)" = 0 ]; then
    mkdir -p /data /media
    # Do not follow symlinks or cross nested mounts during ownership repair.
    find /data -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) -exec chown -h "$PUID:$PGID" {} + || {
        echo "Cannot repair /data ownership. Pre-provision host ownership/ACLs and use Compose user: to skip repair." >&2
        exit 1
    }
    # Media may be a large NAS library: only initialize its mount root, not existing files.
    if [ "$(stat -c %u:%g /media)" != "$PUID:$PGID" ]; then
        chown "$PUID:$PGID" /media || {
            echo "Cannot initialize /media ownership. Pre-provision host ownership/ACLs and use Compose user: to skip repair." >&2
            exit 1
        }
    fi
    exec gosu "$PUID:$PGID" "$0" "$@"
fi

if [ ! -w /data ] || [ ! -w /media ]; then
    echo "/data and /media must be writable by $(id -u):$(id -g). Fix host ownership/ACLs." >&2
    exit 1
fi
umask 002
exec "$@"
