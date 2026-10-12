#!/usr/bin/env bash
set -euo pipefail
test ! -e /opt/opslands/current
test ! -e /var/lib/opslands/opslands.sqlite
test ! -e /etc/nginx/sites-available/opslands
install -d -m 755 /opt/opslands/releases/20261010-01 /var/www/opslands-acme
getent passwd opslands >/dev/null || useradd --system --home /var/lib/opslands --shell /usr/sbin/nologin opslands
install -d -o opslands -g opslands -m 700 /var/lib/opslands
tar -xzf /tmp/opslands-release.tgz -C /opt/opslands/releases/20261010-01
install -o opslands -g opslands -m 600 /opt/opslands/releases/20261010-01/database/opslands.sqlite /var/lib/opslands/opslands.sqlite
rm /opt/opslands/releases/20261010-01/database/opslands.sqlite
ln -s /opt/opslands/releases/20261010-01/app /opt/opslands/current
curl -fsS https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o /tmp/opslands-node-checksums
node_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ { print $2 }' /tmp/opslands-node-checksums)
test -n "$node_archive"
curl -fsS "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "/tmp/$node_archive"
(cd /tmp; grep " $node_archive$" opslands-node-checksums | sha256sum -c -)
install -d -m 755 /opt/opslands/node
tar -xJf "/tmp/$node_archive" -C /opt/opslands/node --strip-components=1
/opt/opslands/node/bin/node --version
(cd /opt/opslands/current; export PATH=/opt/opslands/node/bin:$PATH; npm exec --yes --package=pnpm@11.25.0 -- pnpm install --prod --frozen-lockfile --ignore-scripts)
install -m 644 /tmp/opslands.service /etc/systemd/system/opslands.service
systemctl daemon-reload
systemctl enable --now opslands
for attempt in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:3107/api/auth/me; then break; fi
    sleep 1
done
curl -fsS http://127.0.0.1:3107/api/auth/me
install -m 644 /tmp/opslands-http.conf /etc/nginx/sites-available/opslands
ln -s /etc/nginx/sites-available/opslands /etc/nginx/sites-enabled/opslands
nginx -t
systemctl reload nginx
certbot certonly --webroot -w /var/www/opslands-acme -d land.portalwiki.world --non-interactive --agree-tos --register-unsafely-without-email
install -m 644 /tmp/opslands-https.conf /etc/nginx/sites-available/opslands
nginx -t
systemctl reload nginx
systemctl is-active opslands
curl -fsS https://land.portalwiki.world/api/auth/me
systemctl is-active certbot.timer || true
