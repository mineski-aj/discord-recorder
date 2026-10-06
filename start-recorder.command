#!/bin/bash
cd "$(dirname "$0")" || exit 1

# One recorder process per env file (env.live1 .. env.live4, 10 bots each).
pids=()
for f in env.live1 env.live2 env.live3 env.live4; do
  if [ -f "$f" ]; then
    echo "Starting $f"
    node record.js "$f" &
    pids+=($!)
  else
    echo "Skipping $f (not found)"
  fi
done

# Ctrl+C: ask every recorder to stop and finalize its files, then wait for all of them.
trap 'echo; echo "Stopping all recorders..."; kill -INT "${pids[@]}" 2>/dev/null' INT TERM
wait   # returns early when the trap fires
wait   # then wait for every recorder to finish finalizing

echo
read -n 1 -s -r -p "Recorders stopped. Press any key to close."
