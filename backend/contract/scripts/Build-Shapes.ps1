$ErrorActionPreference='Stop'
$root=(Resolve-Path "$PSScriptRoot\..\..\..").Path
$out="$root\backend\contract"
function Shape($values) {
    $values=@($values)
    $nonnull=@($values | Where-Object { $null -ne $_ })
    $kinds=@($values | ForEach-Object {
        if($null -eq $_){'null'}elseif($_ -is [System.Collections.IDictionary]){'object'}elseif($_ -is [array]){'array'}
        elseif($_ -is [bool]){'boolean'}elseif($_ -is [string]){'string'}else{'number'}
    } | Sort-Object -Unique)
    if(!$kinds.Count){return @{ 'x-unobserved'=$true }}
    $schema=[ordered]@{type=if($kinds.Count -eq 1){$kinds[0]}else{$kinds};'x-observedCount'=$values.Count}
    $objects=@($nonnull | Where-Object { $_ -is [System.Collections.IDictionary] })
    if($objects.Count) {
        $props=[ordered]@{};$required=@()
        $keys=@($objects | ForEach-Object { $_.Keys } | Sort-Object -Unique)
        foreach($key in $keys){
            $samples=[System.Collections.Generic.List[object]]::new()
            $present=0
            foreach($obj in $objects){if($obj.Contains($key) -or $obj.ContainsKey($key)){$samples.Add($obj[$key]);$present++}}
            $props[$key]=Shape $samples.ToArray()
            if($present -eq $objects.Count){$required+=$key}
        }
        $schema.properties=$props;$schema.required=$required;$schema.additionalProperties=$true
    }
    if($kinds -contains 'array'){
        $elements=[System.Collections.Generic.List[object]]::new()
        foreach($value in $nonnull){if($value -is [array]){foreach($item in $value){$elements.Add($item)}}}
        $schema.items=Shape $elements.ToArray()
    }
    return $schema
}
# Split only at top level, preserving nested object, union, generic and tuple syntax.
function Split-Top([string]$s,[string]$delimiter) {
    $depth=0;$quote=[char]0;$start=0;$parts=@()
    for($i=0;$i -lt $s.Length;$i++){
        $c=$s[$i]
        if($quote -ne [char]0){if($c -eq $quote -and ($i -eq 0 -or $s[$i-1] -ne '\')){$quote=[char]0};continue}
        if($c -in "'",'"','`'){$quote=$c;continue}
        if($c -in '{','[','(','<'){$depth++}
        elseif($c -in '}',']',')','>'){$depth--}
        elseif($depth -eq 0 -and $delimiter.Contains($c)){$parts+=$s.Substring($start,$i-$start).Trim();$start=$i+1}
    }
    $parts+=$s.Substring($start).Trim()
    return ,@($parts | Where-Object { $_ })
}
function Type-Shape([string]$t) {
    $t=$t.Trim().TrimEnd(';').Trim()
    if($t -match '^(?:readonly\s+)?(.+)\[\]$'){return @{type='array';items=(Type-Shape $Matches[1])}}
    if($t.StartsWith('{') -and $t.EndsWith('}')){
        $props=[ordered]@{};$required=@()
        foreach($field in (Split-Top $t.Substring(1,$t.Length-2) ";,`n")){
            if($field -match '^(?:readonly\s+)?(\w+)(\?)?\s*:\s*([\s\S]+)$'){
                $name=$Matches[1];$optional=$Matches[2];$value=$Matches[3]
                $props[$name]=Type-Shape $value
                if(!$optional){$required+=$name}
            }
        }
        return @{type='object';properties=$props;required=$required;additionalProperties=$true;'x-typescript'=$t}
    }
    $union=Split-Top $t '|'
    if($union.Count -gt 1){return @{anyOf=@($union|ForEach-Object{Type-Shape $_});'x-typescript'=$t}}
    if($t -in 'string','number','boolean','null'){return @{type=$t}}
    if($t -match '^["''](.*)["'']$'){return @{type='string';const=$Matches[1]}}
    if($t -match '^Record<string,\s*([\s\S]+)>$'){return @{type='object';additionalProperties=(Type-Shape $Matches[1])}}
    if($t -match '^\w+$'){return @{'$ref'="#/typescript/$t";'x-typescript'=$t}}
    return @{'x-typescript'=$t;'x-unresolved'=$true}
}
$defs=[ordered]@{}
foreach($file in Get-ChildItem "$root\web\src" -Recurse -File | Where-Object Extension -in '.ts','.tsx'){
    $original=[IO.File]::ReadAllText($file.FullName)
    # Preserve line numbers while dropping comments.
    $text=[regex]::Replace($original,'(?s)/\*.*?\*/|(?m)//[^\r\n]*',{param($m) [regex]::Replace($m.Value,'[^\r\n]',' ')})
    foreach($m in [regex]::Matches($text,'(?m)^\s*(?:export\s+)?(interface|type)\s+(\w+)\s*(?:extends\s+([^{]+))?\s*(=)?\s*')){
        $kind=$m.Groups[1].Value;$name=$m.Groups[2].Value;$start=$m.Index+$m.Length
        $rest=$text.Substring($start)
        $value=''
        if($rest.StartsWith('{')){
            $depth=0
            for($i=0;$i -lt $rest.Length;$i++){
                if($rest[$i] -eq '{'){$depth++}elseif($rest[$i] -eq '}'){$depth--;if($depth -eq 0){$value=$rest.Substring(0,$i+1);break}}
            }
        } elseif($kind -eq 'type') { $value=($rest -split ';|[\r\n]',2)[0] }
        if(!$value){continue}
        $schema=Type-Shape $value
        $schema['x-source']=$file.FullName.Substring($root.Length+1)+':'+(($original.Substring(0,$m.Index) -split "`n").Count)
        if($m.Groups[3].Success){$schema['x-extends']=$m.Groups[3].Value.Trim()}
        # Prefer real library declarations over imported aliases of the same name.
        if(!$defs.Contains($name) -or $file.FullName -match '\\lib\\'){$defs[$name]=$schema}
    }
}
$captures=@()
foreach($file in Get-ChildItem "$out\captures" -Recurse -Filter '*.json'){
    $c=Get-Content $file.FullName -Raw | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String
    if(!$c.ContainsKey('body')){continue}
    $sample=[System.Collections.Generic.List[object]]::new();$sample.Add($c.body)
    $captures += [ordered]@{method=$c.method;path=$c.path;status=$c.status;contentType=$c.contentType;capture=$file.FullName.Substring($out.Length+1);schema=(Shape $sample.ToArray())}
}
$routes=Get-Content "$out\routes.json" -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$entries=@()
foreach($r in $routes){
    $entries += [ordered]@{method=$r.method;path=$r.path;evidence=$r.evidence;expectedType=$r.expectedType;typeSource=$r.typeSource;expectedResponse=(Type-Shape $r.expectedType);requestParameters=$r.parameters;mutates=$r.mutates;serverSource=$r.serverSource;captures=$r.captures}
}
[ordered]@{'$schema'='https://json-schema.org/draft/2020-12/schema';formatVersion=1;routes=$entries;captures=$captures;typescript=$defs} |
    ConvertTo-Json -Depth 100 | Set-Content "$out\shapes.json" -Encoding utf8
# Baseline TS cross-check, not the later new-server contract checker.
$findings=[System.Collections.Generic.List[object]]::new()
function Compare-TS($schema,$value,[string]$location,[int]$depth=0) {
    if($depth -gt 25){return}
    if($schema.ContainsKey('$ref')){
        $name=($schema['$ref'] -split '/')[-1]
        if($defs.Contains($name)){Compare-TS $defs[$name] $value $location ($depth+1)}
        return
    }
    if($schema.ContainsKey('anyOf')){
        $before=$findings.Count;$best=$null
        foreach($option in $schema.anyOf){
            Compare-TS $option $value $location ($depth+1)
            $current=@($findings.ToArray() | Select-Object -Skip $before)
            if($null -eq $best -or $current.Count -lt $best.Count){$best=$current}
            while($findings.Count -gt $before){$findings.RemoveAt($findings.Count-1)}
        }
        foreach($finding in $best){$findings.Add($finding)}
        return
    }
    if(!$schema.ContainsKey('type')){return}
    $actual=if($null -eq $value){'null'}elseif($value -is [System.Collections.IDictionary]){'object'}elseif($value -is [array]){'array'}elseif($value -is [bool]){'boolean'}elseif($value -is [string]){'string'}else{'number'}
    if($actual -ne $schema.type){
        $findings.Add(@{field=$location;kind='type';expected=$schema.type;actual=$actual});return
    }
    if($schema.ContainsKey('const') -and $value -cne $schema.const){
        $findings.Add(@{field=$location;kind='literal';expected=$schema.const;actual=$value})
    }
    if($actual -eq 'object' -and $schema.ContainsKey('properties')){
        foreach($key in $schema.required){
            if(!$value.ContainsKey($key)){$findings.Add(@{field="$location.$key";kind='missing-required';expected='present';actual='absent'})}
        }
        foreach($key in $schema.properties.Keys){
            if($value.ContainsKey($key)){Compare-TS $schema.properties[$key] $value[$key] "$location.$key" ($depth+1)}
        }
    }
    if($actual -eq 'array'){
        for($i=0;$i -lt $value.Count;$i++){Compare-TS $schema.items $value[$i] "$location[$i]" ($depth+1)}
    }
}
$reports=@()
foreach($r in $entries){
    foreach($path in $r.captures){
        $c=Get-Content "$out\$path" -Raw|ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String
        if($c.status -ge 400){continue}
        $findings.Clear()
        Compare-TS $r.expectedResponse $c.body '$'
        $reports+=@{method=$r.method;route=$r.path;capture=$path;expectedType=$r.expectedType;findings=@($findings.ToArray());coverageNote='Conservative subset: unresolved TS expressions, inheritance and generic aliases require manual review. Extra fields are allowed.'}
    }
}
$reports|ConvertTo-Json -Depth 30|Set-Content "$out\ts-cross-check.json" -Encoding utf8
"Response schemas: $($captures.Count); TypeScript declarations: $($defs.Count)"
