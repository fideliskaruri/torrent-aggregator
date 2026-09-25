$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$publishDir = Join-Path $repoRoot 'artifacts\exe'
$apiProjectDir = Join-Path $repoRoot 'server\TorrentFlow.Api'
$objDir = Join-Path $apiProjectDir 'obj'
$webDist = Join-Path $repoRoot 'web\dist'
$generatedProps = Join-Path $objDir 'TorrentFlow.WebAssets.g.props'
$generatedManifest = Join-Path $objDir 'TorrentFlow.WebAssets.Manifest.xml'

function Escape-Xml([string]$value) {
    [System.Security.SecurityElement]::Escape($value)
}

function Get-ResourceName([string]$relativePath) {
    $normalized = $relativePath -replace '[\\/]+', '.'
    return "TorrentFlow.wwwroot.$normalized"
}

function Add-ManifestNode {
    param(
        [System.Text.StringBuilder]$Builder,
        [hashtable]$Node,
        [int]$Indent = 4
    )

    $pad = ' ' * $Indent
    foreach ($directoryName in ($Node.Keys | Where-Object { -not $_.StartsWith('file:') } | Sort-Object)) {
        [void]$Builder.AppendLine("$pad<Directory Name=`"$(Escape-Xml $directoryName)`">")
        Add-ManifestNode -Builder $Builder -Node $Node[$directoryName] -Indent ($Indent + 2)
        [void]$Builder.AppendLine("$pad</Directory>")
    }

    foreach ($fileKey in ($Node.Keys | Where-Object { $_.StartsWith('file:') } | Sort-Object)) {
        $file = $Node[$fileKey]
        [void]$Builder.AppendLine("$pad<File Name=`"$(Escape-Xml $file.Name)`">")
        [void]$Builder.AppendLine("$($pad)  <ResourcePath>$(Escape-Xml $file.ResourcePath)</ResourcePath>")
        [void]$Builder.AppendLine("$pad</File>")
    }
}

Push-Location $repoRoot
try {
    if (Test-Path $publishDir) {
        Remove-Item (Join-Path $publishDir '*') -Recurse -Force -ErrorAction SilentlyContinue
    }
    else {
        New-Item -ItemType Directory -Path $publishDir | Out-Null
    }

    Push-Location (Join-Path $repoRoot 'web')
    try {
        pnpm install --frozen-lockfile
        pnpm build
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path $webDist)) {
        throw "web/dist was not produced."
    }

    $files = Get-ChildItem -Path $webDist -File -Recurse | Sort-Object FullName
    $tree = @{}
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($webDist.Length).TrimStart('\', '/')
        $segments = $relative -split '[\\/]+'
        $node = $tree
        for ($i = 0; $i -lt $segments.Length; $i++) {
            $segment = $segments[$i]
            if ($i -eq $segments.Length - 1) {
                $node["file:$segment"] = [pscustomobject]@{
                    Name = $segment
                    ResourcePath = Get-ResourceName $relative
                }
            }
            else {
                if (-not $node.ContainsKey($segment)) {
                    $node[$segment] = @{}
                }
                $node = $node[$segment]
            }
        }
    }

    $manifestBuilder = [System.Text.StringBuilder]::new()
    [void]$manifestBuilder.AppendLine('<?xml version="1.0" encoding="utf-8" standalone="yes"?>')
    [void]$manifestBuilder.AppendLine('<Manifest>')
    [void]$manifestBuilder.AppendLine('  <ManifestVersion>1.0</ManifestVersion>')
    [void]$manifestBuilder.AppendLine('  <FileSystem>')
    [void]$manifestBuilder.AppendLine('    <Directory Name="wwwroot">')
    Add-ManifestNode -Builder $manifestBuilder -Node $tree -Indent 6
    [void]$manifestBuilder.AppendLine('    </Directory>')
    [void]$manifestBuilder.AppendLine('  </FileSystem>')
    [void]$manifestBuilder.AppendLine('</Manifest>')
    Set-Content -Path $generatedManifest -Value $manifestBuilder.ToString() -Encoding utf8

    $propsBuilder = [System.Text.StringBuilder]::new()
    [void]$propsBuilder.AppendLine('<Project>')
    [void]$propsBuilder.AppendLine('  <ItemGroup>')
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($webDist.Length).TrimStart('\', '/')
        $resourceName = Get-ResourceName $relative
        [void]$propsBuilder.AppendLine("    <EmbeddedResource Include=`"$(Escape-Xml $file.FullName)`">")
        [void]$propsBuilder.AppendLine("      <LogicalName>$(Escape-Xml $resourceName)</LogicalName>")
        [void]$propsBuilder.AppendLine('    </EmbeddedResource>')
    }
    [void]$propsBuilder.AppendLine("    <EmbeddedResource Include=`"$(Escape-Xml $generatedManifest)`">")
    [void]$propsBuilder.AppendLine('      <LogicalName>TorrentFlow.WebAssets.Manifest.xml</LogicalName>')
    [void]$propsBuilder.AppendLine('    </EmbeddedResource>')
    [void]$propsBuilder.AppendLine('  </ItemGroup>')
    [void]$propsBuilder.AppendLine('</Project>')
    Set-Content -Path $generatedProps -Value $propsBuilder.ToString() -Encoding utf8

    dotnet publish server\TorrentFlow.Api -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true `
        -p:DebugType=None `
        -p:DebugSymbols=false `
        -p:SkipWebBuild=true `
        -o $publishDir

    Get-ChildItem $publishDir -File | Where-Object Name -ne 'TorrentFlow.exe' | Remove-Item -Force
}
finally {
    Remove-Item $generatedProps, $generatedManifest -Force -ErrorAction SilentlyContinue
    Pop-Location
}
