#!/bin/bash
# 双击此脚本直接启动 ChinaK12BookDownLoader 桌面客户端
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/dist/ChinaK12BookDownLoader-darwin-arm64/ChinaK12BookDownLoader.app"

# 确保关闭旧残留进程，保证加载最新构建与严格 2 并发配置
pkill -f "ChinaK12BookDownLoader" 2>/dev/null
sleep 0.5

if [ -d "$APP" ]; then
    open "$APP"
else
    cd "$DIR"
    npm start
fi
