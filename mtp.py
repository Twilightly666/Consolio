import json
import os
import platform
import subprocess
import tempfile

import ops

IS_WIN = platform.system() == "Windows"
SEP = "\x01"
_progress_path = None
_conflict_path = None
_answer_path = None


def read_conflict():
    path = _conflict_path
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        name = str(data.get("name") or "")
        if not name:
            return None
        return {"id": str(data.get("id") or "m"), "name": name, "dir": bool(data.get("dir"))}
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def resolve(answer, apply_all=False):
    if answer not in ("replace", "skip", "cancel"):
        return False
    if not _answer_path or not _conflict_path or not os.path.exists(_conflict_path):
        return False
    tmp = _answer_path + ".tmp"
    try:
        with open(tmp, "w", encoding="ascii") as f:
            f.write(answer + (":all" if apply_all and answer != "cancel" else ""))
        os.replace(tmp, _answer_path)
        return True
    except OSError:
        return False


def read_progress():
    path = _progress_path
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return {
            "done": int(data.get("done") or 0),
            "total": int(data.get("total") or 0),
            "name": str(data.get("name") or ""),
        }
    except (OSError, ValueError, TypeError):
        return {"done": 0, "total": 0, "name": ""}

SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
$created = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList
$done = New-Object System.Collections.ArrayList
$deleted = 0
$script:total = [int64]0
$script:pname = ''
$script:cancelled = $false
$script:cid = 0
$script:sticky = $null

function Ask-Conflict($name, $isDir) {
  if ($script:sticky) { return $script:sticky }
  if (-not $env:CONSOLIO_CONFLICT -or -not $env:CONSOLIO_ANSWER) { return 'skip' }
  $script:cid++
  $o = @{ id = ('m' + $script:cid); name = [string]$name; dir = [bool]$isDir }
  [IO.File]::WriteAllText($env:CONSOLIO_CONFLICT, (ConvertTo-Json -InputObject $o -Compress))
  $ans = 'cancel'
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt 600) {
    if (Test-Path -LiteralPath $env:CONSOLIO_ANSWER) {
      try { $ans = ([IO.File]::ReadAllText($env:CONSOLIO_ANSWER)).Trim() } catch { Start-Sleep -Milliseconds 100; continue }
      break
    }
    Start-Sleep -Milliseconds 150
  }
  $parts = ([string]$ans).Split(':')
  $ans = $parts[0]
  if ($parts.Count -gt 1 -and $parts[1] -eq 'all' -and ($ans -eq 'replace' -or $ans -eq 'skip')) { $script:sticky = $ans }
  Remove-Item -LiteralPath $env:CONSOLIO_ANSWER -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $env:CONSOLIO_CONFLICT -Force -ErrorAction SilentlyContinue
  if ($ans -ne 'replace' -and $ans -ne 'skip') { $ans = 'cancel' }
  return $ans
}

function Report($base, $cur, $item) {
  if (-not $env:CONSOLIO_PROGRESS) { return }
  $c = [int64]$cur
  if ($c -gt $item) { $c = [int64]$item }
  if ($c -lt 0) { $c = [int64]0 }
  $o = @{ done = ([int64]$base + $c); total = $script:total; name = $script:pname }
  try { [IO.File]::WriteAllText($env:CONSOLIO_PROGRESS, (ConvertTo-Json -InputObject $o -Compress)) } catch {}
}

$pollerScript = {
  param($sync, $prog, $ownPid, $useWrite, $dpath, $before, $base, $isz, $total, $name)
  function Get-Io {
    $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ownPid"
    if ($useWrite) { return [int64]$p.WriteTransferCount }
    return [int64]$p.ReadTransferCount
  }
  $start = [int64]0
  try { $start = Get-Io } catch {}
  while (-not $sync.stop) {
    $io = [int64]0
    try { $io = (Get-Io) - $start } catch {}
    $loc = [int64]0
    if ($dpath) {
      try {
        foreach ($e in [IO.Directory]::GetFileSystemEntries($dpath)) {
          if (-not $before.ContainsKey($e)) {
            if (Test-Path -LiteralPath $e -PathType Container) {
              foreach ($f in Get-ChildItem -LiteralPath $e -Recurse -File -Force -ErrorAction SilentlyContinue) { $loc += $f.Length }
            } else {
              $loc += (Get-Item -LiteralPath $e -Force).Length
            }
          }
        }
      } catch {}
    }
    $cur = [Math]::Max($io, $loc)
    if ($cur -gt $isz) { $cur = [int64]$isz }
    if ($cur -lt 0) { $cur = [int64]0 }
    $o = @{ done = ([int64]$base + $cur); total = $total; name = $name }
    try { [IO.File]::WriteAllText($prog, (ConvertTo-Json -InputObject $o -Compress)) } catch {}
    Start-Sleep -Milliseconds 400
  }
}

