@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Reinstall Node.js 22.13 or newer with npm enabled.
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Current version:
  node --version
  pause
  exit /b 1
)

if not exist "projects\tmm\node_modules\vinext\dist\cli.js" (
  echo Workshop dependencies are missing. Run INSTALL-DEPENDENCIES.cmd first.
  pause
  exit /b 1
)

echo Starting the unified gateway. Only port 6190 should be exposed by a reverse proxy.
call npm.cmd run start:all
exit /b %errorlevel%
