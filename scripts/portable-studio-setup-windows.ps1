$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-NativeArchitecture {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class RdkPortableStudioArchitecture {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWow64Process2(
        IntPtr process, out ushort processMachine, out ushort nativeMachine);

    public static ushort NativeMachine() {
        using (Process process = Process.GetCurrentProcess()) {
            ushort processMachine, nativeMachine;
            return IsWow64Process2(process.Handle, out processMachine, out nativeMachine)
                ? nativeMachine : (ushort)0;
        }
    }
}
'@
    switch ([RdkPortableStudioArchitecture]::NativeMachine()) {
      0xAA64 { return 'arm64' }
      0x8664 { return 'x64' }
    }
  } catch {
    # Fall back to the OS-provided environment when the native call is unavailable.
  }
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    return 'arm64'
  }
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64' -or $env:PROCESSOR_ARCHITECTURE -eq 'AMD64') {
    return 'x64'
  }
  throw 'This package requires 64-bit Windows (x64 or ARM64).'
}

$root = [IO.Path]::GetDirectoryName($env:RDK_PORTABLE_STUDIO_SETUP_FILE)
$directory = Join-Path $root 'mcp/runtime'
if (-not (Test-Path -LiteralPath (Join-Path $directory 'provenance.json') -PathType Leaf)) {
  $directory = Join-Path $directory ('win32-' + (Get-NativeArchitecture))
}
$node = Join-Path $directory 'node.exe'
$runtime = Get-Content -LiteralPath (Join-Path $directory 'provenance.json') -Raw | ConvertFrom-Json
$info = Get-Item -LiteralPath $node
if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    $runtime.binarySha256 -notmatch '^[a-f0-9]{64}$' -or
    (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.binarySha256) {
  throw 'Node checksum failed. Extract the verified archive again.'
}
& $node (Join-Path $root 'setup-studio.mjs')
exit $LASTEXITCODE
