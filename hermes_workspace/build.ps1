$ErrorActionPreference = 'Stop'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'Для сборки нужен .NET 8 SDK.' }
& dotnet run --project "$PSScriptRoot/tests/Workspace.Tests.csproj" -c Release
if ($LASTEXITCODE -ne 0) { throw 'Workspace tests failed.' }
& dotnet run --project "$PSScriptRoot/tests/tree-tests/Tree.Tests.csproj" -c Release
if ($LASTEXITCODE -ne 0) { throw 'Tree persistence tests failed.' }
& dotnet run --project "$PSScriptRoot/apps/hermes-chat-tests/ProfileLogicTests.csproj" -c Release
if ($LASTEXITCODE -ne 0) { throw 'Hermes compatibility tests failed.' }
& dotnet publish "$PSScriptRoot/apps/hermes-chat-windows/HermesChat.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$PSScriptRoot/Windows"
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Ready: $PSScriptRoot/Windows/HermesWorkspace.exe"
