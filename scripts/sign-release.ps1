param(
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [string]$TimestampServer = "http://timestamp.digicert.com",
  [string[]]$Files = @("dist\Inkstone.exe", "dist\Inkstone-Setup-0.1.0-windows-x64.exe")
)
$ErrorActionPreference = "Stop"
$cert = Get-Item ("Cert:\CurrentUser\My\" + $Thumbprint)
if (-not $cert -or -not $cert.HasPrivateKey) { throw "Code-signing certificate with private key not found: $Thumbprint" }
foreach ($file in $Files) {
  $resolved = (Resolve-Path $file).Path
  $sig = Set-AuthenticodeSignature -FilePath $resolved -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampServer
  if ($sig.Status -ne "Valid" -and $sig.Status -ne "UnknownError") { throw ("Signing failed for " + $file + ": " + $sig.Status + " " + $sig.StatusMessage) }
  $check = Get-AuthenticodeSignature -FilePath $resolved
  Write-Output ($file + " -> " + $check.Status + " / " + $check.SignerCertificate.Subject)
  if (-not $check.TimeStamperCertificate) { Write-Warning ("No timestamp on " + $file) }
}
