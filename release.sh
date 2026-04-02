#!/usr/bin/env bash
# Usage: ./release.sh <version> [changelog]
# Example: ./release.sh 0.1.1 "fix: URI normalization"

set -euo pipefail

VERSION="${1:?Usage: ./release.sh <version> [changelog]}"
CHANGELOG="${2:-}"

echo "→ Releasing v$VERSION..."

# 1. Bump version
npm version "$VERSION" --no-git-tag-version
echo "  ✓ package.json → $VERSION"

# 2. Run unit tests
npm run test:unit
echo "  ✓ Unit tests passed"

# 3. Commit + tag
git add package.json
git commit -m "chore: release v$VERSION${CHANGELOG:+ — $CHANGELOG}"
git tag "v$VERSION"
git push && git push --tags
echo "  ✓ Committed and pushed tag v$VERSION"

# 4. Publish to npm
npm publish
echo "✓ Published openclaw-openviking-plugin@$VERSION to npm"
