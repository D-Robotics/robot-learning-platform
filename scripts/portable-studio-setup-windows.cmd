@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "RDK_PORTABLE_STUDIO_SETUP_FILE=%~dp0setup-studio-windows.ps1"
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:RDK_PORTABLE_STUDIO_SETUP_FILE))); exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
set "CODE=%errorlevel%"
if not "%CODE%"=="0" echo Setup stopped. Follow the message above.
if /I not "%CI%"=="true" pause
exit /b %CODE%
