@echo off
setlocal DisableDelayedExpansion
set "RDK_PLUGIN_SETUP_HOST=qoder"
call "%~dp0setup-windows.cmd"
exit /b %errorlevel%
