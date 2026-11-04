# Copies one file. Run with -File so neither path is ever parsed as code.
param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To)

$ErrorActionPreference = 'Stop'
Copy-Item -LiteralPath $From -Destination $To -Force
