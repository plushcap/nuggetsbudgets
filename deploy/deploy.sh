#!/bin/bash
# Nuggets Application Deployment Script
# Created: September 29, 2025
# 
# This script deploys the Nuggets application to a production server
# Usage: ./deploy.sh [environment] [action]
# 
# Examples:
#   ./deploy.sh production deploy    # Full deployment
#   ./deploy.sh production update    # Update only (no data recreation)
#   ./deploy.sh production restart   # Restart services only
#   ./deploy.sh production backup    # Create backup before deployment

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# =============================================================================
# CONFIGURATION
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENVIRONMENT="${1:-production}"
ACTION="${2:-deploy}"
ENV_FILE="$SCRIPT_DIR/${ENVIRONMENT}.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# =============================================================================
# LOGGING FUNCTIONS
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# =============================================================================
# VALIDATION FUNCTIONS
# =============================================================================

check_requirements() {
    log_info "Checking deployment requirements..."
    
    # Check if docker is installed
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
    fi
    
    # Compose v2 (`docker compose`); the old docker-compose v1 binary isn't supported.
    if ! docker compose version &> /dev/null; then
        log_error "Docker Compose v2 is not installed (docker compose). Please install it first."
    fi

    # The secret files get read access for the container users through ACLs.
    if ! command -v setfacl &> /dev/null; then
        log_error "setfacl is not installed. Install the acl package (apt install acl) first."
    fi
    
    # Check if environment file exists
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error "Environment file ${ENVIRONMENT}.env not found in deploy directory"
    fi

    # Check if production compose file exists
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        log_error "Production docker-compose file not found"
    fi
    
    log_success "All requirements satisfied"
}

