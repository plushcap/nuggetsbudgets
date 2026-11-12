#!/bin/bash

# GitHub Container Registry Setup and Deployment Script
# This script builds and pushes Nuggets images to the GitHub Container Registry
#
# Usage: scripts/deploy-to-ghcr.sh            # tags the images "latest"
#        IMAGE_TAG=1.4.2 scripts/deploy-to-ghcr.sh
# The stack runs a tag other than latest when NUGGETS_IMAGE_TAG says so
# (docker-compose.portainer.yml). CI builds and pushes these images on release tags; this
# is for doing it by hand.

set -e  # Exit on any error

# Configuration
IMAGE_OWNER="plushcap"                  # The account or organization the images go under, lowercase
REPO_NAME="nuggets"                     # The images' name prefix
IMAGE_TAG="${IMAGE_TAG:-latest}"        # or a release version, e.g. 1.4.2

# GitHub Container Registry URLs
BACKEND_IMAGE="ghcr.io/${IMAGE_OWNER}/${REPO_NAME}-backend:${IMAGE_TAG}"
FRONTEND_IMAGE="ghcr.io/${IMAGE_OWNER}/${REPO_NAME}-frontend:${IMAGE_TAG}"
POSTGRES_IMAGE="ghcr.io/${IMAGE_OWNER}/${REPO_NAME}-postgres:${IMAGE_TAG}"

# Every Dockerfile builds with the repository root as its context.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "🚀 Nuggets - GitHub Container Registry Deployment"
echo "================================================="
echo "Backend Image:  ${BACKEND_IMAGE}"
echo "Frontend Image: ${FRONTEND_IMAGE}"
echo "Postgres Image: ${POSTGRES_IMAGE}"
echo ""

# Check if logged in to GitHub Container Registry (docker login records it in the
# client config, whichever credential store keeps the secret).
echo "🔐 Checking GitHub Container Registry authentication..."
if ! grep -q '"ghcr.io"' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then
    echo "❌ Not logged in to GitHub Container Registry"
    echo "Please run: echo \$GITHUB_TOKEN | docker login ghcr.io -u <your GitHub username> --password-stdin"
    echo "(a token that may write ${IMAGE_OWNER}'s packages)"
    echo ""
    echo "📝 To create a GitHub Personal Access Token:"
    echo "1. Go to GitHub Settings > Developer settings > Personal access tokens"
    echo "2. Generate new token with 'write:packages' and 'read:packages' scopes"
    echo "3. Export it: export GITHUB_TOKEN=your_token_here"
    exit 1
fi

echo "✅ GitHub Container Registry authentication verified"
echo ""

# Build backend image
echo "🔨 Building backend image..."
docker build -f backend/Dockerfile.prod -t "${BACKEND_IMAGE}" .
echo "✅ Backend image built successfully"
echo ""

# Build frontend image
echo "🔨 Building frontend image..."
docker build -f frontend/Dockerfile.prod -t "${FRONTEND_IMAGE}" .
echo "✅ Frontend image built successfully"
echo ""

# Build postgres image (the baseline schema baked in)
echo "🔨 Building postgres image..."
docker build -f Dockerfile.postgres -t "${POSTGRES_IMAGE}" .
echo "✅ Postgres image built successfully"
echo ""

# Push images to registry
echo "📤 Pushing images to GitHub Container Registry..."
docker push "${BACKEND_IMAGE}"
echo "✅ Backend image pushed successfully"

docker push "${FRONTEND_IMAGE}"
echo "✅ Frontend image pushed successfully"

docker push "${POSTGRES_IMAGE}"
echo "✅ Postgres image pushed successfully"
echo ""

# Display next steps
echo "🎉 SUCCESS! Images pushed to GitHub Container Registry"
echo ""
echo "📋 Next Steps:"
echo "1. In the Portainer stack (docker-compose.portainer.yml), set NUGGETS_IMAGE_TAG=${IMAGE_TAG}"
echo "   (or leave it unset for latest) and redeploy with re-pull"
echo "2. New packages are private: make them public (on github.com, each package's Package"
echo "   settings > Change visibility; it can't be undone), or give Portainer a registry"
echo "   login that can read them"
echo ""
echo "🔗 The images:"
echo "   ${BACKEND_IMAGE}"
echo "   ${FRONTEND_IMAGE}"
echo "   ${POSTGRES_IMAGE}"
