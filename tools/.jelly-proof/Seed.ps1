param(
    [Parameter(Mandatory = $true)][string] $FixtureDirectory,
    [Parameter(Mandatory = $true)][string] $ServerUrl
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'Seeder\Seeder.csproj'
# The old seeder-bin binary ignores ServerUrl and is pinned to port 3973.
# Build from the owner source instead of trusting a previous proof's output.
dotnet run --project $project --configuration Release -- $FixtureDirectory $ServerUrl
if ($LASTEXITCODE -ne 0) { throw "The fixture seeder exited with code $LASTEXITCODE." }
