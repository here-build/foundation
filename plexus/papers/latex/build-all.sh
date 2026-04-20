#!/bin/sh
# Build all Plexus CRDT preprint papers inside the container.

set -e

mkdir -p output

for paper in 1-partitioning 2-genesis 3-entity-oriented 4-liminality 5-keys; do
    if [ -f "${paper}.tex" ]; then
        echo "--- Building ${paper} ---"
        pdflatex -interaction=nonstopmode "${paper}.tex" > /dev/null
        bibtex "${paper}" > /dev/null 2>&1 || true
        pdflatex -interaction=nonstopmode "${paper}.tex" > /dev/null
        pdflatex -interaction=nonstopmode "${paper}.tex" > /dev/null
        cp "${paper}.pdf" "output/"
        echo "    output/${paper}.pdf"
    else
        echo "--- Skipping ${paper} (not yet converted) ---"
    fi
done

echo ""
echo "Done."
ls -la output/
