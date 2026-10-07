#!/bin/bash
cd "$(dirname "$0")" || exit 1
(sleep 2; open "http://localhost:${DASH_PORT:-3000}") &
node dashboard.js
read -n 1 -s -r -p "Dashboard stopped. Press any key to close."
