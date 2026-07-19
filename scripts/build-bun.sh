#!/bin/bash
# build-bun.sh
#
# Bun でコンパイルするための専用ビルドスクリプト.
#
# 【背景】
# pdf-parse (node_modules/pdf-parse/lib/pdf-parse.js) は内部で
#   require(`./pdf.js/${options.version}/build/pdf.js`)
# という動的requireを使っている. Bun の `bun build --compile` は静的解析で
# バンドル対象ファイルを決定するため、この動的require先を検出できず、
# コンパイル後のバイナリ実行時に "Cannot find module" エラーになる.
#
# そのため、コンパイル前に一時的にバージョンを固定した静的requireへ書き換え、
# コンパイル完了後に元の動的requireへ復元する (node_modules を汚したままにしないため).
#
# 【public/ について】
# Bunコンパイル済みバイナリは __dirname がコンパイル時のソースパス (開発機の
# 絶対パス) に固定されてしまうため、apiServer.js は実行バイナリの実際の場所
# (process.execPath) を基準に "そのバイナリと同じディレクトリの public/" を
# 探すようにしている (Bunコンパイル済みバイナリ実行時のみ). そのため、このスクリプトは
# コンパイル後に src/public/ を出力先と同じディレクトリの public/ にコピーする.
#
# 【使い方】
#   ./scripts/build-bun.sh [出力先パス]
#   ./scripts/build-bun.sh              # ./dist/glint に出力
#   ./scripts/build-bun.sh ./dist/myapp
#
# 【前提】
#   - npm install 済み (node_modules/pdf-parse が存在すること)
#   - bun がインストールされていること
#
set -eu

# このスクリプトの位置からプロジェクトルートを特定する.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

OUT_FILE="${1:-./dist/glint}"
ENTRY_FILE="./src/apiServer.js"
PDF_PARSE_FILE="./node_modules/pdf-parse/lib/pdf-parse.js"
# pdf-parse (lib/pdf-parse.js) の DEFAULT_OPTIONS.version と合わせること.
PDF_JS_VERSION="v1.10.100"

if [ ! -f "${PDF_PARSE_FILE}" ]; then
    echo "Error: ${PDF_PARSE_FILE} が見つかりません。先に 'npm install' を実行してください。" >&2
    exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
    echo "Error: bun コマンドが見つかりません。" >&2
    exit 1
fi

mkdir -p "$(dirname "${OUT_FILE}")"

# 元のファイルを退避 (ビルド後に必ず復元するため).
BACKUP_FILE="$(mktemp)"
cp "${PDF_PARSE_FILE}" "${BACKUP_FILE}"

# 成功・失敗にかかわらず、必ず元の動的require版に復元する.
restore() {
    cp "${BACKUP_FILE}" "${PDF_PARSE_FILE}"
    rm -f "${BACKUP_FILE}"
}
trap restore EXIT

echo "==> pdf-parse の動的requireを静的requireに一時的にパッチします (${PDF_JS_VERSION})"
# 動的require (テンプレートリテラル) を、固定バージョンの静的requireに書き換える.
sed -i.bak \
    "s|require(\`./pdf.js/\${options.version}/build/pdf.js\`)|require('./pdf.js/${PDF_JS_VERSION}/build/pdf.js')|" \
    "${PDF_PARSE_FILE}"
rm -f "${PDF_PARSE_FILE}.bak"

# パッチが実際に当たったことを確認する.
if ! grep -q "require('./pdf.js/${PDF_JS_VERSION}/build/pdf.js')" "${PDF_PARSE_FILE}"; then
    echo "Error: pdf-parse へのパッチ適用に失敗しました。pdf-parse のバージョンが" >&2
    echo "       想定と異なる可能性があります。手動で確認してください。" >&2
    exit 1
fi

echo "==> bun build --compile ${ENTRY_FILE} --outfile ${OUT_FILE}"
bun build --compile "${ENTRY_FILE}" --outfile "${OUT_FILE}"

# public/ (画面用の静的ファイル・jhtmlテンプレート) をバイナリと同じ場所にコピーする.
OUT_DIR="$(cd "$(dirname "${OUT_FILE}")" && pwd)"
echo "==> src/public を ${OUT_DIR}/public にコピーします"
rm -rf "${OUT_DIR}/public"
cp -r "./src/public" "${OUT_DIR}/public"

echo "==> 完了: ${OUT_FILE} (同ディレクトリに public/ を配置済み)"
echo "    (node_modules/pdf-parse は元の動的require版に復元されます)"
