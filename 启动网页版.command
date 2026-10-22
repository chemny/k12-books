#!/bin/bash
# 双击此脚本直接启动 K12 Books Web 服务并在浏览器打开
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 延迟 1 秒自动打开默认浏览器
(sleep 1 && open "http://127.0.0.1:8080") &

node server.js 8080
