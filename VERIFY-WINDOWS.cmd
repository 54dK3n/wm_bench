@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Current version:
  node --version
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Reinstall Node.js 22.13 or newer with npm enabled.
  exit /b 1
)
if not exist "projects\tmm\node_modules\vinext\dist\cli.js" (
  echo Workshop dependencies are missing. Run INSTALL-DEPENDENCIES.cmd first.
  exit /b 1
)

call npm.cmd run check
if errorlevel 1 exit /b 1
call npm.cmd test
if errorlevel 1 exit /b 1

pushd "projects\blockly-page3"
call npm.cmd test
if errorlevel 1 (
  popd
  exit /b 1
)
popd

pushd "projects\tmm"
call npm.cmd test
if errorlevel 1 (
  popd
  exit /b 1
)
popd

echo Delivery verification passed.
exit /b 0