load_environment() {
    log_info "Loading environment configuration..."
    
    # The compose file's variables come from the env file and this script's defaults
    # alone: compose prefers the calling shell's environment to --env-file, so an
    # `export DB_HOST=localhost` in someone's profile would otherwise reach the backend.
    local name
    while read -r name; do
        unset -v "$name"
    done < <(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" | cut -c3- | sort -u)
    # Compose's own settings too: an exported COMPOSE_PROJECT_NAME would deploy under another
    # project name, with other containers, networks and volumes (the database's among them),
    # and COMPOSE_PROFILES would pick other services. The env file may set them. COMPOSE_FILE
    # is this script's own, and compose gets the file with -f.
    while read -r name; do
        [[ "$name" == COMPOSE_FILE ]] || unset -v "$name"
    done < <(compgen -e COMPOSE_ || true)
    # This script's own settings come from the env file alone, as well.
    unset -v DEPLOY_BACKUP_KEEP

    # A line that uses a variable not set yet (a typo, or BASE=${DEPLOY_BASE_PATH} above the
    # DEPLOY_BASE_PATH line) would otherwise make a path under / of it, and a line that
    # fails (a value with a space, unquoted) would stop the run with bash's message alone.
    # Read it in a fresh bash under -eu first, so the line is named before anything runs. Not a
    # subshell: bash ignores set -e in a command substitution left of ||, so a failing line
    # other than the last would pass.
    local problem status=0
    # The env file is the operator's config (from production.env.example), not a script to lint.
    # shellcheck disable=SC2016
    problem=$(bash -eu -c '. "$1"' envcheck "$ENV_FILE" 2>&1 > /dev/null) || status=$?
    if (( status != 0 )); then
        # Bash says "<file>: line 3: DEPLOY_BASE: unbound variable".
        problem=${problem#"$ENV_FILE: "}
        if [[ "$problem" =~ line\ ([0-9]+):\ ([A-Za-z_][A-Za-z0-9_]*):\ unbound\ variable ]]; then
            problem="line ${BASH_REMATCH[1]} uses ${BASH_REMATCH[2]} before anything sets it"
        fi
        log_error "$ENV_FILE: ${problem:-a line in it failed (status $status)}"
    fi

    # Load environment variables
    set -a  # Export all variables
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a  # Stop exporting

    # Every variable this script and docker-compose.prod.yml need that has no default,
    # checked before anything runs: a missing one is named here, with the others, rather
    # than stopping the run midway as an unbound variable (set -u).
    local required_vars=(
        "DEPLOY_BASE_PATH"
        "SECRETS_BASE_PATH"
        "POSTGRES_DATA_PATH"
        "UPLOADS_PATH"
        "BACKUPS_PATH"
        "TEMP_PATH"
        "LOGS_PATH"
        "DOMAIN_URL"
    )
    local missing=()
    for var in "${required_vars[@]}"; do
        if [[ -z "${!var:-}" ]]; then
            missing+=("$var")
        fi
    done
    if (( ${#missing[@]} > 0 )); then
        log_error "Not set in $ENV_FILE: ${missing[*]} (deploy/production.env.example lists them)"
    fi

    # These have defaults, the compose files' own. Exported, so the containers run as the
    # uids this script gives the directories and secrets to.
    export NUGGETS_USER_ID="${NUGGETS_USER_ID:-1001}"
    export POSTGRES_USER_ID="${POSTGRES_USER_ID:-1999}"
    export CLIENT_URL="${CLIENT_URL:-$DOMAIN_URL}"
    for var in NUGGETS_USER_ID POSTGRES_USER_ID; do
        if [[ ! "${!var}" =~ ^[0-9]+$ ]]; then
            log_error "$var must be a numeric uid, not \"${!var}\""
        fi
    done
    # How many of its own dumps `backup` keeps (the newest); 0 keeps them all.
    DEPLOY_BACKUP_KEEP="${DEPLOY_BACKUP_KEEP:-10}"
    if [[ ! "$DEPLOY_BACKUP_KEEP" =~ ^[0-9]+$ ]]; then
        log_error "DEPLOY_BACKUP_KEEP must be a whole number (0 keeps every dump), not \"$DEPLOY_BACKUP_KEEP\""
    fi

    # Migrations and backups run as the database's owner, MIGRATION_DB_USER, which the
    # compose file doesn't take from POSTGRES_USER (an existing database keeps the owner it
    # was made with). Another POSTGRES_USER without it would start a backend that can't migrate.
    if [[ -n "${POSTGRES_USER:-}" && "$POSTGRES_USER" != nuggetsApp_user && -z "${MIGRATION_DB_USER:-}" ]]; then
        log_error "POSTGRES_USER is $POSTGRES_USER, so set MIGRATION_DB_USER in $ENV_FILE to the role that owns the database: $POSTGRES_USER on a new install, nuggetsApp_user if the database was made before POSTGRES_USER changed"
    fi

    log_success "Environment configuration loaded"
    log_info "Deploy base path: $DEPLOY_BASE_PATH"
    log_info "Domain URL: $DOMAIN_URL"
}

# =============================================================================
# DIRECTORY SETUP FUNCTIONS
# =============================================================================

create_directories() {
    log_info "Creating deployment directories..."
    
    local directories=(
        "$DEPLOY_BASE_PATH"
        "$POSTGRES_DATA_PATH"
        "$UPLOADS_PATH"
        "$BACKUPS_PATH"
        "$TEMP_PATH"
        "$LOGS_PATH"
        "$SECRETS_BASE_PATH"
        "$UPLOADS_PATH/account-images"
        "$UPLOADS_PATH/attachments"
        "$UPLOADS_PATH/imports"
        "$TEMP_PATH/uploads"
    )
    
    for dir in "${directories[@]}"; do
        if [[ ! -d "$dir" ]]; then
            log_info "Creating directory: $dir"
            sudo mkdir -p "$dir"
        fi
    done
    
    log_success "Deployment directories created"
}

set_permissions() {
    log_info "Setting directory permissions..."
    
    # Set ownership for application directories
    sudo chown -R "$NUGGETS_USER_ID:$NUGGETS_USER_ID" "$UPLOADS_PATH"
    sudo chown -R "$NUGGETS_USER_ID:$NUGGETS_USER_ID" "$BACKUPS_PATH"
    sudo chown -R "$NUGGETS_USER_ID:$NUGGETS_USER_ID" "$TEMP_PATH"
    sudo chown -R "$NUGGETS_USER_ID:$NUGGETS_USER_ID" "$LOGS_PATH"

    # Set ownership for PostgreSQL data directory
    sudo chown -R "$POSTGRES_USER_ID:$POSTGRES_USER_ID" "$POSTGRES_DATA_PATH"

    # Owner-only: receipts, database files and backups
    # (deploy.sh's own dumps are unencrypted) stay away from other users on the host.
    sudo chmod 700 "$UPLOADS_PATH" "$BACKUPS_PATH" "$TEMP_PATH" "$LOGS_PATH" "$POSTGRES_DATA_PATH"

    # Set secure permissions for secrets directory
    sudo chown -R root:root "$SECRETS_BASE_PATH"
    sudo chmod 700 "$SECRETS_BASE_PATH"
    
    secure_secret_files

    log_success "Directory permissions configured"
}

# Compose `file:` secrets are bind mounts: the containers, which run as non-root uids,
# see these exact modes. So each file is 0600 root:root, plus read access for exactly
# the uids that consume it: the backend reads every secret,
# postgres only its own password.
secure_secret_files() {
    [[ -d "$SECRETS_BASE_PATH" ]] || return 0
    for secret_file in "$SECRETS_BASE_PATH"/*.txt; do
        [[ -f "$secret_file" ]] || continue
        sudo chown root:root "$secret_file"
        sudo chmod 600 "$secret_file"
        sudo setfacl -m "u:${NUGGETS_USER_ID}:r" "$secret_file"
    done
    if [[ -f "$SECRETS_BASE_PATH/db_password.txt" ]]; then
        sudo setfacl -m "u:${POSTGRES_USER_ID}:r" "$SECRETS_BASE_PATH/db_password.txt"
    fi
}

# =============================================================================
# SECRETS MANAGEMENT
# =============================================================================

# Writes $2 random bytes to the secret file $1, base64 with no newline anywhere:
# `openssl rand -base64` breaks its output every 64 characters and ends it with a
# newline, and a secret file holds its value exactly.
write_random_secret() {
    openssl rand -base64 "$2" | tr -d '\n' | sudo tee "$1" > /dev/null
}

# db_password.txt is read by two programs, which must get the same password from it.
# The postgres image's first start reads it with $(< file), which drops its trailing
# newlines (and any NUL byte), signs in with that during its own setup, and has initdb set
# the first line of it, less a CR at its end, as the password. The backend trims whitespace
# from both ends. So a CR or spaces at the end of the line (CRLF line endings, say) make
# Postgres's first start fail or give it a password the backend doesn't send; so does
# whitespace at the start, or a line break or NUL byte inside. Whitespace at the end alone
# is cut from the file, which stays the same file (its owner, mode and ACLs too); anything
# else is refused, since which password was meant is the file's owner's call. The other
# secret files are read by the backend alone, which trims them, so they are left as they
# are. The backend refuses a db_password Postgres would read differently (also for Unicode
# whitespace, which this leaves to it).
check_db_password_file() {
    local file="$SECRETS_BASE_PATH/db_password.txt"
    sudo test -f "$file" || return 0
    local size content value lead trail postgres
    size=$(sudo cat "$file" | wc -c)
    # Counted, not read into a variable: $(…) drops NUL bytes without a word.
    if [[ "$(sudo cat "$file" | tr -d '\000' | wc -c)" != "$size" ]]; then
        log_error "$file has a NUL byte in it, so Postgres and the backend would read different passwords from it. Write the password alone on one line, with nothing before or after it, then run this again."
    fi
    # Postgres takes the file's bytes and the backend reads it as UTF-8, so a byte that isn't
    # UTF-8 (an "é" a Windows editor saved as Latin-1) gives two different passwords.
    if command -v iconv > /dev/null 2>&1 && ! sudo cat "$file" | iconv -f UTF-8 -t UTF-8 > /dev/null 2>&1; then
        log_error "$file isn't UTF-8 text (a character saved in another encoding, as some Windows editors do), so the backend wouldn't read the password Postgres has. Save it as UTF-8, then run this again."
    fi
    # The trailing x keeps the file's own trailing newlines, which $(…) would drop.
    content="$(sudo cat "$file"; printf x)"
    content="${content%x}"
    lead="${content%%[![:space:]]*}"
    trail="${content##*[![:space:]]}"
    value="${content#"$lead"}"
    value="${value%"$trail"}"
    postgres="$content"
    while [[ "$postgres" == *$'\n' ]]; do postgres="${postgres%$'\n'}"; done
    if [[ "$postgres" == "$value" && "$value" != *$'\n'* && "$content" != $'\xef\xbb\xbf'* ]]; then
        return 0
    fi
    if [[ -n "$lead" || "$content" == $'\xef\xbb\xbf'* ]]; then
        log_error "$file starts with whitespace (the backend drops it, Postgres keeps it), so Postgres and the backend would read different passwords from it. Write the password alone on one line, with nothing before or after it, then run this again."
    fi
    if [[ "$value" == *$'\n'* ]]; then
        log_error "$file has a line break inside the password (Postgres takes only its first line), so Postgres and the backend would read different passwords from it. Write the password alone on one line, with nothing before or after it, then run this again."
    fi
    # Only whitespace at the end is wrong: cut it, keeping a final newline if there was one.
    sudo truncate -s "$(( size - $(printf '%s' "$trail" | wc -c) ))" "$file"
    if [[ "$trail" == *$'\n' ]]; then
        printf '\n' | sudo tee -a "$file" > /dev/null
    fi
    log_warning "Removed the whitespace after the password at the end of $file (a carriage return from CRLF line endings, or spaces): the backend drops it and Postgres doesn't."
    log_warning "If Postgres has already been started with the old file and the backend can't sign in, set the database password to the file's (ALTER ROLE ... PASSWORD); on a new install with no data yet, you can instead empty POSTGRES_DATA_PATH and deploy again."
}

setup_secrets() {
    log_info "Setting up Docker secrets..."
    
    local secret_files=(
        "db_password.txt"
        "app_db_password.txt"
        "jwt_secret.txt"
        "session_secret.txt"
        "csrf_secret.txt"
        "data_encryption_key.txt"
    )
    
    for secret_file in "${secret_files[@]}"; do
        local secret_path="$SECRETS_BASE_PATH/$secret_file"
        
        if [[ ! -f "$secret_path" ]]; then
            log_warning "Secret file missing: $secret_file"

            # The sizes scripts/generate-secrets.js uses.
            case "$secret_file" in
                "db_password.txt")
                    log_info "Generating database password..."
                    write_random_secret "$secret_path" 32
                    ;;
                "app_db_password.txt")
                    # The unprivileged role the app serves as (nuggets_app).
                    log_info "Generating the app database role's password..."
                    write_random_secret "$secret_path" 32
                    ;;
                "jwt_secret.txt")
                    log_info "Generating JWT secret..."
                    write_random_secret "$secret_path" 64
                    ;;
                "session_secret.txt")
                    log_info "Generating session secret..."
                    write_random_secret "$secret_path" 32
                    ;;
                "csrf_secret.txt")
                    log_info "Generating CSRF secret..."
                    write_random_secret "$secret_path" 32
                    ;;
                "data_encryption_key.txt")
                    log_info "Generating data encryption key..."
                    # HKDF-derived at load, so any secret >= 32 chars works.
                    write_random_secret "$secret_path" 32
                    ;;
            esac
            
        fi
    done

    check_db_password_file
    secure_secret_files
    log_success "Docker secrets configured"
}

# =============================================================================
# DOCKER FUNCTIONS
# =============================================================================

# docker compose on the production file, with the environment file's settings. Naming
# it with --env-file keeps compose from also reading a .env in the repository (the
# development one, if this checkout has it).
compose() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

create_networks() {
    log_info "Creating Docker networks..."

    # Create external frontend network if it doesn't exist (by its exact name: a
    # `docker network ls | grep` would also match another stack's "x_frontend").
    if ! docker network inspect frontend &> /dev/null; then
        log_info "Creating frontend network..."
        docker network create frontend
    fi

    log_success "Docker networks ready"
}

build_images() {
    log_info "Building Docker images..."

    # Build production images
    compose build --no-cache

    log_success "Docker images built successfully"
}

# =============================================================================
# DATABASE FUNCTIONS
# =============================================================================

# What `backup` names its dumps: nuggets_backup_YYYYMMDD_HHMMSS.sql, in UTC, so the names
# sort in the order they were made.
BACKUP_DUMP_GLOB='nuggets_backup_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9].sql'

# Delete all but the newest DEPLOY_BACKUP_KEEP of this script's dumps (none when it is 0).
# Only its own: files named as it names them, never the app's encrypted backups beside them.
prune_backups() {
    local keep="${DEPLOY_BACKUP_KEEP:-10}"
    (( keep > 0 )) || return 0
    local old=()
    mapfile -t old < <(sudo find "$BACKUPS_PATH" -maxdepth 1 -type f -name "$BACKUP_DUMP_GLOB" -printf '%f\n' \
        | sort -r | tail -n +"$((keep + 1))")
    (( ${#old[@]} > 0 )) || return 0
    local file
    for file in "${old[@]}"; do
        sudo rm -f -- "$BACKUPS_PATH/$file"
    done
    log_info "Removed ${#old[@]} older dump(s), keeping the newest $keep (DEPLOY_BACKUP_KEEP)"
}

backup_database() {
    log_info "Creating database backup..."

    local backup_file
    backup_file="nuggets_backup_$(date -u +%Y%m%d_%H%M%S).sql"
    local backup_path="$BACKUPS_PATH/$backup_file"

    # Only backup if database is running
    if [[ -n "$(compose ps -q --status running postgres)" ]]; then
        # As the database's owner, with the password from its secret (the image asks for
        # one on its socket too), and the role and database the compose file gave it.
        # BACKUPS_PATH belongs to the backend's uid, hence sudo. The file is made owner-only
        # before the first byte of the (unencrypted) dump goes in.
        sudo install -m 600 /dev/null "$backup_path"
        # shellcheck disable=SC2016 # expanded by the container's shell
        if ! compose exec -T postgres sh -c \
            'PGPASSWORD="$(cat /run/secrets/db_password)" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
            | sudo tee "$backup_path" > /dev/null; then
            sudo rm -f "$backup_path"
            log_error "pg_dump failed (above); no backup written"
        fi

        log_success "Database backup created: $backup_file"
        prune_backups
    else
        log_warning "Database not running, skipping backup"
    fi
}

# =============================================================================
# DEPLOYMENT FUNCTIONS
# =============================================================================

deploy_application() {
    log_info "Deploying Nuggets application..."

    # Stop existing services
    compose down

    # Start services
    compose up -d

    # Wait for services to be healthy
    log_info "Waiting for services to start..."
    sleep 30

    # Check service health
    compose ps

    log_success "Application deployed successfully"
}

update_application() {
    log_info "Updating Nuggets application..."

    cd "$PROJECT_DIR"

    # Pull latest changes (if in git repo)
    if [[ -d ".git" ]]; then
        log_info "Pulling latest changes..."
        git pull
        # Again, for the variables the pulled compose file reads.
        load_environment
    fi

    # A secret file a newer compose file mounts must exist first.
    setup_secrets

    # Rebuild images
    build_images

    # Restart services
    compose up -d --force-recreate

    log_success "Application updated successfully"
}

restart_application() {
    log_info "Restarting Nuggets application..."

    compose restart

    log_success "Application restarted successfully"
}

# =============================================================================
# MAIN DEPLOYMENT LOGIC
# =============================================================================

main() {
    log_info "Starting Nuggets deployment..."
    log_info "Environment: $ENVIRONMENT"
    log_info "Action: $ACTION"
    
    # Always check requirements and load environment
    check_requirements
    load_environment
    
    case "$ACTION" in
        "deploy")
            create_directories
            set_permissions
            setup_secrets
            create_networks
            build_images
            deploy_application
            ;;
        "update")
            update_application
            ;;
        "restart")
            restart_application
            ;;
        "backup")
            backup_database
            ;;
        "setup")
            create_directories
            set_permissions
            setup_secrets
            create_networks
            ;;
        *)
            log_error "Unknown action: $ACTION. Valid actions: deploy, update, restart, backup, setup"
            ;;
    esac
    
    log_success "Deployment completed successfully!"
    # Set (to DOMAIN_URL unless the env file names another) in load_environment.
    log_info "Application should be available at: $CLIENT_URL"
}

# =============================================================================
# SCRIPT EXECUTION
# =============================================================================

# Show help if requested
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Nuggets Application Deployment Script"
    echo ""
    echo "Usage: $0 [environment] [action]"
    echo ""
    echo "Environments:"
    echo "  production    Use production.env configuration"
    echo ""
    echo "Actions:"
    echo "  deploy        Full deployment (default)"
    echo "  update        Update application only"
    echo "  restart       Restart services only"
    echo "  backup        Create database backup"
    echo "  setup         Setup directories and secrets only"
    echo ""
    echo "Examples:"
    echo "  $0 production deploy"
    echo "  $0 production update"
    echo "  $0 production backup"
    exit 0
fi

# Run main function (not when sourced, so its functions can be tried on their own)
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi