$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType] 'Tls12'

$folder = 'C:\Users\Xieta\Desktop\Tracking-main'
$files = @(
  'index.html',
  'cloud.js',
  'mobile.css',
  'mobile.js',
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png'
)

$owner = Read-Host 'GitHub username (owner) [xieta1371]'
if ([string]::IsNullOrWhiteSpace($owner)) { $owner = 'xieta1371' }
$repo = Read-Host 'Repository name'
if ([string]::IsNullOrWhiteSpace($repo)) { throw 'Repository name is required.' }
$branch = Read-Host 'Branch [main]'
if ([string]::IsNullOrWhiteSpace($branch)) { $branch = 'main' }
$secure = Read-Host 'GitHub classic token with repo scope' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$headers = @{
  'Authorization' = 'Bearer ' + $token
  'Accept' = 'application/vnd.github+json'
  'User-Agent' = 'organizer-uploader'
  'X-GitHub-Api-Version' = '2022-11-28'
}

foreach ($name in $files) {
  $file = Join-Path $folder $name
  if (-not (Test-Path -LiteralPath $file)) { throw ('File not found: ' + $file) }

  $uri = 'https://api.github.com/repos/' + $owner + '/' + $repo + '/contents/' + $name
  $sha = $null
  try {
    $existing = Invoke-RestMethod -Uri ($uri + '?ref=' + $branch) -Headers $headers -Method Get -TimeoutSec 60
    $sha = $existing.sha
  } catch {}

  $bytes = [IO.File]::ReadAllBytes($file)
  $body = @{
    message = 'Release v2.0: Firebase cloud friends and real-time chat'
    content = [Convert]::ToBase64String($bytes)
    branch = $branch
  }
  if ($sha) { $body.sha = $sha }

  $json = $body | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Uri $uri -Headers $headers -Method Put -Body $json -ContentType 'application/json' -TimeoutSec 120 | Out-Null
  Write-Output ('Uploaded: ' + $name)
}

Write-Output ''
Write-Output 'All 8 files uploaded (v2.0).'
Write-Output 'Open the site, wait 1-2 minutes, then force-refresh (2-3 times) to pick up the new sw.js cache.'
