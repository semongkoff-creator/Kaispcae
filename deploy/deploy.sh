#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8091/api/health}"
PULL=1
BUILD=1
MIGRATE=1
HEALTH=1
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ./deploy/deploy.sh [options]

Deploy the Office stack on the VPS with Docker Compose.

Options:
  --dry-run          Print commands without running them
  --no-pull          Skip git pull
  --no-build         Skip docker compose build
  --skip-migrate     Skip Prisma migrate deploy
  --skip-health      Skip post-deploy health check
  --health-url URL   Override health check URL
  -h, --help         Show this help

Environment:
  HEALTH_URL         Default: http://127.0.0.1:8091/api/health
USAGE
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

print_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_cmd "$@"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  "$@"
}

on_error() {
  local exit_code=$?
  printf '\nDeploy failed at line %s with exit code %s.\n' "${BASH_LINENO[0]}" "$exit_code" >&2
  exit "$exit_code"
}
trap on_error ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --no-pull)
      PULL=0
      ;;
    --no-build)
      BUILD=0
      ;;
    --skip-migrate)
      MIGRATE=0
      ;;
    --skip-health)
      HEALTH=0
      ;;
    --health-url)
      [[ $# -ge 2 ]] || die "--health-url requires a URL"
      HEALTH_URL="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
  shift
done

cd "$APP_DIR"

[[ -f docker-compose.yml ]] || die "docker-compose.yml not found in $APP_DIR"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "Docker Compose is not available. Install docker compose plugin or docker-compose."
fi

if [[ "$PULL" == "1" ]] && ! command -v git >/dev/null 2>&1; then
  die "git is required when --no-pull is not used"
fi

if [[ "$HEALTH" == "1" ]] && [[ "$DRY_RUN" != "1" ]] && ! command -v curl >/dev/null 2>&1; then
  die "curl is required for health check. Use --skip-health to skip it."
fi

if [[ ! -f .env && -z "${JWT_SECRET:-}" ]]; then
  printf 'WARNING: .env was not found and JWT_SECRET is not exported. docker compose may fail because JWT_SECRET is required.\n' >&2
fi

log "Preflight"
run "${COMPOSE[@]}" config --quiet

if [[ "$PULL" == "1" ]]; then
  log "Pull latest code"
  run git pull --ff-only
else
  log "Skip git pull"
fi

log "Ensure dependencies are running"
run "${COMPOSE[@]}" up -d postgres redis

if [[ "$BUILD" == "1" ]]; then
  log "Build app images"
  run "${COMPOSE[@]}" build server nginx
else
  log "Skip image build"
fi

if [[ "$MIGRATE" == "1" ]]; then
  log "Run database migrations"
  run "${COMPOSE[@]}" run --rm server npx prisma migrate deploy --schema=server/prisma/schema.prisma
else
  log "Skip database migrations"
fi

log "Start app services"
run "${COMPOSE[@]}" up -d server nginx

log "Service status"
run "${COMPOSE[@]}" ps

if [[ "$HEALTH" == "1" ]]; then
  log "Health check"
  if [[ "$DRY_RUN" == "1" ]]; then
    print_cmd curl -fsS "$HEALTH_URL"
  else
    for attempt in {1..30}; do
      if curl -fsS "$HEALTH_URL" >/dev/null; then
        printf 'Health check passed: %s\n' "$HEALTH_URL"
        exit 0
      fi
      printf 'Waiting for health check (%s/30): %s\n' "$attempt" "$HEALTH_URL"
      sleep 2
    done

    printf '\nHealth check failed. Recent logs:\n' >&2
    "${COMPOSE[@]}" logs --tail=80 server nginx >&2 || true
    exit 1
  fi
fi

log "Deploy finished"
