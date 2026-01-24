$ErrorActionPreference = "Stop"

# Get the directory of this script
$ScriptDir = Split-Path $MyInvocation.MyCommand.Path
# Assume output.json is in the parent directory (project root)
$ProjectRoot = Split-Path $ScriptDir -Parent
$OutputJsonPath = Join-Path $ProjectRoot "output.json"

if (-not (Test-Path $OutputJsonPath)) {
    Write-Error "output.json not found at $OutputJsonPath. Please run 'cdk deploy --outputs-file output.json' first."
    exit 1
}

Write-Host "Reading configuration from $OutputJsonPath..."
# Use -Raw to ensure multi-line JSON is read as a single string
$jsonContent = Get-Content $OutputJsonPath -Raw
$json = $jsonContent | ConvertFrom-Json

# Get the properties of the JSON object, looking for the stack object
$properties = $json.PSObject.Properties | Where-Object { $_.Value -is [System.Management.Automation.PSCustomObject] }

if (-not $properties) {
    Write-Error "Could not find valid stack output object in JSON."
    exit 1
}

# Take the first property (Stack Name)
$stackName = $properties[0].Name
$outputs = $properties[0].Value

Write-Host "Found Stack: $stackName"

# Set Environment Variables for the test script
$env:API_URL = $outputs.ExportApiBaseUrl
$env:REGION = $outputs.ExportRegion
$env:IDENTITY_POOL_ID = $outputs.ExportIdentityPoolId

if (-not $env:API_URL -or -not $env:REGION -or -not $env:IDENTITY_POOL_ID) {
    Write-Error "Failed to extract required outputs. Check output.json structure."
    Write-Host "Outputs object keys: $($outputs.PSObject.Properties.Name -join ', ')"
    exit 1
}

Write-Host "--------------------------------------------------"
Write-Host "Environment Configured:"
Write-Host "  API_URL          : $env:API_URL"
Write-Host "  REGION           : $env:REGION"
Write-Host "  IDENTITY_POOL_ID : $env:IDENTITY_POOL_ID"
Write-Host "--------------------------------------------------"

$TestScriptPath = Join-Path $ScriptDir "test-manual.js"
Write-Host "Running test: node $TestScriptPath"
node $TestScriptPath
