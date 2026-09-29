<#
.SYNOPSIS
  Deploy the camera platform cloud stack (CLOUD-AWS-SPEC.md section C).

.DESCRIPTION
  Windows PowerShell 5.1 compatible: no &&, no ??, no ternary.

  Austin runs this himself, after approving the cost -- this script never
  runs unattended and this repo never holds a credential (CLOUD-AWS-SPEC.md
  opening paragraph). Steps, each one stopping the whole script on failure:
    1. node cloud/deploy/package.mjs (builds cloud/dist/**, writes and
       proves cloud/deploy/out/camplat-api.zip).
    2. aws cloudformation deploy (stack.yaml, --capabilities CAPABILITY_IAM).
    3. aws lambda update-function-code (the real zip from step 1).
    4. aws lambda wait function-updated.
    5. print the ApiUrl stack output.

.PARAMETER Stage
  Deployment stage name. Default: dev. Must match stack.yaml's Stage
  parameter's AllowedPattern (lowercase letters, digits, hyphens).

.PARAMETER BudgetEmail
  Mandatory. Email that receives the AWS Budgets alert (80% actual, 100%
  forecasted -- CLOUD-AWS-SPEC.md's $1-by-default cost alarm).

.PARAMETER BudgetLimitUsd
  Monthly AWS Budgets COST limit in US dollars. Default: 1.

.EXAMPLE
  .\deploy.ps1 -BudgetEmail austin@example.com
#>
param(
    [string]$Stage = "dev",
    [Parameter(Mandatory = $true)][string]$BudgetEmail,
    [int]$BudgetLimitUsd = 1
)

$ErrorActionPreference = "Stop"

# aws.exe by its full path (memory aws-toolkit-setup); UTF-8 so multi-byte
# output from aws.exe (and this script's own messages) round-trips cleanly.
$AwsExe = "C:\Users\garci_9e2kg3l\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path   # cloud/deploy
$CloudDir = Split-Path -Parent $ScriptDir                      # cloud
$RootDir = Split-Path -Parent $CloudDir                        # camera-platform
$StackYaml = Join-Path $ScriptDir "stack.yaml"
$ZipPath = Join-Path $ScriptDir "out\camplat-api.zip"
$StackName = "camplat-$Stage"

if (-not (Test-Path $AwsExe)) {
    Write-Error "aws.exe not found at $AwsExe -- see memory aws-toolkit-setup"
    exit 1
}

function Stop-OnFailure {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "deploy.ps1: '$What' failed with exit code $LASTEXITCODE -- stopping."
        exit $LASTEXITCODE
    }
}

Write-Host "== 1/5: node cloud/deploy/package.mjs (build + prove the zip) =="
node (Join-Path $ScriptDir "package.mjs")
Stop-OnFailure "node package.mjs"

if (-not (Test-Path $ZipPath)) {
    Write-Error "deploy.ps1: package.mjs reported success but $ZipPath does not exist -- stopping."
    exit 1
}

Write-Host "`n== 2/5: aws cloudformation deploy ($StackName) =="
& $AwsExe cloudformation deploy `
    --profile camplat `
    --region us-east-1 `
    --stack-name $StackName `
    --template-file $StackYaml `
    --capabilities CAPABILITY_IAM `
    --parameter-overrides "Stage=$Stage" "BudgetEmail=$BudgetEmail" "BudgetLimitUsd=$BudgetLimitUsd"
Stop-OnFailure "aws cloudformation deploy"

Write-Host "`n== 3/5: aws lambda update-function-code =="
$FunctionName = "camplat-$Stage-router"
& $AwsExe lambda update-function-code `
    --profile camplat `
    --region us-east-1 `
    --function-name $FunctionName `
    --zip-file "fileb://$ZipPath" `
    --output json
Stop-OnFailure "aws lambda update-function-code"

Write-Host "`n== 4/5: aws lambda wait function-updated =="
& $AwsExe lambda wait function-updated `
    --profile camplat `
    --region us-east-1 `
    --function-name $FunctionName
Stop-OnFailure "aws lambda wait function-updated"

Write-Host "`n== 5/5: ApiUrl =="
$ApiUrl = & $AwsExe cloudformation describe-stacks `
    --profile camplat `
    --region us-east-1 `
    --stack-name $StackName `
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" `
    --output text
Stop-OnFailure "aws cloudformation describe-stacks (ApiUrl)"

Write-Host "`nApiUrl: $ApiUrl"
Write-Host "Stack:  $StackName"
Write-Host "Smoke test: node cloud/deploy/smoke.mjs $ApiUrl"
