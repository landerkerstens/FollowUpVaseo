#!/bin/sh
# Alle tests zonder extra installatie: JavaScriptCore en Python zitten standaard op een Mac.
set -e
cd "$(dirname "$0")/.."
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc public/core.js tests/core.test.js
python3 -m unittest discover -s tests -p "test_*.py"
