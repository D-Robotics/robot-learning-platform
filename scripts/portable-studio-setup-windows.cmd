@echo off
setlocal
set "RDK_PORTABLE_STUDIO_SETUP_DIR=%~dp0"
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $root=$env:RDK_PORTABLE_STUDIO_SETUP_DIR; $node=Join-Path $root 'mcp/runtime/node.exe'; $runtime=Get-Content -LiteralPath (Join-Path $root 'mcp/runtime/provenance.json') -Raw | ConvertFrom-Json; if ($runtime.binarySha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.binarySha256) { throw 'Node checksum failed. Extract the verified archive again.' }; & $node (Join-Path $root 'setup-studio.mjs'); exit $LASTEXITCODE"
set "CODE=%errorlevel%"
if not "%CODE%"=="0" echo Setup stopped. Follow the message above.
pause
exit /b %CODE%