function Start-Poller($useWrite, $dpath, $before, $base, $isz) {
  if (-not $env:CONSOLIO_PROGRESS) { return $null }
  $sync = [hashtable]::Synchronized(@{ stop = $false })
  $ps = [powershell]::Create()
  [void]$ps.AddScript($pollerScript.ToString())
  [void]$ps.AddArgument($sync)
  [void]$ps.AddArgument($env:CONSOLIO_PROGRESS)
  [void]$ps.AddArgument($PID)
  [void]$ps.AddArgument($useWrite)
  [void]$ps.AddArgument($dpath)
  [void]$ps.AddArgument($before)
  [void]$ps.AddArgument($base)
  [void]$ps.AddArgument($isz)
  [void]$ps.AddArgument($script:total)
  [void]$ps.AddArgument($script:pname)
  $h = $ps.BeginInvoke()
  return [PSCustomObject]@{ ps = $ps; h = $h; sync = $sync }
}

function Stop-Poller($pl) {
  if ($null -eq $pl) { return }
  $pl.sync.stop = $true
  try { [void]$pl.ps.EndInvoke($pl.h) } catch {}
  try { $pl.ps.Dispose() } catch {}
}

function SumShell($folder) {
  $s = [int64]0
  foreach ($c in $folder.Items()) {
    if ($c.IsFolder) {
      $g = $c.GetFolder
      if ($null -ne $g) { $s += SumShell $g }
    } else {
      $v = SizeOf $c
      if ($v -gt 0) { $s += $v }
    }
  }
  return $s
}

function NameOf($c) {
  $v = $null
  try { $v = $c.ExtendedProperty('System.FileName') } catch {}
  if ($v) { return [string]$v }
  return [string]$c.Name
}

function SizeOf($c) {
  try { $v = $c.ExtendedProperty('System.Size'); if ($null -ne $v) { return [int64]$v } } catch {}
  try { return [int64]$c.Size } catch {}
  return [int64]-1
}

function Get-Dev($dev) {
  $cand = @()
  foreach ($i in $sh.Namespace(17).Items()) {
    if ($i.Path -eq $dev) { return $i }
    if ((-not $i.IsFileSystem) -and ($i.Path -notmatch '^[A-Za-z]:')) { $cand += $i }
  }
  if ($cand.Count -eq 1) { return $cand[0] }
  return $null
}

function Get-MtpFolder($dev, $names) {
  $item = Get-Dev $dev
  if ($null -eq $item) { throw 'Пристрій не знайдено' }
  $f = $item.GetFolder
  if ($null -eq $f) { throw 'Пристрій недоступний' }
  foreach ($n in $names) {
    $next = $null
    foreach ($c in $f.Items()) {
      if ($c.IsFolder -and ((NameOf $c) -eq $n)) { $next = $c; break }
    }
    if ($null -eq $next) { throw "Папку не знайдено: $n" }
    $f = $next.GetFolder
  }
  return $f
}

function CountShell($folder) {
  $n = 0
  foreach ($c in $folder.Items()) {
    if ($c.IsFolder) {
      $g = $c.GetFolder
      if ($null -ne $g) { $n += CountShell $g }
    } else { $n++ }
  }
  return $n
}

function CountLocal($p) {
  return @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue).Count
}

function SumLocal($p) {
  $s = [int64]0
  foreach ($f in Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue) { $s += $f.Length }
  return $s
}

