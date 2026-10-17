#!/usr/bin/env bash
# 打包发布用的 claim-vip.zip。
# zip 内顶层必须是 claim-vip/ 目录，EchoMusic 的安装器会据此找到 manifest.json。
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/claim-vip.zip"

# 与 manifest.json 同版本的源码一致性检查，避免打出发错版本的包
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
for (const key of ["id", "name", "version", "main"]) {
  if (!String(manifest[key] ?? "").trim()) {
    console.error(`manifest.${key} 不能为空`);
    process.exit(1);
  }
}
for (const file of [manifest.main, manifest.icon].filter(Boolean)) {
  if (!fs.existsSync(file)) {
    console.error(`manifest 引用的文件不存在: ${file}`);
    process.exit(1);
  }
}
'

rm -rf dist "claim-vip"
mkdir -p "claim-vip"
cp manifest.json index.js icon.svg claim-vip/
mkdir -p dist
zip -r -X "$OUT" claim-vip >/dev/null
rm -rf claim-vip

echo "已生成 $OUT (v$VERSION)"
unzip -l "$OUT"
