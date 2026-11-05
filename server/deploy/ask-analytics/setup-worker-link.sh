#!/usr/bin/env bash
# Private link from the public API host to the Ask analytics worker.
#
# Run each step as root on the host it names, from a checkout of this repo:
#   1. API host:        bash setup-worker-link.sh api-key
#        creates the no-login ask_worker_link account and a fresh Ed25519 key,
#        pins the analytics host key, prints ONLY the public key.
#   2. Analytics host:  bash setup-worker-link.sh analytics-allow '<public key>' <API_IPV4>
#        creates the no-login ask_api_link account, authorizes that key from
#        the API IPv4 only, for a local forward to 127.0.0.1:3015 only, installs
#        the Match policy, validates sshd and reloads it.
#   3. API host:        bash setup-worker-link.sh api-start
#        installs and starts zecblock-ask-worker-link.service, then checks the
#        worker answers on 127.0.0.1:3015 (401 without the service key).
#
# Rollback: API host `systemctl disable --now zecblock-ask-worker-link`; analytics
# host: remove /etc/ssh/sshd_config.d/20-ask-worker-link.conf and the
# ask_api_link authorized key, `sshd -t && systemctl reload ssh`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ANALYTICS_HOST=135.181.17.198
# Pinned 2026-10-05 from authenticated operator access (wiki asset
# ask-analytics-host-2026-10-05); SHA256:PhRa00wEDxtUy3mLEYkUaBZBcTLkBcnpUSrk3DNCmD4.
ANALYTICS_HOSTKEY='135.181.17.198 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINawBTsG2ElnmbYG5RcH85+0lKjZnPPT1e/oo3U7JqUD'
dir=/etc/zecblock-ask-worker-link

case "${1:-}" in
  api-key)
    id ask_worker_link >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --no-create-home --user-group ask_worker_link
    # 0755 so the service account reads known_hosts; the identity stays 0600 and
    # reaches the service only through systemd LoadCredential.
    install -d -m 0755 -o root -g root "$dir"
    printf '%s\n' "$ANALYTICS_HOSTKEY" > "$dir/known_hosts"; chmod 0644 "$dir/known_hosts"
    [[ -f "$dir/identity" ]] || ssh-keygen -q -t ed25519 -N '' -C ask-worker-link@"$(hostname)" -f "$dir/identity"
    chmod 0600 "$dir/identity"
    ssh-keygen -lf "$dir/known_hosts"
    cat "$dir/identity.pub"
    ;;
  analytics-allow)
    key="${2:?public key}"; api_ip="${3:?API IPv4}"
    [[ "$key" == ssh-ed25519\ * ]] || { echo "Expected an ssh-ed25519 public key" >&2; exit 1; }
    id ask_api_link >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/ask_api_link --user-group ask_api_link
    install -d -m 0755 -o root -g root /var/lib/ask_api_link /var/lib/ask_api_link/.ssh
    printf 'from="%s",restrict,port-forwarding,permitopen="127.0.0.1:3015",command="/usr/sbin/nologin" %s\n' "$api_ip" "$key" > /var/lib/ask_api_link/.ssh/authorized_keys
    chmod 0644 /var/lib/ask_api_link/.ssh/authorized_keys
    before="$(sshd -T -C user=root,host=localhost,addr=127.0.0.1 | sort)"
    install -m 0644 "$here/ask-worker-link.conf" /etc/ssh/sshd_config.d/20-ask-worker-link.conf
    sshd -t
    after="$(sshd -T -C user=root,host=localhost,addr=127.0.0.1 | sort)"
    [[ "$before" == "$after" ]] || { echo "Root sshd policy changed; aborting" >&2; rm -f /etc/ssh/sshd_config.d/20-ask-worker-link.conf; exit 1; }
    systemctl reload ssh
    sshd -T -C user=ask_api_link,host=localhost,addr="$api_ip" | grep -E '^(permitopen|allowtcpforwarding|forcecommand|permittty|maxsessions) '
    ;;
  api-start)
    sed "s/ANALYTICS_HOST/$ANALYTICS_HOST/g" "$here/zecblock-ask-worker-link.service" > /etc/systemd/system/zecblock-ask-worker-link.service
    systemctl daemon-reload
    systemctl enable --now zecblock-ask-worker-link.service
    sleep 3
    systemctl is-active zecblock-ask-worker-link.service
    # Expect 401: reachable, and the worker still demands its service key.
    curl -s -o /dev/null -w 'worker via link: HTTP %{http_code}\n' --max-time 5 -X POST http://127.0.0.1:3015/jobs/status
    ;;
  *) echo "usage: $0 api-key | analytics-allow '<public key>' <API_IPV4> | api-start" >&2; exit 2 ;;
esac
