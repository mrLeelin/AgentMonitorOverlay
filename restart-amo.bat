@echo off
setlocal
set "PSModulePath="
node "%~dp0studio\scripts\restart-studio.mjs"
set "AMO_RESTART_EXIT=%ERRORLEVEL%"
if not "%AMO_RESTART_EXIT%"=="0" pause
exit /b %AMO_RESTART_EXIT%
