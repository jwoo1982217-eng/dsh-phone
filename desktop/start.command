#!/bin/zsh
cd -- "${0:A:h}/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/start-desktop.mjs
if (( $? != 0 )); then
  print "启动失败。请保留上面的错误，按 desktop/README.md 检查安装。"
  read "?按回车关闭…"
fi
