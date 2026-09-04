#Requires -Version 5.1
<#
.SYNOPSIS
    ClashTUNWithDSH 一键安装：解除 DSH web_fetch 的非公网 IP 解析限制，兼容 Clash TUN（fake-ip）。

.DESCRIPTION
    把宿主平面插件 clash-tun-web-fetch-unlock.cjs 安装到 $DSH_HOME，并在
    $DSH_HOME/cordis.patch.yml（DSH 官方家目录用户补丁层）追加一个受管理的
    insert 行，使其挂载到宿主组合——对所有 profile 的所有会话生效。
    若当前 profile 开启了 live 补丁热重载，保存即生效；否则 DSH 下次启动生效。

.PARAMETER Uninstall
    卸载：从 cordis.patch.yml 移除受管块并删除插件文件。

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$MarkerBegin = '# >>> classtunwithdsh (managed block; do not edit inside)'
$MarkerEnd = '# <<< classtunwithdsh'
$PluginFile = 'clash-tun-web-fetch-unlock.cjs'

function Get-DshHome {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
        return $env:DSH_HOME.Trim()
    }
    return (Join-Path $HOME '.dsh')
}

function New-ManagedBlock {
    @"

$MarkerBegin
- insert:
    - id: clash-tun-web-fetch-unlock
      name: ./$PluginFile
$MarkerEnd
"@
}

function Write-Utf8([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# --- 定位安装要素 -------------------------------------------------------------
$dshHome = Get-DshHome
if (-not (Test-Path -LiteralPath $dshHome -PathType Container)) {
    throw "未找到 DSH 主目录：$dshHome（可用 `$env:DSH_HOME 指定）"
}
$patchPath = Join-Path $dshHome 'cordis.patch.yml'
$targetPlugin = Join-Path $dshHome $PluginFile
$payloadPath = Join-Path $PSScriptRoot (Join-Path 'payload' $PluginFile)
if (-not (Test-Path -LiteralPath $payloadPath)) {
    throw "安装载荷缺失：$payloadPath（请从完整的仓库运行本脚本）"
}

Write-Host "DSH 主目录: $dshHome"

if ($Uninstall) {
    if (Test-Path -LiteralPath $patchPath) {
        $lines = [System.IO.File]::ReadAllLines($patchPath)
        $out = New-Object System.Collections.Generic.List[string]
        $inBlock = $false
        $removed = $false
        foreach ($line in $lines) {
            if ($line -eq $MarkerBegin) { $inBlock = $true; $removed = $true; continue }
            if ($line -eq $MarkerEnd)   { $inBlock = $false; continue }
            if ($inBlock) { continue }
            $out.Add($line)
        }
        if ($removed) {
            # 丢掉块移除后留下的多余尾部空行。
            while ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }
            Write-Utf8 $patchPath (($out -join "`r`n") + "`r`n")
            Write-Host "已从 $patchPath 移除受管块。"
        } else {
            Write-Host 'cordis.patch.yml 中没有受管块，跳过。'
        }
    } else {
        Write-Host '未找到 cordis.patch.yml，无需卸载补丁行。'
    }
    if (Test-Path -LiteralPath $targetPlugin) {
        Remove-Item -LiteralPath $targetPlugin -Force
        Write-Host "已删除 $targetPlugin"
    }
    Write-Host '卸载完成。若 DSH 正在运行且未开启补丁热重载，重启 DSH 后恢复原行为。'
    exit 0
}

# --- 安装 ---------------------------------------------------------------------
if (Test-Path -LiteralPath $patchPath) {
    $existing = [System.IO.File]::ReadAllText($patchPath)
    if ($existing.Contains($MarkerBegin)) {
        # 幂等：替换受管块（块内内容与当前 payload 约定保持一致）。
        $pattern = [regex]::Escape($MarkerBegin) + '[\s\S]*?' + [regex]::Escape($MarkerEnd)
        $updated = [regex]::Replace($existing, $pattern, ((New-ManagedBlock).TrimEnd()), 'Multiline')
        Write-Utf8 $patchPath $updated
        Write-Host 'cordis.patch.yml 已存在受管块，已刷新（幂等安装）。'
    } else {
        $append = "`r`n" + (New-ManagedBlock).TrimEnd() + "`r`n"
        [System.IO.File]::AppendAllText($patchPath, $append, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host '已在现有 cordis.patch.yml 追加受管块。'
    }
} else {
    $header = @(
        '# DSH 家目录用户补丁层（对所有 profile 生效）。',
        '# 其中 classtunwithdsh 受管块由 ClashTUNWithDSH 的 install.ps1 / install.sh 维护，',
        '# 卸载请运行对应脚本的 -Uninstall，请勿手改标记之间内容。',
        ''
    ) -join "`r`n"
    Write-Utf8 $patchPath ($header + (New-ManagedBlock).TrimEnd() + "`r`n")
    Write-Host "已创建 $patchPath"
}

Copy-Item -LiteralPath $payloadPath -Destination $targetPlugin -Force
Write-Host "已安装插件模块：$targetPlugin"

Write-Host ''
Write-Host '安装完成。生效方式：'
Write-Host '  - 若当前 profile 开启了补丁热重载（live），保存即生效，无需重启；'
Write-Host '  - 否则重启 DSH 后生效。'
Write-Host '验证（任一会话中）：'
Write-Host '  web_fetch http://127.0.0.1:3080/   # 原先会报 "resolves to a non-public IP address"，现在应返回 HTTP 响应'
Write-Host '卸载：.\install.ps1 -Uninstall'
