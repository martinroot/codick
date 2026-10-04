$ErrorActionPreference = 'Stop'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'Install .NET 8 SDK, then run this script again.' }
& dotnet run --project (Join-Path $PSScriptRoot 'tests/PulsePilot.FlowTests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'Flow tests failed.' }
& dotnet publish (Join-Path $PSScriptRoot 'src/PulsePilot.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $PSScriptRoot 'dist')
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Ready: $PSScriptRoot/dist/PulsePilot.exe"