function Find-Src($it) {
  if ($it.mtp) {
    $nm = @($it.names | Where-Object { $_ })
    $parent = @()
    if ($nm.Count -gt 1) { $parent = @($nm[0..($nm.Count - 2)]) }
    $pf = Get-MtpFolder $it.dev $parent
    $leaf = [string]$nm[$nm.Count - 1]
    foreach ($c in $pf.Items()) {
      if ((NameOf $c) -eq $leaf) { return $c }
    }
    throw 'не знайдено'
  }
  $full = [string]$it.path
  $dir = [IO.Path]::GetDirectoryName($full.TrimEnd('\', '/'))
  $leaf = [IO.Path]::GetFileName($full.TrimEnd('\', '/'))
  $x = $sh.Namespace($dir).ParseName($leaf)
  if ($null -eq $x) { throw 'не знайдено' }
  return $x
}

function Wait-Local($dpath, $before, $isDir, $expSize, $expCnt, $base, $isz) {
  $prev = ''; $stable = 0; $start = Get-Date; $last = Get-Date
  while ($true) {
    Start-Sleep -Milliseconds 800
    $new = $null
    foreach ($e in [IO.Directory]::GetFileSystemEntries($dpath)) {
      if (-not $before.ContainsKey($e)) { $new = $e; break }
    }
    if ($null -eq $new) {
      if (((Get-Date) - $start).TotalSeconds -gt 90) { throw 'копіювання не розпочалося' }
      continue
    }
    if ($isDir) {
      $cnt = CountLocal $new
      $sum = SumLocal $new
      $metric = "$cnt/$sum"
      if ($metric -ne $prev) { $prev = $metric; $stable = 0; $last = Get-Date } else { $stable++ }
      if (($cnt -ge $expCnt) -and ($stable -ge 3)) { return $new }
    } else {
      $len = (Get-Item -LiteralPath $new -Force).Length
      $metric = "$len"
      if ($metric -ne $prev) { $prev = $metric; $stable = 0; $last = Get-Date } else { $stable++ }
      if (($expSize -ge 0) -and ($len -ge $expSize) -and ($stable -ge 1)) { return $new }
      if ($stable -ge 10) { return $new }
    }
    if (((Get-Date) - $last).TotalSeconds -gt 120) { throw 'копіювання зупинилось' }
  }
}

function Wait-Mtp($dev, $names, $leaf, $isDir, $expSize, $expCnt, $base, $isz) {
  $prev = ''; $stable = 0; $start = Get-Date; $last = Get-Date
  while ($true) {
    Start-Sleep -Milliseconds 1500
    $child = $null
    try {
      $df = Get-MtpFolder $dev $names
      foreach ($c in $df.Items()) {
        if ((NameOf $c) -eq $leaf) { $child = $c; break }
      }
    } catch {}
    if ($null -eq $child) {
      if (((Get-Date) - $start).TotalSeconds -gt 90) { throw 'копіювання не розпочалося' }
      continue
    }
    if ($isDir) {
      $cnt = CountShell $child.GetFolder
      $metric = "$cnt"
      if ($metric -ne $prev) { $prev = $metric; $stable = 0; $last = Get-Date } else { $stable++ }
      if (($cnt -ge $expCnt) -and ($stable -ge 2)) { return (NameOf $child) }
    } else {
      $sz = SizeOf $child
      $metric = "$sz"
      if ($metric -ne $prev) { $prev = $metric; $stable = 0; $last = Get-Date } else { $stable++ }
      if (($expSize -ge 0) -and ($sz -eq $expSize)) { return (NameOf $child) }
      if ($stable -ge 6) { return (NameOf $child) }
    }
    if (((Get-Date) - $last).TotalSeconds -gt 120) { throw 'копіювання зупинилось' }
  }
}

function Rename-Mtp($it, $newName) {
  $nm = @($it.names | Where-Object { $_ })
  if ($nm.Count -lt 2) { throw 'Не можна перейменувати сховище' }
  if ($script:winrt) {
    $pit = [PSCustomObject]@{ dev = $it.dev; names = @($nm[0..($nm.Count - 2)]) }
    $parentFolder = Find-WinrtItem $pit
    $same = [string]::Equals([string]$nm[$nm.Count - 1], $newName, [StringComparison]::OrdinalIgnoreCase)
    if (-not $same) {
      $clash = Await $parentFolder.TryGetItemAsync($newName) ([Windows.Storage.IStorageItem])
      if ($null -ne $clash) { throw 'Елемент з такою назвою вже існує' }
    }
    $wx = Find-WinrtItem $it
    AwaitAct ($wx.RenameAsync($newName, [Windows.Storage.NameCollisionOption]::FailIfExists))
  } else {
    $src = Find-Src $it
    $src.Name = $newName
  }
}

function Remove-Mtp($it) {
  $ok = $false
  if ($script:winrt) {
    try {
      $wx = Find-WinrtItem $it
      AwaitAct ($wx.DeleteAsync([Windows.Storage.StorageDeleteOption]::PermanentDelete))
      $ok = $true
    } catch {}
  }
  if (-not $ok) {
    $src = Find-Src $it
    $src.InvokeVerb('delete')
  }
  $start = Get-Date
  while ($true) {
    Start-Sleep -Milliseconds 1000
    $gone = $false
    try { [void](Find-Src $it) } catch { $gone = $true }
    if ($gone) { return }
    if (((Get-Date) - $start).TotalSeconds -gt 90) { throw 'не вдалося видалити з пристрою' }
  }
}

$script:winrt = $false
$script:cum = [int64]0
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Devices.Portable.StorageDevice, Windows.Devices.Portable, ContentType=WindowsRuntime]
  [void][Windows.Storage.IStorageItem, Windows.Storage, ContentType=WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  [void][Windows.Storage.StorageFolder, Windows.Storage, ContentType=WindowsRuntime]
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  [void][Windows.Storage.StorageDeleteOption, Windows.Storage, ContentType=WindowsRuntime]
  [void][Windows.Storage.CreationCollisionOption, Windows.Storage, ContentType=WindowsRuntime]
  [void][Windows.Storage.NameCollisionOption, Windows.Storage, ContentType=WindowsRuntime]
  $script:asAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  $script:listType = [System.Collections.Generic.IReadOnlyList[Windows.Storage.IStorageItem]]
  $script:winrt = $true
} catch { $script:winrt = $false }

function Await($op, $type) {
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

function AwaitAct($op) {
  $t = $script:asAct.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
}

function Get-DevId($dev) {
  $item = Get-Dev $dev
  if ($null -eq $item) { throw 'Пристрій не знайдено' }
  $m = [regex]::Match([string]$item.Path, '\\\\\?\\.+$')
  if (-not $m.Success) { throw 'Немає ідентифікатора пристрою' }
  return $m.Value
}

function Find-WinrtItem($it) {
  $cur = [Windows.Devices.Portable.StorageDevice]::FromId((Get-DevId $it.dev))
  $names = @($it.names | Where-Object { $_ } | ForEach-Object { [string]$_ })
  for ($level = 0; $level -lt $names.Count; $level++) {
    $n = [string]$names[$level]
    $list = @(Await $cur.GetItemsAsync() $script:listType)
    $next = $null
    for ($i = 0; $i -lt $list.Count; $i++) {
      if ([string]::Equals([string]$list[$i].Name, $n, [StringComparison]::OrdinalIgnoreCase)) { $next = $list[$i]; break }
    }
    if ($null -eq $next) {
      try { $next = Await $cur.TryGetItemAsync($n) ([Windows.Storage.IStorageItem]) } catch {}
    }
    if ($null -eq $next -and $level -eq 0) {
      if ($list.Count -eq 1) { $next = $list[0] }
      else {
        $idx = 0; $found = -1
        foreach ($c in (Get-Dev $it.dev).GetFolder.Items()) {
          if ((NameOf $c) -eq $n) { $found = $idx; break }
          $idx++
        }
        if ($found -ge 0 -and $found -lt $list.Count) { $next = $list[$found] }
      }
    }
    if ($null -eq $next) {
      throw 'не знайдено'
    }
    $cur = $next
  }
  return $cur
}

function Copy-Winrt($x, $dst, $base, $isz) {
  if ($x.IsOfType([Windows.Storage.StorageItemTypes]::Folder)) {
    [void][IO.Directory]::CreateDirectory($dst)
    $items = Await $x.GetItemsAsync() $script:listType
    foreach ($c in $items) {
      $null = Copy-Winrt $c (Join-Path $dst $c.Name) $base $isz
    }
  } else {
    $in = [System.IO.WindowsRuntimeStorageExtensions]::OpenStreamForReadAsync($x).GetAwaiter().GetResult()
    $out = [IO.File]::Create($dst)
    try {
      $buf = New-Object byte[] 4194304
      $sw = [Diagnostics.Stopwatch]::StartNew()
      while ($true) {
        $n = $in.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $script:cum += $n
        if ($sw.ElapsedMilliseconds -gt 250) { Report $base $script:cum $isz; $sw.Restart() }
      }
    } finally { $out.Dispose(); $in.Dispose() }
  }
}

function Put-Winrt($src, $destFolder, $name, $base, $isz) {
  $perm = [Windows.Storage.StorageDeleteOption]::PermanentDelete
  $srcIsDir = Test-Path -LiteralPath $src -PathType Container
  $ex = Await $destFolder.TryGetItemAsync($name) ([Windows.Storage.IStorageItem])
  if ($srcIsDir) {
    if ($null -ne $ex -and -not $ex.IsOfType([Windows.Storage.StorageItemTypes]::Folder)) {
      AwaitAct ($ex.DeleteAsync($perm))
      $ex = $null
    }
    if ($null -ne $ex) { $f = $ex }
    else { $f = Await $destFolder.CreateFolderAsync($name, [Windows.Storage.CreationCollisionOption]::FailIfExists) ([Windows.Storage.StorageFolder]) }
    foreach ($c in Get-ChildItem -LiteralPath $src -Force) {
      $null = Put-Winrt $c.FullName $f $c.Name $base $isz
    }
  } else {
    if ($null -ne $ex) { AwaitAct ($ex.DeleteAsync($perm)) }
    $f = Await $destFolder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::FailIfExists) ([Windows.Storage.StorageFile])
    $in = [IO.File]::OpenRead($src)
    $out = [System.IO.WindowsRuntimeStorageExtensions]::OpenStreamForWriteAsync($f).GetAwaiter().GetResult()
    try {
      $buf = New-Object byte[] 1048576
      $sw = [Diagnostics.Stopwatch]::StartNew()
      while ($true) {
        $n = $in.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $script:cum += $n
        if ($sw.ElapsedMilliseconds -gt 250) { Report $base $script:cum $isz; $sw.Restart() }
      }
      $out.Flush()
    } finally { $out.Dispose(); $in.Dispose() }
  }
}

function Copy-ToMtp($it, $p, $dest, $base) {
  $df = Find-WinrtItem $dest
  $leaf = [string]$it.name
  $pre = Await $df.TryGetItemAsync($leaf) ([Windows.Storage.IStorageItem])
  $merge = ($null -ne $pre) -and $p.isDir -and $pre.IsOfType([Windows.Storage.StorageItemTypes]::Folder)
  $script:cum = [int64]0
  try { $null = Put-Winrt ([string]$it.path) $df $leaf $base $p.isz }
  catch {
    if (-not $merge) {
      try {
        $part = Await $df.TryGetItemAsync($leaf) ([Windows.Storage.IStorageItem])
        if ($null -ne $part) { AwaitAct ($part.DeleteAsync([Windows.Storage.StorageDeleteOption]::PermanentDelete)) }
      } catch {}
    }
    throw
  }
  Report $base $p.isz $p.isz
  return $leaf
}

function Copy-FromMtp($it, $p, $dpath, $base, $merge) {
  $x = Find-WinrtItem $it
  $dst = Join-Path $dpath ([string]$it.name)
  $script:cum = [int64]0
  try { $null = Copy-Winrt $x $dst $base $p.isz }
  catch {
    if (-not $merge -and (Test-Path -LiteralPath $dst)) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
    throw
  }
  Report $base $p.isz $p.isz
  return $dst
}

try {
  $job = Get-Content -LiteralPath $env:CONSOLIO_JOB -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($job.op -eq 'delete') {
    foreach ($it in @($job.items)) {
      try { Remove-Mtp $it; $deleted++ }
      catch { [void]$errors.Add("$($it.name): $($_.Exception.Message)") }
    }
  } elseif ($job.op -eq 'rename') {
    $it = @($job.items)[0]
    try { Rename-Mtp $it ([string]$job.newname) }
    catch { [void]$errors.Add($_.Exception.Message) }
  } elseif ($job.op -eq 'renamemany') {
    foreach ($it in @($job.items)) {
      try { Rename-Mtp $it ([string]$it.newname) }
      catch { [void]$errors.Add("$($it.name): $($_.Exception.Message)"); break }
    }
  } else {
    $dest = $job.dest
    $dnames = @($dest.names | Where-Object { $_ })
    $plan = @()
    foreach ($it in @($job.items)) {
      try {
        $src = Find-Src $it
        $isDir = [bool]$src.IsFolder
        $expSize = [int64]-1
        $expCnt = 0
        $isz = [int64]0
        if ($isDir) {
          if ($it.mtp) { $g = $src.GetFolder; $expCnt = CountShell $g; $isz = SumShell $g }
          else { $expCnt = CountLocal $it.path; $isz = SumLocal $it.path }
        } else {
          if ($it.mtp) { $expSize = SizeOf $src } else { $expSize = (Get-Item -LiteralPath $it.path -Force).Length }
          if ($expSize -gt 0) { $isz = $expSize }
        }
        $plan += [PSCustomObject]@{ it = $it; src = $src; isDir = $isDir; expSize = $expSize; expCnt = $expCnt; isz = $isz }
      } catch {
        [void]$errors.Add("$($it.name): $($_.Exception.Message)")
      }
    }
    foreach ($p in $plan) { $script:total += $p.isz }
    $base = [int64]0
    foreach ($p in $plan) {
      $it = $p.it
      $script:pname = [string]$it.name
      Report $base 0 $p.isz
      try {
        $leaf = [string]$it.name
        if ($dest.mtp) {
          $df = Get-MtpFolder $dest.dev $dnames
          $existing = $null
          foreach ($c in $df.Items()) {
            if ((NameOf $c) -eq $leaf) { $existing = $c; break }
          }
          if ($null -ne $existing) {
            $ans = Ask-Conflict $leaf $p.isDir
            if ($ans -eq 'cancel') { $script:cancelled = $true; break }
            if ($ans -eq 'skip') { $base += $p.isz; Report $base 0 0; continue }
            if (-not $script:winrt) {
              $ex = [PSCustomObject]@{ mtp = $true; dev = $dest.dev; names = (@($dnames) + $leaf); name = $leaf }
              Remove-Mtp $ex
            }
          }
          $res = $null
          if ($script:winrt -and -not $it.mtp) {
            try { $res = Copy-ToMtp $it $p $dest $base } catch { $res = $null }
          }
          if ($null -eq $res) {
            $pl = Start-Poller $false '' @{} $base $p.isz
            try {
              $df.CopyHere($p.src, 1028)
              $res = Wait-Mtp $dest.dev $dnames $leaf $p.isDir $p.expSize $p.expCnt $base $p.isz
            } finally { Stop-Poller $pl }
          }
        } else {
          $dpath = [string]$dest.path
          $dstFull = Join-Path $dpath $leaf
          $merge = $false
          if (Test-Path -LiteralPath $dstFull) {
            $ans = Ask-Conflict $leaf $p.isDir
            if ($ans -eq 'cancel') { $script:cancelled = $true; break }
            if ($ans -eq 'skip') { $base += $p.isz; Report $base 0 0; continue }
            if ($p.isDir -and (Test-Path -LiteralPath $dstFull -PathType Container)) { $merge = $true }
            else { Remove-Item -LiteralPath $dstFull -Recurse -Force }
          }
          $res = $null
          if ($it.mtp -and $script:winrt) {
            try { $res = Copy-FromMtp $it $p $dpath $base $merge } catch { $res = $null }
          }
          if ($null -eq $res) {
            $before = @{}
            foreach ($e in [IO.Directory]::GetFileSystemEntries($dpath)) { $before[$e] = 1 }
            $pl = Start-Poller $true $dpath $before $base $p.isz
            try {
              $sh.Namespace($dpath).CopyHere($p.src, 1548)
              $res = Wait-Local $dpath $before $p.isDir $p.expSize $p.expCnt $base $p.isz
            } finally { Stop-Poller $pl }
          }
        }
        [void]$created.Add([string]$res)
        [void]$done.Add([string]$it.path)
        if (($job.mode -eq 'cut') -and $it.mtp) { Remove-Mtp $it }
      } catch {
        [void]$errors.Add("$($it.name): $($_.Exception.Message)")
      }
      $base += $p.isz
      Report $base 0 0
    }
  }
  $out = [PSCustomObject]@{ created = $created.ToArray(); errors = $errors.ToArray(); done = $done.ToArray(); deleted = $deleted; cancelled = [bool]$script:cancelled }
} catch {
  $out = [PSCustomObject]@{ fatal = $_.Exception.Message }
}
ConvertTo-Json -InputObject $out -Compress -Depth 4
'''


def is_mtp(path):
    return isinstance(path, str) and path.startswith("::")


def split(path):
    parts = path.split(SEP)
    return parts[0], [n for n in parts[1:] if n]


def _lst(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _run(job, track=False):
    global _progress_path, _conflict_path, _answer_path
    if not IS_WIN:
        return {"fatal": "Підтримується лише у Windows"}
    job_file = script_file = prog_file = None
    extra = []
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
            job_file = f.name
        with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8-sig") as f:
            f.write(SCRIPT)
            script_file = f.name
        env = dict(os.environ, CONSOLIO_JOB=job_file)
        if track:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                prog_file = f.name
            env["CONSOLIO_PROGRESS"] = prog_file
            _progress_path = prog_file
            _conflict_path = prog_file + ".conflict"
            _answer_path = prog_file + ".answer"
            env["CONSOLIO_CONFLICT"] = _conflict_path
            env["CONSOLIO_ANSWER"] = _answer_path
            extra = [_conflict_path, _answer_path, _answer_path + ".tmp"]
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", script_file],
            capture_output=True, env=env, creationflags=0x08000000,
        )
        text = proc.stdout.decode("utf-8", "replace")
        line = next(
            (l.strip() for l in reversed(text.splitlines()) if l.strip().startswith("{")), ""
        )
        if not line:
            err = proc.stderr.decode("utf-8", "replace").strip()
            return {"fatal": err[:200] or "Порожня відповідь"}
        return json.loads(line.lstrip("\ufeff"))
    except Exception as e:
        return {"fatal": str(e)}
    finally:
        if prog_file:
            _progress_path = None
            _conflict_path = None
            _answer_path = None
        for p in [job_file, script_file, prog_file] + extra:
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass


def paste(paths, dest, mode):
    dest_mtp = is_mtp(dest)
    if dest_mtp:
        dev, dnames = split(dest)
        if not dnames:
            return [], ["Відкрийте папку на пристрої (у корені вставляти не можна)"], False
    elif not os.path.isdir(dest):
        return [], ["Папка призначення недоступна"], False
    else:
        dev, dnames = "", []
    if dest_mtp and any(is_mtp(p) for p in paths):
        return [], ["Копіювання всередині пристрою не підтримується"], False

    items = []
    for p in paths:
        if is_mtp(p):
            d, names = split(p)
            if names:
                items.append({"mtp": True, "dev": d, "names": names, "name": names[-1], "path": p})
        else:
            items.append({"mtp": False, "path": p,
                          "name": os.path.basename(p.rstrip("\\/")) or p})
    if not items:
        return [], [], False

    res = _run({
        "op": "paste", "mode": mode, "items": items,
        "dest": {"mtp": dest_mtp, "dev": dev, "names": dnames, "path": dest},
    }, track=True)
    if res.get("fatal"):
        return [], [res["fatal"]], False
    created = [dest + SEP + c if dest_mtp else c for c in _lst(res.get("created"))]
    errors = [str(e) for e in _lst(res.get("errors"))]
    if mode == "cut" and dest_mtp:
        local_done = [p for p in _lst(res.get("done")) if not is_mtp(p)]
        if local_done:
            _, derrs = ops.delete(local_done, False)
            errors.extend(derrs)
    return created, errors, bool(res.get("cancelled"))


def rename(path, new_name):
    err = ops.bad_name(new_name)
    if err:
        return None, err
    d, names = split(path)
    if len(names) < 2:
        return None, "Не можна перейменувати сховище"
    item = {"mtp": True, "dev": d, "names": names, "name": names[-1], "path": path}
    res = _run({"op": "rename", "items": [item], "newname": new_name})
    if res.get("fatal"):
        return None, res["fatal"]
    errors = _lst(res.get("errors"))
    if errors:
        return None, str(errors[0])
    return SEP.join([d] + names[:-1] + [new_name]), None


def rename_many(steps):
    items = []
    for path, new_name in steps:
        d, names = split(path)
        items.append({"mtp": True, "dev": d, "names": names, "name": names[-1],
                      "path": path, "newname": new_name})
    res = _run({"op": "renamemany", "items": items})
    if res.get("fatal"):
        return [res["fatal"]]
    return [str(e) for e in _lst(res.get("errors"))]


def delete(paths):
    items = []
    for p in paths:
        d, names = split(p)
        if names:
            items.append({"mtp": True, "dev": d, "names": names, "name": names[-1], "path": p})
    if not items:
        return 0, ["Нічого видаляти"]
    res = _run({"op": "delete", "items": items})
    if res.get("fatal"):
        return 0, [res["fatal"]]
    return int(res.get("deleted") or 0), [str(e) for e in _lst(res.get("errors"))]
