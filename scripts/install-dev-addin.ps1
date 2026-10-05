param([string]$BuildDirectory = (Join-Path $PSScriptRoot '../src/revit/bin/Release/net48'))
$ErrorActionPreference = 'Stop'
if (Get-Process Revit -ErrorAction SilentlyContinue) { throw 'Cierra Revit normalmente y guarda tus documentos antes de instalar el add-in.' }
$build = (Resolve-Path -LiteralPath $BuildDirectory).Path
$assembly = Join-Path $build 'OrionMcp.Revit2024.dll'
if (-not (Test-Path -LiteralPath $assembly) -or -not (Test-Path -LiteralPath (Join-Path $build 'ui/index.html'))) { throw 'Compila el add-in y los assets antes de instalar.' }
$target = Join-Path $env:APPDATA 'Autodesk/Revit/Addins/2024/ORIONMCP.addin'
if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.backup-$([Guid]::NewGuid().ToString('N'))" }
$escaped = [System.Security.SecurityElement]::Escape($assembly)
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns><AddIn Type="Application"><Name>ORIONMCP</Name><Assembly>$escaped</Assembly><AddInId>6BF6ED91-0CA2-40E1-99D7-D207145A7C02</AddInId><FullClassName>OrionMcp.Revit2024.Application</FullClassName><VendorId>ORNM</VendorId><VendorDescription>ORIONMCP</VendorDescription></AddIn></RevitAddIns>
"@
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
[System.IO.File]::WriteAllText($target, $xml, [System.Text.UTF8Encoding]::new($false))
[xml]$verified = Get-Content -LiteralPath $target -Raw
if ($verified.RevitAddIns.AddIn.Assembly -ne $assembly) { throw 'No se pudo verificar el manifiesto instalado.' }
Write-Output "Manifiesto verificado: $target. Carga dentro de Revit todavía pendiente."
