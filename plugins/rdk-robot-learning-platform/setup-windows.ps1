$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [IO.Path]::GetDirectoryName($env:RDK_PLUGIN_SETUP_FILE)
if (-not $root) { throw 'Run setup-windows.cmd from the complete plugin folder.' }
function Test-CompatibleNode([string]$executable) {
  if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $false }
  & $executable -e 'const v=process.versions.node.match(/\d+/g).map(Number);process.exit((v[0]===22&&(v[1]>22||(v[1]===22&&v[2]>=2)))||(v[0]===24&&v[1]>=15)||v[0]>=26?0:1)' 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$temp = $null
try {
  if (-not (Test-CompatibleNode $node)) {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $target = 'win32-arm64' }
    elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { $target = 'win32-x64' }
    else { throw 'This installer requires 64-bit Windows (x64 or ARM64).' }
    $manifest = Get-Content -LiteralPath (Join-Path $root 'runtime-downloads.json') -Raw | ConvertFrom-Json
    $runtime = $manifest.targets.$target
    if (-not $runtime -or -not $runtime.url.StartsWith('https://nodejs.org/dist/') -or $runtime.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Runtime source or checksum is invalid.' }
    $cacheBase = if ($env:RDK_PLUGIN_RUNTIME_CACHE) { $env:RDK_PLUGIN_RUNTIME_CACHE } else { Join-Path $HOME '.config\rdk-robot-learning-platform\runtimes' }
    $cache = Join-Path (Join-Path $cacheBase ('v' + $manifest.version)) $target
    $destination = Join-Path $cache $runtime.folder
    $node = Join-Path $destination 'node.exe'
    if (-not (Test-CompatibleNode $node)) {
      New-Item -ItemType Directory -Path $cache -Force | Out-Null
      $temp = Join-Path $cache ('.download.' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $temp | Out-Null
      $archive = Join-Path $temp 'node.zip'
      Write-Host ('Preparing verified Node.js ' + $manifest.version + ' for this Windows user...')
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri $runtime.url -OutFile $archive -TimeoutSec 180
      $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $runtime.sha256) { throw 'Runtime checksum mismatch; installation stopped.' }
      Expand-Archive -LiteralPath $archive -DestinationPath $temp
      if (Test-Path -LiteralPath $destination) { throw 'Existing runtime is invalid; check the private cache before retrying.' }
      Move-Item -LiteralPath (Join-Path $temp $runtime.folder) -Destination $destination
    }
  }
  if ($env:RDK_PLUGIN_SETUP_HOST -eq 'qoder') {
    & $node (Join-Path $root 'setup.mjs') --host qoder
  } else {
    & $node (Join-Path $root 'setup.mjs')
  }
  if ($LASTEXITCODE -ne 0) { throw 'Plugin configuration was not completed. Read the message above.' }
} finally {
  if ($temp -and (Test-Path -LiteralPath $temp)) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
