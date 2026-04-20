#!/bin/bash
# Build the Plexus CRDT preprint stack via Docker (clean env, no local tex dependency).

set -e

cd "$(dirname "$0")"

docker build -t plexus-papers . >/dev/null

docker run --rm -v "$(pwd)/output:/papers/output" plexus-papers

echo ""
echo "PDFs in: ./output/"
