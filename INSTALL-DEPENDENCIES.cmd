@echo off
setlocal
cd /d "%~dp0projects\tmm"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer and npm are required.
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

if not exist "package-lock.json" (
  echo package-lock.json is missing; refusing a non-reproducible install.
  pause
  exit /b 1
)

call npm.cmd ci --no-audit --no-fund
exit /b %errorlevel%
