<#
.SYNOPSIS
  Delete the camera platform cloud stack (CLOUD-AWS-SPEC.md section C).

.DESCRIPTION
  Windows PowerShell 5.1 compatible: no &&, no ??, no ternary.

  Destructive: deletes the table (DeletionPolicy: Delete -- dev has no
  retained data), the function, the HTTP API, the log group and the budget.
  Requires the operator to type the exact stack name back, so this never
  runs as a one-line accident.

.PARAMETER Stage
  Deployment stage name. Default: dev.

.EXAMPLE
  .\teardown.ps1 -Stage dev
#>
param(
    [string]$Stage = "dev"
)

$ErrorActionPreference = "Stop"

$AwsExe = "C:\Users\garci_9e2kg3l\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$StackName = "camplat-$Stage"

if (-not (Test-Path $AwsExe)) {
    Write-Error "aws.exe not found at $AwsExe -- see memory aws-toolkit-setup"
    exit 1
}

function Stop-OnFailure {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "teardown.ps1: '$What' failed with exit code $LASTEXITCODE -- stopping."
        exit $LASTEXITCODE
    }
}

Write-Host "This deletes stack '$StackName' -- the table, the function, the HTTP API, the log group and the budget."
Write-Host "Type the stack name to confirm ($StackName), or anything else to cancel:"
$Typed = Read-Host "Stack name"
if ($Typed -ne $StackName) {
    Write-Host "Typed '$Typed', expected '$StackName' -- cancelled, nothing deleted."
    exit 1
}

Write-Host "`n== 1/2: aws cloudformation delete-stack =="
& $AwsExe cloudformation delete-stack `
    --profile camplat `
    --region us-east-1 `
    --stack-name $StackName
Stop-OnFailure "aws cloudformation delete-stack"

Write-Host "`n== 2/2: aws cloudformation wait stack-delete-complete =="
& $AwsExe cloudformation wait stack-delete-complete `
    --profile camplat `
    --region us-east-1 `
    --stack-name $StackName
Stop-OnFailure "aws cloudformation wait stack-delete-complete"

Write-Host "`nStack '$StackName' deleted."
