# 크기 바꾸기 + 선택·복사 테스트를 여러 번 돌린다. 사용: powershell -File tests/run-resize.ps1 [-Runs 3]
param([int]$Runs = 3)
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$env:SMOKE_JS_FILE = Join-Path $PSScriptRoot 'resize-copy.js'
$env:SMOKE_MS = '3000'
$env:SMOKE_CMD = 'echo ready'
$fail = 0
# 다른 프로그램이 클립보드를 잡고 있으면 실패하므로 몇 번 다시 시도한다
function Retry($block) { for ($t = 0; $t -lt 10; $t++) { try { return & $block } catch { Start-Sleep -Milliseconds 300 } } }
for ($i = 1; $i -le $Runs; $i++) {
  Retry { Set-Clipboard -Value 'before' -ErrorAction Stop } | Out-Null
  $log = npx electron . --smoke 2>&1
  $out = $log | Select-String 'SMOKE_JS:' | Select-Object -Last 1
  $json = ($out -replace '^.*?SMOKE_JS: ', '') | ConvertFrom-Json
  # 앱이 복사한 내용은 Windows 클립보드에서 읽는다. 다른 프로그램이 잡고 있으면 읽지 못한다(아래에서 확인 불가 처리).
  $clip = Retry { Get-Clipboard -ErrorAction Stop }
  $reflowOk = @($json.reflow | Where-Object { -not $_.ok }).Count -eq 0
  $scrollBad = @($json.scroll | Where-Object { -not $_.ok })
  "  스크롤 선택: $(@($json.scroll).Count - $scrollBad.Count)/$(@($json.scroll).Count)"
  foreach ($s in $scrollBad) { "  스크롤 실패: 배율 $($s.scale) 위로 $($s.up)줄 기대 [$($s.want)] 선택 [$($s.sel)] 화면이동 $($s.jumped) $($s.why)" }
  $mouseBad = @($json.mouseMode | Where-Object { -not $_.ok })
  "  마우스 모드 선택: $(@($json.mouseMode).Count - $mouseBad.Count)/$(@($json.mouseMode).Count)"
  foreach ($m in $mouseBad) { "  마우스 모드 실패: 배율 $($m.scale) 기대 [$($m.want)] 선택 [$($m.sel)] 모드 $($m.mode)" }
  $clipOk = $clip -eq $json.lastMarker
  # 클립보드가 시스템 전체에서 잠겨 있으면(다른 프로그램) 확인할 수 없으니 실패로 세지 않는다
  $clipLocked = $false
  if (-not $clipOk) { try { Set-Clipboard -Value 'probe' -ErrorAction Stop } catch { $clipLocked = $true } }
  $clipText = if ($clipLocked) { '확인 불가(클립보드 잠김)' } elseif ($clipOk) { '통과' } else { "실패 [$clip]" }
  if ($clipLocked) { $clipOk = $true }
  "run $i : 선택·칸수 $($json.passed)/$($json.total), 긴 줄 $(if ($reflowOk) { '통과' } else { '실패' }), 클립보드 $clipText"
  foreach ($l in $json.lagged) { "  잠깐 늦게 맞춰짐(1초 안에 정상): $l" }
  foreach ($f in $json.failed) { "  실패: 배율 $($f.scale) 크기 $($f.W)x$($f.H) 화면칸 $($f.cols) pty칸 $($f.ptyCols) 행 $($f.row) 선택 [$($f.sel)] 화면 $($f.near -join ' | ')" }
  foreach ($r in $json.reflow) { if (-not $r.ok) { "  긴 줄 실패: 폭 $($r.W) ($($r.cols)칸)"; foreach ($d in $r.dump) { "    $d" } } }
  if ($json.passed -ne $json.total -or -not $reflowOk -or -not $clipOk -or $scrollBad.Count -or $mouseBad.Count) { $fail++ }
}
Remove-Item Env:SMOKE_JS_FILE, Env:SMOKE_MS, Env:SMOKE_CMD
"실패한 회차: $fail / $Runs"
exit $fail
