#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the explorer projects.
#
# Exit 0 skips the deployment; exit 1 builds it. Any uncertainty builds.
#
#   bash scripts/vercel-ignore-build.sh                    # mainnet
#   bash scripts/vercel-ignore-build.sh --production-only  # testnet, crosslink
#
# --production-only skips every non-production deployment. Commits that only
# touch paths the frontend never reads are skipped in every environment.
# Put "[force build]" in the commit message to always build.

set -u

production_only=false
for arg in "$@"; do
  case "$arg" in
    --production-only) production_only=true ;;
    *) echo "Unknown argument: $arg; building." >&2; exit 1 ;;
  esac
done

build() { echo "Build: $1"; exit 1; }
skip() { echo "Skip: $1"; exit 0; }

case "${VERCEL_GIT_COMMIT_MESSAGE:-}" in
  *"[force build]"*) build "commit message requests a build" ;;
esac

if [ "$production_only" = true ] && [ "${VERCEL_ENV:-}" != "production" ]; then
  skip "this project builds production only (VERCEL_ENV=${VERCEL_ENV:-unset})"
fi

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
[ -n "$base" ] || build "no previous deployment SHA to compare against"

if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=100 origin "$base" 2>/dev/null || true
  git cat-file -e "${base}^{commit}" 2>/dev/null || build "previous deployment $base is not in the clone"
fi

changed="$(git diff --name-only "$base" HEAD)" || build "git diff against $base failed"
[ -n "$changed" ] || skip "no file changes since $base"

# Paths the Next.js build never reads. app/docs/mcp imports the MCP tool
# catalog, so server/api/v1/mcp/ is deliberately not listed here.
frontend_irrelevant() {
  case "$1" in
    server/api/v1/mcp/*) return 1 ;;
    server/*|docs/*|.github/*|docker/*|zcg/*) return 0 ;;
    Dockerfile|Makefile|docker-compose*.yml|deno.lock|.dockerignore|.gitleaksignore) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
  esac
  return 1
}

while IFS= read -r file; do
  frontend_irrelevant "$file" || build "$file changed since $base"
done <<< "$changed"

skip "only backend, docs or CI files changed since $base"
