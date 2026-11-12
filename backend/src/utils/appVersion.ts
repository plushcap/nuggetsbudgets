/**
 * Which build of Nuggets this is. The release workflow bakes both into the backend
 * image as build arguments (backend/Dockerfile.prod, .github/workflows/docker-build-deploy.yml):
 * APP_VERSION is the image's version tag (1.4.2 for the v1.4.2 release; the branch, such as
 * `main`, for a manual build of one) and GIT_SHA the commit it was built from. A build
 * without them (a development container, the tests, a `docker build` by hand) is 'unknown'.
 */

import { config } from '../config.js';
export function appVersion(): string {
  return config().APP_VERSION || 'unknown';
}

export function appCommit(): string {
  return config().GIT_SHA || 'unknown';
}
