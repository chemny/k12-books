#!/bin/bash
# 双击此脚本直接启动 ChinaK12BookDownLoader 桌面客户端
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/dist/ChinaK12BookDownLoader-darwin-arm64/ChinaK12BookDownLoader.app"

if [ -d "$APP" ]; then
    open "$APP"
else
    cd "$DIR"
    npm start
fi
