#!/bin/bash

# Browser Download Manager - Quick Start & Build

echo "⚡ Browser Download Manager - Quick Start"
echo "=========================================="
echo ""

# 1. Verify project structure
echo "✓ Project structure:"
ls -la . | grep -E "index.html|README|CODE_REVIEW"
echo ""

# 2. Check file sizes
echo "✓ File sizes:"
du -sh js/*.js css/*.css workers/*.js 2>/dev/null | sort -h
echo ""

# 3. Total size
echo "✓ Total unminified size:"
du -sh .
echo ""

# 4. Quick minification (if esbuild available)
if command -v esbuild &> /dev/null; then
    echo "✓ Minifying for production..."
    mkdir -p dist
    
    # Bundle all JS
    esbuild js/app.js \
        --bundle \
        --minify \
        --target=es2020 \
        --outfile=dist/app.min.js 2>/dev/null && echo "  ✓ JS minified to dist/app.min.js" || echo "  ⚠ JS minification skipped"
    
    # CSS minification (simple approach)
    npx cssnano css/styles.css --output dist/styles.min.css 2>/dev/null && echo "  ✓ CSS minified to dist/styles.min.css" || echo "  ⚠ CSS minification skipped"
    
    # Report size reduction
    echo ""
    echo "✓ Size comparison:"
    echo "  Original: $(du -sh . | cut -f1)"
    echo "  Minified: $(du -sh dist 2>/dev/null | cut -f1 || echo 'varies')"
    echo ""
else
    echo "⚠ esbuild not found - skip minification step"
    echo "  Install with: npm install -g esbuild"
    echo ""
fi

# 5. Generate report
echo "✓ Project is ready!"
echo ""
echo "Next steps:"
echo "  1. Open index.html in your browser"
echo "  2. Read CODE_REVIEW_FIXES.md for optimization checklist"
echo "  3. Apply critical fixes (Priority: 1-2 hours)"
echo "  4. Run performance tests"
echo ""
echo "Production deployment:"
echo "  - Minify JS/CSS (esbuild recommended)"
echo "  - Test on multiple browsers"
echo "  - Host on any static hosting (no server needed)"
echo ""
