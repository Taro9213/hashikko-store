# Sets up the Hashikko store service on Cloudflare (free plan), step by step.
#   powershell -ExecutionPolicy Bypass -File setup.ps1            first time: Cloudflare, storage, GitHub token, deploy
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Google    after making the Google sign-in client
# Secrets (GitHub token, Google client secret, review password) are typed here or made here, and go straight to
# Cloudflare and to desk.secrets.json on this PC. They are never printed.
param([switch]$Google)
$ErrorActionPreference = 'Stop'
$svc = $PSScriptRoot
$store = Split-Path $svc -Parent
$root = Split-Path $store -Parent
$addrFile = Join-Path $root 'addresses.json'
$deskFile = Join-Path $store 'desk.secrets.json'
$toml = Join-Path $svc 'wrangler.toml'
Set-Location $svc

function Wrangler { & npx.cmd --yes wrangler@4 @args }
function Plain([Security.SecureString]$s) { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
function RandomHex([int]$bytes) { $b = New-Object byte[] $bytes; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
function PutSecret($name, $value) { $value | & npx.cmd --yes wrangler@4 secret put $name | Out-Null; if ($LASTEXITCODE) { throw "Could not save $name" }; Write-Host "  saved $name" }
function ReadAddr { Get-Content $addrFile -Raw -Encoding UTF8 | ConvertFrom-Json }
$utf8 = New-Object Text.UTF8Encoding($false)   # no BOM: node and wrangler read these files
function WriteText($file, $text) { [IO.File]::WriteAllText($file, $text, $utf8) }
function WriteAddr($a) { WriteText $addrFile ($a | ConvertTo-Json) }
function Step($n, $text) { Write-Host ''; Write-Host "== $n $text" -ForegroundColor Cyan }

$a = ReadAddr
if (-not $a.githubUser) { throw 'addresses.json: githubUser is empty.' }
$repo = "$($a.githubUser)/hashikko-store"

if ($Google) {
  Step '1/3' 'Google sign-in client'
  $id = (Read-Host 'Paste the Client ID (ends with .apps.googleusercontent.com)').Trim()
  if ($id -notmatch '^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$') { throw 'That does not look like a Client ID.' }
  $a.googleClientId = $id; WriteAddr $a
  & node (Join-Path $root 'set-addresses.mjs') | Out-Null
  Step '2/3' 'Google client secret (typed text stays hidden)'
  PutSecret 'GOOGLE_CLIENT_SECRET' (Plain (Read-Host 'Paste the Client secret' -AsSecureString))
  Step '3/3' 'Deploy'
  Wrangler deploy | Out-Null
  Write-Host ''
  Write-Host 'Done. Sign-in with Google is on.' -ForegroundColor Green
  exit 0
}

Step '1/6' 'Sign in to Cloudflare (your browser opens; click Allow)'
$ErrorActionPreference = 'Continue'; $who = (Wrangler whoami 2>&1 | Out-String); $ErrorActionPreference = 'Stop'
if ($who -match 'You are logged in') { Write-Host '  already signed in' }
else {
  Wrangler login
  if ($LASTEXITCODE) { throw 'Cloudflare sign-in did not finish.' }
}

Step '2/6' 'Storage for channels, follows and use counts (KV)'
$kv = $a.kvNamespaceId
if (-not $kv) {
  $ErrorActionPreference = 'Continue'
  $out = (Wrangler kv namespace create DB 2>&1 | Out-String)
  $ErrorActionPreference = 'Stop'
  $m = [regex]::Match($out, '"?id"?\s*[:=]\s*"([0-9a-f]{32})"')
  if (-not $m.Success) {
    # Already made on an earlier run: find it in the list
    $ErrorActionPreference = 'Continue'; $list = (Wrangler kv namespace list 2>&1 | Out-String); $ErrorActionPreference = 'Stop'
    $m = [regex]::Match($list, '"id"\s*:\s*"([0-9a-f]{32})"\s*,\s*"title"\s*:\s*"[^"]*DB"')
    if (-not $m.Success) { $m = [regex]::Match($list, '"title"\s*:\s*"[^"]*DB"[^}]*"id"\s*:\s*"([0-9a-f]{32})"') }
  }
  if (-not $m.Success) { Write-Host $out; throw 'Could not find the KV storage id.' }
  $kv = $m.Groups[1].Value
  $a.kvNamespaceId = $kv; WriteAddr $a
}
WriteText $toml ((Get-Content $toml -Raw -Encoding UTF8) -creplace '(?m)^id = "[^"]*"', "id = `"$kv`"" -creplace 'STORE_REPO = "[^"]*"', "STORE_REPO = `"$repo`"")
Write-Host "  storage ready"

Step '3/6' 'First deploy (to learn your workers.dev address)'
$ErrorActionPreference = 'Continue'   # wrangler writes warnings to stderr; read them instead of stopping
$dep = (Wrangler deploy 2>&1 | Out-String)
$ErrorActionPreference = 'Stop'
$m = [regex]::Match($dep, 'https://hashikko-store\.([a-z0-9-]+)\.workers\.dev')
if (-not $m.Success) { Write-Host $dep; throw 'Deploy did not show the workers.dev address. If it says to register a workers.dev subdomain: Cloudflare dashboard -> Compute -> Workers & Pages -> pick a subdomain, then run this again.' }
$a.workersSubdomain = $m.Groups[1].Value; WriteAddr $a
& node (Join-Path $root 'set-addresses.mjs') | Out-Null
$service = "https://hashikko-store.$($a.workersSubdomain).workers.dev/"
Write-Host "  service: $service"

Step '4/6' 'Secrets'
Write-Host '  GitHub token: fine-grained, only hashikko-store, Issues: Read and write. (typed text stays hidden)'
$gh = Plain (Read-Host '  Paste the GitHub token' -AsSecureString)
if ($gh -notmatch '^(github_pat_|ghp_)[A-Za-z0-9_]+$') { throw 'That does not look like a GitHub token.' }
PutSecret 'GITHUB_TOKEN' $gh
$admin = RandomHex 32
PutSecret 'ADMIN_TOKEN' $admin
PutSecret 'RATE_SALT' (RandomHex 32)
WriteText $deskFile (@{ githubToken = $gh; storeRepo = $repo; serviceUrl = $service; adminToken = $admin } | ConvertTo-Json)
Write-Host '  saved desk.secrets.json (for the review desk on this PC)'

Step '5/6' 'Labels on hashikko-store'
$h = @{ Authorization = "Bearer $gh"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'hashikko-setup' }
foreach ($l in @(@('submission', '0e8a16'), @('report', 'd93f0b'), @('needs-changes', 'fbca04'), @('declined', 'b60205'), @('listed', '1d76db'))) {
  try { Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/labels" -Headers $h -Body (@{ name = $l[0]; color = $l[1] } | ConvertTo-Json) -ContentType 'application/json' | Out-Null; Write-Host "  + $($l[0])" }
  catch { Write-Host "  = $($l[0]) (already there, or the token cannot add labels: GitHub adds it with the first issue)" }
}

Step '6/6' 'Deploy with the addresses and check'
Wrangler deploy | Out-Null
$text = (Invoke-WebRequest $service -UseBasicParsing).Content
if ($text -notmatch 'Hashikko store service') { throw "The service did not answer at $service" }
Write-Host ''
Write-Host "Done. The service answers at $service" -ForegroundColor Green
Write-Host 'Next: make the Google sign-in client (see share\段階2の手順.md), then run: setup.ps1 -Google'
Write-Host "Also on GitHub (hashikko-store → Settings → Secrets and variables → Actions → Variables): STATS_URL = ${service}v1/stats"
