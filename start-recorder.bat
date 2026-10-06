@echo off
cd /d "%~dp0"

rem One recorder window per env file (env.live1 .. env.live4, 10 bots each).
rem Close a window with Ctrl+C and wait for "Done." so its files get finalized.
for %%F in (env.live1 env.live2 env.live3 env.live4) do (
  if exist %%F (
    echo Starting %%F
    start "Recorder %%F" cmd /k node record.js %%F
  ) else (
    echo Skipping %%F - not found
  )
)
