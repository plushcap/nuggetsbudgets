#!/bin/bash

# Database Migration Helper Script for Nuggets
# Simplifies running migrations in Docker environment

set -e

CONTAINER="nuggets_backend"
COMMAND="${1:-status}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo -e "${RED}Error: Container ${CONTAINER} is not running${NC}"
    echo "Start it with: docker compose up -d"
    exit 1
fi

case "$COMMAND" in
    status|s)
        echo -e "${BLUE}Checking migration status...${NC}"
        docker exec "$CONTAINER" npm run migrate:status
        ;;

    migrate|up|m)
        echo -e "${YELLOW}Running pending migrations...${NC}"
        docker exec "$CONTAINER" npm run migrate
        ;;

    rollback|down|r)
        COUNT="${2:-1}"
        echo -e "${YELLOW}Rolling back last ${COUNT} migration(s)...${NC}"
        # A production container asks to confirm, which needs a terminal.
        if [ -t 0 ]; then
            docker exec -it "$CONTAINER" npm run migrate:rollback -- "$COUNT"
        else
            docker exec "$CONTAINER" npm run migrate:rollback -- "$COUNT"
        fi
        ;;

    create|new|c)
        echo -e "${GREEN}Creating new migration...${NC}"
        docker exec -it "$CONTAINER" npm run migrate:create
        ;;

    help|h|--help)
        echo "Database Migration Helper for Nuggets"
        echo ""
        echo "Usage: ./migrate.sh [command] [options]"
        echo ""
        echo "Commands:"
        echo "  status, s              Check migration status"
        echo "  migrate, up, m         Run pending migrations"
        echo "  rollback, down, r [N]  Rollback last N migrations (default: 1)"
        echo "  create, new, c         Create a new migration file"
        echo "  help, h                Show this help message"
        echo ""
        echo "Examples:"
        echo "  ./migrate.sh status         # Check status"
        echo "  ./migrate.sh migrate        # Run migrations"
        echo "  ./migrate.sh rollback       # Rollback 1 migration"
        echo "  ./migrate.sh rollback 3     # Rollback 3 migrations"
        echo "  ./migrate.sh create         # Create new migration"
        ;;

    *)
        echo -e "${RED}Unknown command: $COMMAND${NC}"
        echo "Run './migrate.sh help' for usage"
        exit 1
        ;;
esac
