#!/bin/sh
set -eu

mkdir -p /data/system /data/audit

for source in /opt/uhppoted/defaults/system/*.json; do
  target="/data/system/$(basename "$source")"
  if [ ! -e "$target" ]; then
    cp "$source" "$target"
  fi
done

if [ ! -e /data/auth.json ]; then
  cp /opt/uhppoted/defaults/auth.json /data/auth.json
fi

exec /opt/uhppoted/uhppoted-httpd --debug --config /usr/local/etc/uhppoted/uhppoted.conf --console
