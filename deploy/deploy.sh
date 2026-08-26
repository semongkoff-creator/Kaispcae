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
BACKUP=1
ALLOW_DIRTY=0
ARG_CHECK=1
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-virtualmeet}"

# Build args Vite inlines into the bundle at IMAGE BUILD time. An empty one is
# valid YAML and a valid docker build, which is exactly how production once
# shipped a client with no TURN relay in it: the values sat in .env the whole
# time, docker-compose.yml passed literal "" instead of ${...}, `compose
# config` validated cleanly, the build succeeded, and every pair of users who
# needed a relay silently never connected. Nothing anywhere said so. So these
# are asserted against the RESOLVED config before anything is built.
REQUIRED_BUILD_ARGS=(
  VITE_SERVER_URL
  VITE_TURN_URL
  VITE_TURN_USERNAME
  VITE_TURN_CREDENTIAL
  VITE_RUSTDESK_ID_SERVER
  VITE_RUSTDESK_RELAY_SERVER
  VITE_RUSTDESK_KEY
)

usage() {
  cat <<'USAGE'
Usage: ./deploy/deploy.sh [options]

Deploy the Office stack on the VPS with Docker Compose.

Options:
  --dry-run          Print commands without running them
  --no-pull          Skip git pull
  --no-build         Skip docker compose build
  --skip-migrate     Skip Prisma migrate deploy
  --skip-backup      Skip the pre-migration database dump (NOT recommended)
  --skip-arg-check   Build even if a required VITE_* build arg is empty
  --allow-dirty      Pull even with locally modified tracked files
  --skip-health      Skip post-deploy health check
  --health-url URL   Override health check URL
  -h, --help         Show this help

Environment:
  HEALTH_URL         Default: http://127.0.0.1:8091/api/health
  BACKUP_DIR         Default: <repo>/backups
  PG_SERVICE         Default: postgres
  PG_USER            Default: postgres
  PG_DB              Default: virtualmeet
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

# Reads the RESOLVED compose config rather than .env directly, because
# substitution is the step that actually broke before: the values were present
# in .env the entire time and simply never reached the build.
check_build_args() {
  local resolved missing=() arg line value
  if ! resolved="$("${COMPOSE[@]}" config 2>/dev/null)"; then
    die "docker compose config failed, so the build args cannot be verified"
  fi
  for arg in "${REQUIRED_BUILD_ARGS[@]}"; do
    line="$(printf '%s\n' "$resolved" | grep -E "^[[:space:]]+${arg}:[[:space:]]*" | head -1 || true)"
    if [[ -z "$line" ]]; then
      missing+=("$arg — not passed to the build at all")
      continue
    fi
    value="${line#*:}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [[ -n "$value" ]] || missing+=("$arg — resolves to an empty string")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'ERROR: the client bundle would be built without these:\n' >&2
    printf '  - %s\n' "${missing[@]}" >&2
    printf '\nSet them in %s/.env and rebuild. A restart will NOT pick them up —\n' "$APP_DIR" >&2
    printf 'these are inlined at build time. Pass --skip-arg-check to build anyway.\n' >&2
    exit 1
  fi
  printf 'All %s required build args resolve to a value.\n' "${#REQUIRED_BUILD_ARGS[@]}"
}

# `git pull --ff-only` aborts on a modified tracked file, and its own message
# does not say which host-only change is about to be lost. Untracked files are
# ignored on purpose: backups/ below is untracked by design.
check_clean_tree() {
  local dirty
  dirty="$(git status --porcelain --untracked-files=no)"
  [[ -n "$dirty" ]] || return 0
  printf 'ERROR: tracked files are modified here, so the pull would abort:\n' >&2
  printf '%s\n' "$dirty" >&2
  printf '\nThese changes exist only on this host. Commit them, or save a copy and\n' >&2
  printf '`git checkout --` them, before deploying. Pass --allow-dirty to try anyway.\n' >&2
  exit 1
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
    --skip-backup)
      BACKUP=0
      ;;
    --skip-arg-check)
      ARG_CHECK=0
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
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

if [[ "$PULL" == "1" && "$ALLOW_DIRTY" != "1" ]]; then
  check_clean_tree
fi

if [[ "$PULL" == "1" ]]; then
  log "Pull latest code"
  run git pull --ff-only
else
  log "Skip git pull"
fi

# After the pull, not before: the pull is what can change which args
# docker-compose.yml passes in the first place.
if [[ "$BUILD" == "1" && "$ARG_CHECK" == "1" ]]; then
  log "Verify client build args resolve"
  check_build_args
fi

log "Ensure dependencies are running"
run "${COMPOSE[@]}" up -d postgres redis

if [[ "$BUILD" == "1" ]]; then
  log "Build app images"
  run "${COMPOSE[@]}" build server nginx
else
  log "Skip image build"
fi

if [[ "$MIGRATE" == "1" && "$BACKUP" == "1" ]]; then
  log "Back up the database before migrating"
  if [[ "$DRY_RUN" == "1" ]]; then
    print_cmd "${COMPOSE[@]}" exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" "$PG_DB"
  else
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/${PG_DB}-$(date +%F-%H%M%S).sql.gz"
    # pipefail is set, so a pg_dump that dies mid-stream fails the script
    # rather than leaving a valid gzip of a truncated dump behind.
    "${COMPOSE[@]}" exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$BACKUP_FILE"
    BACKUP_SIZE="$(wc -c < "$BACKUP_FILE" | tr -d ' ')"
    # Completeness, not size.
    #
    # This was a size floor, which is the wrong question and said so the first
    # time a brand-new deployment ran it: pg_dump of an empty database is a
    # few hundred bytes and perfectly valid, so the guard blocked the one
    # migration that could not possibly destroy anything.
    #
    # pg_dump writes this trailer only after it finishes, so its presence
    # proves the dump ran to completion — which is what the size check was
    # reaching for, and it holds whether the database has one table or three
    # hundred.
    if ! gzip -dc "$BACKUP_FILE" 2>/dev/null | tail -5 | grep -q 'PostgreSQL database dump complete'; then
      die "Backup $BACKUP_FILE is truncated or unreadable (${BACKUP_SIZE} bytes) — refusing to migrate against it."
    fi
    printf 'Backup written: %s (%s bytes, complete)\n' "$BACKUP_FILE" "$BACKUP_SIZE"
  fi
elif [[ "$MIGRATE" == "1" ]]; then
  log "Skip database backup (--skip-backup)"
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
      if HEALTH_BODY="$(curl -fsS "$HEALTH_URL" 2>/dev/null)"; then
        # A 200 alone is not health. This route answers as soon as Express is
        # listening, so a stack that came up unable to reach Postgres used to
        # be reported as a successful deploy.
        if [[ "$HEALTH_BODY" != *'"status":"ok"'* ]]; then
          printf 'Health endpoint answered, but status is not ok:\n%s\n' "$HEALTH_BODY" >&2
          exit 1
        fi
        if [[ "$HEALTH_BODY" != *'"dbConnected":true'* ]]; then
          printf 'Health endpoint answered, but the database is not connected:\n%s\n' "$HEALTH_BODY" >&2
          exit 1
        fi
        # Redis is a cache here, not a hard dependency, so this warns instead
        # of failing an otherwise good deploy.
        [[ "$HEALTH_BODY" == *'"redisConnected":true'* ]] || printf 'WARNING: Redis is not connected.\n' >&2
        printf 'Health check passed: %s\n%s\n' "$HEALTH_URL" "$HEALTH_BODY"
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
