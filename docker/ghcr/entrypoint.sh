#!/bin/sh
set -eu

mkdir -p /data/system /data/audit

for source in /opt/uhppoted/defaults/system/*.json; do
  target="/data/system/$(basename "$source")"
  if [ ! -e "$target" ]; then
    legacy="/usr/local/etc/uhppoted/httpd/system/$(basename "$source")"
    if [ -e "$legacy" ]; then
      cp "$legacy" "$target"
    else
      cp "$source" "$target"
    fi
  fi
done

if [ ! -e /data/auth.json ]; then
  if [ -e /usr/local/etc/uhppoted/httpd/auth.json ]; then
    cp /usr/local/etc/uhppoted/httpd/auth.json /data/auth.json
  else
    cp /opt/uhppoted/defaults/auth.json /data/auth.json
  fi
fi

exec /opt/uhppoted/uhppoted-httpd --debug --config /usr/local/etc/uhppoted/uhppoted.conf --console
