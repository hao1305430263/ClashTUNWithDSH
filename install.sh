#!/usr/bin/env bash
# ClashTUNWithDSH 一键安装：解除 DSH web_fetch 的非公网 IP 解析限制，兼容 Clash TUN（fake-ip）。
# 把宿主平面插件 clash-tun-web-fetch-unlock.cjs 安装到 $DSH_HOME，并在
# $DSH_HOME/cordis.patch.yml（DSH 官方家目录用户补丁层）追加一个受管理的
# insert 行，使其挂载到宿主组合——对所有 profile 的所有会话生效。
# 若当前 profile 开启了 live 补丁热重载，保存即生效；否则 DSH 下次启动生效。
#
# 用法：
#   ./install.sh            安装
#   ./install.sh uninstall  卸载
set -euo pipefail

MARKER_BEGIN='# >>> classtunwithdsh (managed block; do not edit inside)'
MARKER_END='# <<< classtunwithdsh'
PLUGIN_FILE='clash-tun-web-fetch-unlock.cjs'

die() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- 定位 DSH 主目录 -----------------------------------------------------------
if [ -n "${DSH_HOME:-}" ]; then
  dsh_home="$DSH_HOME"
else
  dsh_home="${HOME}/.dsh"
fi
[ -d "$dsh_home" ] || die "未找到 DSH 主目录：$dsh_home（可用 \$DSH_HOME 指定）"

patch_path="$dsh_home/cordis.patch.yml"
target_plugin="$dsh_home/$PLUGIN_FILE"
payload_path="$script_dir/payload/$PLUGIN_FILE"
[ -f "$payload_path" ] || die "安装载荷缺失：$payload_path（请从完整的仓库运行本脚本）"

managed_block="$MARKER_BEGIN
- insert:
    - id: clash-tun-web-fetch-unlock
      name: ./$PLUGIN_FILE
$MARKER_END"

# 输出：块外内容（CR 规范化、去掉尾部空行）+ 受管块。直接读文件，便于测试。
rebuild_with_block() {
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" -v block="$managed_block" '
    { sub(/\r$/, "") }
    $0 == b { inblock = 1; next }
    $0 == e { inblock = 0; next }
    !inblock { lines[++n] = $0 }
    END {
      while (n > 0 && lines[n] == "") n--
      for (i = 1; i <= n; i++) print lines[i]
      print ""
      m = split(block, bl, "\n")
      for (i = 1; i <= m; i++) print bl[i]
    }
  ' "$1"
}

printf 'DSH 主目录: %s\n' "$dsh_home"

if [ "${1:-install}" = "uninstall" ]; then
  if [ -f "$patch_path" ] && grep -qF -- "$MARKER_BEGIN" "$patch_path"; then
    tmp="$(mktemp)"
    awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
      { sub(/\r$/, "") }
      $0 == b { inblock = 1; next }
      $0 == e { inblock = 0; next }
      !inblock { lines[++n] = $0 }
      END {
        while (n > 0 && lines[n] == "") n--
        for (i = 1; i <= n; i++) print lines[i]
      }
    ' "$patch_path" > "$tmp"
    mv "$tmp" "$patch_path"
    printf '已从 %s 移除受管块。\n' "$patch_path"
  else
    printf 'cordis.patch.yml 中没有受管块，跳过。\n'
  fi
  rm -f -- "$target_plugin"
  printf '已删除 %s\n' "$target_plugin"
  printf '卸载完成。若 DSH 正在运行且未开启补丁热重载，重启 DSH 后恢复原行为。\n'
  exit 0
fi

# --- 安装 -----------------------------------------------------------------------
if [ -f "$patch_path" ]; then
  if grep -qF -- "$MARKER_BEGIN" "$patch_path"; then
    rebuild_with_block "$patch_path" > "$patch_path.tmp"
    mv "$patch_path.tmp" "$patch_path"
    printf 'cordis.patch.yml 已存在受管块，已刷新（幂等安装）。\n'
  else
    { printf '\n%s\n' "$managed_block" >> "$patch_path"; }
    printf '已在现有 cordis.patch.yml 追加受管块。\n'
  fi
else
  {
    printf '# DSH 家目录用户补丁层（对所有 profile 生效）。\n'
    printf '# 其中 classtunwithdsh 受管块由 ClashTUNWithDSH 的 install.ps1 / install.sh 维护，\n'
    printf '# 卸载请运行对应脚本的卸载命令，请勿手改标记之间内容。\n'
    printf '\n'
    printf '%s\n' "$managed_block"
  } > "$patch_path"
  printf '已创建 %s\n' "$patch_path"
fi

cp -f -- "$payload_path" "$target_plugin"
printf '已安装插件模块：%s\n' "$target_plugin"

printf '\n安装完成。生效方式：\n'
printf '  - 若当前 profile 开启了补丁热重载（live），保存即生效，无需重启；\n'
printf '  - 否则重启 DSH 后生效。\n'
printf '验证（任一会话中）：\n'
printf '  web_fetch http://127.0.0.1:3080/   # 原先会报 "resolves to a non-public IP address"，现在应返回 HTTP 响应\n'
printf '卸载：./install.sh uninstall\n'
