#!/bin/bash
# 双击此脚本启动 K12 Books 桌面客户端
DIR="$(cd "$(dirname "$0")" && pwd)"
for APP in "$DIR/dist/mac-arm64/K12 Books.app" "$DIR/dist/mac/K12 Books.app" "$DIR/dist/mac-x64/K12 Books.app"; do
    if [ -d "$APP" ]; then
        open "$APP"
        exit $?
    fi
done
cd "$DIR" || exit 1
npm start
