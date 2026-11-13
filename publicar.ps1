# Jungle Fight - sube a GitHub los archivos del juego que hayan cambiado.
# Uso:  powershell -ExecutionPolicy Bypass -File publicar.ps1 ["mensaje del cambio"]
# Necesita GitHub CLI (gh) con la sesión iniciada (gh auth login).
# Después hay que redesplegar en Render (Manual Deploy > Deploy latest commit).

param([string]$Mensaje = "Actualizar Jungle Fight")

$ErrorActionPreference = 'Stop'
$repo   = 'iamaster213-del/jungle-fight'
$branch = 'main'
$files  = @('duelo-en-la-selva.html', 'server.js', 'package.json', 'render.yaml', 'iniciar-servidor-LAN.bat', 'publicar.ps1')

$gh = Join-Path $env:LOCALAPPDATA 'Programs\gh\bin\gh.exe'
if (-not (Test-Path $gh)) { $gh = 'gh' }

# identificador que usa git para el contenido de un archivo (así sabemos si cambió)
function Get-BlobSha([byte[]]$bytes) {
  $head = [Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
  $all = New-Object byte[] ($head.Length + $bytes.Length)
  [Array]::Copy($head, $all, $head.Length)
  [Array]::Copy($bytes, 0, $all, $head.Length, $bytes.Length)
  $sha1 = [Security.Cryptography.SHA1]::Create()
  return -join ($sha1.ComputeHash($all) | ForEach-Object { $_.ToString('x2') })
}

$tmp = Join-Path $env:TEMP 'jungle-fight-subida.json'
$subidos = 0
foreach ($f in $files) {
  $path = Join-Path $PSScriptRoot $f
  if (-not (Test-Path $path)) { Write-Host "  (no existe $f, se omite)"; continue }
  $bytes = [IO.File]::ReadAllBytes($path)
  $local = Get-BlobSha $bytes

  $remote = $null
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $remote = & $gh api "repos/$repo/contents/$($f)?ref=$branch" --jq .sha 2>$null
  $ErrorActionPreference = $old
  if ($LASTEXITCODE -ne 0) { $remote = $null }

  if ($remote -eq $local) { Write-Host "  = $f (sin cambios)"; continue }

  $body = @{ message = "$Mensaje ($f)"; branch = $branch; content = [Convert]::ToBase64String($bytes) }
  if ($remote) { $body.sha = $remote }
  [IO.File]::WriteAllText($tmp, ($body | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  & $gh api -X PUT "repos/$repo/contents/$f" --input $tmp --jq .commit.sha | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "No se pudo subir $f" }
  Write-Host "  ^ $f subido"
  $subidos++
}
Remove-Item $tmp -ErrorAction SilentlyContinue
Write-Host ""
if ($subidos) { Write-Host "Listo: $subidos archivo(s) subidos a github.com/$repo. Falta redesplegar en Render." }
else { Write-Host "No había nada nuevo que subir." }
