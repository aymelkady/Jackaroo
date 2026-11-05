#!/usr/bin/env sh
# Assemble the static site for GitHub Pages (or any static host): public/ + shared/ into dist/.
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -R public/. dist/
cp -R shared dist/shared
# Default: the owner's Render server. The JK_SERVER repository variable (see .github/workflows/pages.yml) overrides it.
printf "window.JK_MODE = 'p2p';\nwindow.JK_SERVER = '%s';\n" "${JK_SERVER:-https://jackaroo.onrender.com}" > dist/config.js
cp public/index.html dist/404.html
touch dist/.nojekyll
echo "built dist/ ($(find dist -type f | wc -l) files)"
