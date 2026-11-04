@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "RDK_PLUGIN_SETUP_FILE=%~dp0setup-windows.ps1"
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:RDK_PLUGIN_SETUP_FILE))) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo Setup did not finish. Read the error above. Your sign-in was not changed.
  pause
  exit /b 1
)
pause
