# 起本地静态服务 + 公网 https 隧道。按 Ctrl+C 结束，地址会变。
# 用法： powershell -ExecutionPolicy Bypass -File tools\start.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$port = 8899

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $bundled = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $bundled) { return $bundled }
  return $null
}

$node = Find-Node
if ($node) {
  Write-Host "用 node: $node"
  Start-Process -FilePath $node -ArgumentList "$PSScriptRoot\serve.mjs", $root, $port -WindowStyle Hidden
} else {
  # 没有 node 就退回 python 自带服务器；它不支持 Range，视频跳句会不准
  $py = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $py) { $py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" }
  if (-not (Test-Path $py)) { throw '找不到 node，也找不到 python。' }
  Write-Host "用 python: $py（视频跳句可能不准）" -ForegroundColor Yellow
  Start-Process -FilePath $py -ArgumentList '-m', 'http.server', $port, '--bind', '127.0.0.1', '--directory', $root -WindowStyle Hidden
}

Start-Sleep -Seconds 2
try {
  Invoke-WebRequest "http://127.0.0.1:$port/index.html" -UseBasicParsing -TimeoutSec 5 | Out-Null
  Write-Host "本地服务 OK：http://127.0.0.1:$port" -ForegroundColor Green
} catch {
  Write-Host "本地服务没起来：$($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Write-Host '正在开公网隧道，下面出现的 https 地址就是手机要打开的：' -ForegroundColor Cyan
Write-Host ''
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -R "80:127.0.0.1:$port" nokey@localhost.run
