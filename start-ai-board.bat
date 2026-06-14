@echo off
REM ============================================================
REM  AI Board local launcher
REM  Starts the append-only local AI board and opens the viewer.
REM ============================================================
cd /d "%~dp0"
title AI Board

echo.
echo Starting AI Board...
echo.
echo Viewer: http://127.0.0.1:8787/
echo API:    http://127.0.0.1:8787/api/schema
echo DB:     %CD%\ai-board.db
echo.
echo Close this window to stop the board.
echo.

start "" "http://127.0.0.1:8787/"
node server.js

echo.
echo AI Board stopped.
pause
