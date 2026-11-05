# Zift production launch runbook

Run the commands from the operator Mac, which has the `zcash-mainnet` SSH alias and
the pinned analytics key. Secrets go host to host through pipes and are never
printed. Each step lists its rollback.

The values here were approved by the owner on 2026-10-29:
- AI caps: $25/day, $400/month and 3,000 calls/day of reserved spend, with the
  OpenAI organization limit of $100/month kept as the final ceiling.
- Worker: concurrency 8, runners 6, queue 12, 100 retained results, 2 jobs per
  visitor and a daily SQL cap of 3,000.

```sh
A='ssh -i ~/.ssh/id_ed25519_zcash_mainnet -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/code/wiki/assets/ask-analytics-host-2026-10-05/ssh-hostkeys.public root@135.181.17.198'
M='ssh zcash-mainnet'
```

## 1. Private link from the API host to the worker

Run from the repository root at this commit:

```sh
D=server/deploy/ask-analytics
$M 'cat > /root/setup-worker-link.sh' < $D/setup-worker-link.sh
$M 'cat > /root/zecblock-ask-worker-link.service' < $D/zecblock-ask-worker-link.service
$A 'mkdir -p /root/ask-worker-link && cat > /root/ask-worker-link/setup-worker-link.sh' < $D/setup-worker-link.sh
$A 'cat > /root/ask-worker-link/ask-worker-link.conf' < $D/ask-worker-link.conf
PUB=$($M 'bash /root/setup-worker-link.sh api-key' | tail -1)       # prints the host-key fingerprint, then the public key
$A "bash /root/ask-worker-link/setup-worker-link.sh analytics-allow '$PUB' 37.27.61.34"
$M 'bash /root/setup-worker-link.sh api-start'                      # expect: active, then HTTP 401
```

Rollback: `$M 'systemctl disable --now zecblock-ask-worker-link'`. On the
analytics host, remove `/etc/ssh/sshd_config.d/20-ask-worker-link.conf` and
`/var/lib/ask_api_link/.ssh/authorized_keys`, then run
`sshd -t && systemctl reload ssh`.

## 2. Turnstile widget (owner, in the Cloudflare dashboard)

1. Create a managed widget for `zecblock.com`.
2. Keep the site key and secret ready for step 3. Do not paste them into chat.

## 3. Production API settings

Do this immediately before step 5. Any restart of the API before the merge
would load these settings into the old code.

Append the settings to `/root/cipherscan/server/api/.env` on the API host.
Secrets are piped, never displayed.

```sh
# Service key shared with the worker (piped, not printed):
$A 'grep ^ASK_ANALYTICS_SERVICE_KEY= /etc/zecblock/ask-analytics.env' | $M 'cat >> /root/cipherscan/server/api/.env'
# Provider key: use a dedicated production key from the OpenAI "Zecblock" project.
#   $M 'read -rs K; printf "ASK_API_KEY=%s\n" "$K" >> /root/cipherscan/server/api/.env'   (type the key; nothing echoes)
# Turnstile (from step 2), the same way:
#   $M 'read -rs S; printf "ASK_TURNSTILE_SECRET=%s\n" "$S" >> /root/cipherscan/server/api/.env'
# A new abuse-identity secret, generated on the host:
$M 'printf "ASK_ABUSE_SECRET=%s\n" "$(openssl rand -hex 32)" >> /root/cipherscan/server/api/.env'
$M 'cat >> /root/cipherscan/server/api/.env' <<'EOF'
ASK_ENABLED=true
ASK_PROVIDER=openai
ASK_MODEL=gpt-6-luna
ASK_MAX_INPUT_USD_PER_MILLION=0.25
ASK_MAX_OUTPUT_USD_PER_MILLION=0.75
ASK_DAILY_BUDGET_USD=25
ASK_MONTHLY_BUDGET_USD=400
ASK_DAILY_CALL_LIMIT=3000
ASK_TURNSTILE_HOSTNAME=zecblock.com
ASK_TURNSTILE_SITE_KEY=<site key from step 2>
ASK_RESEARCH_ENABLED=true
ASK_RESEARCH_EXTENDED=true
ASK_RESEARCH_JOBS_ENABLED=true
ASK_ANALYTICS_ENABLED=true
ASK_ANALYTICS_STORE=logical_public_core
ASK_ANALYTICS_SERVICE_URL=http://127.0.0.1:3015/
EOF
```

The settings take effect when the merge in step 5 restarts the API.

Rollback: delete the appended `ASK_*` lines and restart `zcash-api-mainnet`.

## 4. Worker production settings

These are already live on the analytics host, from staging work on 2026-10-29:
- concurrency 8, runners 6, queue 12, 100 retained results, 2 jobs per visitor;
- daily SQL cap of 3,000;
- `ask_public_reader` CONNECTION LIMIT 8;
- the memory-guard fix (cf4cd9f5);
- host health accepting limits of 1–16.

Confirm before merging:

```sh
$A 'tr "\0" "\n" < /proc/$(systemctl show -p MainPID --value zecblock-ask-analytics)/environ | grep -E "CONCURRENCY|JOB_|PER_VISITOR|DAILY_QUERY_LIMIT"'
```

## 5. Merge and verify

1. Mark PR #181 ready, then merge. `deploy.yml` deploys the API to
   `zcash-mainnet`, and Vercel deploys all three frontends.
2. Check every Vercel project at the merge commit, and check the latest
   GitHub Actions attempt.
3. Health checks:
   - `$M 'curl -s 127.0.0.1:3001/v1/ask'` must report `mode: ai`,
     `researchEnabled: true` and `jobsEnabled: true`;
   - `/health` and `/health/deep` must return 200.

## 6. Soft-launch checks on zecblock.com

- `/ask` returns 308 to `/zift`.
- `/zift` has the right title and canonical, `index, follow`, one H1, and
  appears in the sitemap.
- Turnstile passes for an Ask question, a SQL run, Explain and dashboard
  Refresh all (one check per card).
- The page widget answers on `/pools`, and "Run it in Zift" hands the question
  over.
- Spend appears in the OpenAI "Zecblock" project and in
  `ask:{mainnet}:usd:<day>`.
