# ✨ Glint

**「きらりと光る、一瞬の輝き」— 目的の箇所を瞬時に見つける、ローカルLLM RAGシステム**

Glint は [llama.cpp](https://github.com/ggml-org/llama.cpp) をバックエンドに利用し、**ローカルLLMのみで動作する高精度なRAG（検索拡張生成）システム**を Node.js で構築するプロジェクトです。外部のクラウドAPIやベクトルDBに依存せず、自前でベクトル検索を実装することで、構成をシンプルに保ちながら実用的な検索精度を実現しています。

---

## 特徴

- **ベクトルDB不要**: 専用のベクトル検索エンジン（Pinecone、Chroma等）を使わず、自前のベクトル検索ロジックで動作。小規模〜中規模データ（1グループあたり最大 約1万件程度）を想定した軽量構成。チャンク本体・文書サマリーは`node:sqlite`/`bun:sqlite`（SQLite）で管理し、1文書の追加・削除は対象文書の行だけを更新するだけで済む（グループ全体をロード・再書き込みする必要がない）。
- **サマリー併用型RAG**: 文書登録時にローカルLLMで「タグ・カテゴリ・サマリー」を自動生成し、通常のチャンク検索結果と組み合わせて回答生成に利用することで、検索効率と回答精度を向上。
- **タグ/カテゴリによる絞り込み検索**: RAG検索時にベクトル検索の候補チャンクをタグ・カテゴリで事前フィルタリングできる（対象文書が上位候補に入らず取り逃す、という問題が発生しない）。グループ内のタグ/カテゴリ集計（件数・比率）は`metaStore.js`（SQLite）で管理し、文書数が増えても高速に集計できる。
- **グループ単位の許可タグ一覧**: グループごとに「使用可能なタグの固定リスト」を設定できる（`GET`/`PUT /api/groups/:group/tags`）。設定時、文書登録時のタグ生成はLLMがそのリストの中からのみ選択し、該当しない場合は自動的に「その他」になる（未設定時は従来通りLLMが自由に生成）。表記ゆれによる絞り込み漏れを抑制する。
- **ハイブリッド検索**: ベクトル検索のコサイン類似度に、SQLite FTS5（`trigram`トークナイザ + BM25ランキング）によるキーワードスコアを合成できる（デフォルトON）。embeddingだけでは弱い固有名詞・識別子的な語の完全一致検索を補強する。
- **リランキング**: ベクトル検索で絞られた候補文書を、RAGプロンプトに含める前にLLMで質問との関連度順に並び替える（デフォルトON）。ベクトルスコアだけでは拾いきれない関連性を補正する。
- **検索ログ（オプション）**: `searchLogEnabled: true` を設定すると、質問文・引用文書一覧をSQLiteに記録できる（デフォルトOFF。質問文などの実データが蓄積されるため明示的なopt-in）。`scripts/evalSearch.js`用の評価データセット作成の元データ等に活用できる。
- **完全ローカル動作 + OpenAI/ルーターモード対応**: llama.cpp サーバー（OpenAI API互換）に接続するほか、`model`/`apiKey`/`apiType`の設定でOpenAI本家やOpenAI互換ルーター（LiteLLM等）にも接続できる。
- **複数サーバ対応 + 接続管理**: 埋め込み用・推論用のサーバーをそれぞれ複数台登録し、`connectMan.js` が同時接続数上限・定期ヘルスチェックに基づいて負荷分散する。
- **プロセス間ロック対応**: 複数の Node.js プロセスから同時にベクトルストアを更新しても安全に動作するよう、ファイルロックによる同期処理を実装。
- **プロンプトの英語化による高速化**: LLMへ送る実際のプロンプト（システム/ユーザ）は英語化されており、トークン処理効率を高めて応答速度を向上（内容確認用の日本語版も保持）。
- **HTTP APIサーバー**: 文書登録・RAG検索・グループ管理を外部から利用できる HTTP API を Node.js 標準の `http` モジュールのみで提供。
- **PDF文書登録対応**: テキストレイヤー付きPDFをアップロードすると、`pdf-parse`（本プロジェクト唯一の外部npm依存）でテキストを抽出して登録できる。
- **参照URLの自動発行**: 文書登録時に参照URLを指定しない場合、アップロードした元データ（テキスト/PDF）を保存し、`apiServer.js` 経由でダウンロードできるURLを自動発行して文書の参照URLとする。
- **ローカルログ出力**: `localLog.js` により `console.*` の出力を日次ローテートのログファイルにも記録（`glint.json` の `logLevel` で出力レベルを制御）。
- **バックアップ/レストア**: グループ単位で `.vgs`/`.vss` と元データを1つのJSONにまとめてバックアップ・復元できる。
- **ブラウザ管理画面**: `src/public/` にWeb管理画面を同梱。機能別に「RAG検索」「文書登録」「グループ管理」の複数ページに分かれ、上部の共通メニューで切り替えられる。`jhtml.js`（JSPライクなテンプレートエンジン）でサーバサイド動的レンダリングし、Bunでの単一バイナリ化にも対応。
- **検索精度の定量評価**: `scripts/evalSearch.js` で、質問と正解文書のペア（評価データセット）に対するRecall@Kを計測できる。embeddingモデルの選定やリランキング/ハイブリッド検索のON/OFFなど、変更の効果を数値で確認できる。

## アーキテクチャ概要

```
┌──────────────┐        ┌───────────────────────┐
│  ドキュメント  │  --->  │ putTextFileToVectorGroup │
│ (テキストファイル)│        └───────────────────────┘
└──────────────┘                    │
                                     │ 1. ローカルLLMでタグ/カテゴリ/サマリー生成
                                     │ 2. テキストをチャンク分割
                                     │ 3. 各チャンクを埋め込みベクトル化
                                     ▼
                        ┌─────────────────────────────┐
                        │ VectorStore (SQLite: metaStore.js) │  ← 自前のベクトル検索用データ
                        └─────────────────────────────┘
                                     │
                  質問 --->  searchEmbedding                  →  searchInference
                             (tag/category事前フィルタ            (候補文書をLLMで
                              + ベクトル類似度とキーワード          関連度順にリランキング後、
                              スコアのハイブリッド検索)             RAGプロンプトに組み込んで推論)
                                     │                                    │
                                     ▼                                    ▼
                        検索結果チャンク + サマリー          { message: 回答本文,
                                                                list: 引用した参考文書一覧 }

  ※ 埋め込み・推論の接続先は connectMan.js が health / 同時接続数を見て選択する.
```

## 必要要件

- Node.js **22.5 以上**（標準の `fetch` API、および `node:sqlite`（実験的機能）を使用）。Bunで動かす場合は `bun:sqlite` を使用するため、Bun側の最小バージョンに準拠する。
- [llama.cpp](https://github.com/ggml-org/llama.cpp) の `--server` モードで起動した OpenAI API 互換サーバー
  - 埋め込み用モデル（例: `embeddinggemma`）
  - 推論用モデル（チャット補完対応モデル）

## セットアップ

より詳細な手順・全設定項目リファレンスは [docs/setup.md](./docs/setup.md) を参照してください。

```sh
npm install
```

※ `pdf-parse`（PDFテキスト抽出用）が唯一の外部npm依存としてインストールされます。

プロジェクトルートに `glint.json` を作成し、接続先や各種パラメータを設定します。

```jsonc
{
    // 埋め込みモデルサーバー (複数台指定可).
    "embeddingList": [{ "url": "http://192.168.0.230:8081" }],
    // 推論モデルサーバー (複数台指定可. エントリ単位で maxConnectCount を上書きできる).
    "inferenceList": [
        { "url": "http://192.168.0.235:8080" },
        { "url": "http://192.168.0.236:8080", "maxConnectCount": 4 }
    ],

    // llama.cppサーバ1台あたりの同時接続数上限のデフォルト値 (connectMan.js が使用).
    "maxConnectCount": 8,
    // OpenAI / OpenAI互換ルーターを使う場合は、エントリ単位 (または上記のグローバル既定)
    // で model/apiKey/apiType を指定する (詳細は docs/setup.md 参照).
    // 例: { "url": "https://api.openai.com", "model": "gpt-4o-mini", "apiKey": "sk-xxxx", "apiType": "openai" }
    // ヘルスチェック間隔 (ミリ秒).
    "healthCheckTiming": 15000,

    // fetchタイムアウト(ミリ秒).
    "fetchTimeout": 300000,
    // vectorStore格納先パスなど.
    "dirPath": "./test",
    "vectorStorePath": "./vectorStore",
    "srcDocumentPath": "./documents",

    // チャンクサイズ・検索件数などのチューニング項目.
    "chunkSize": 300,
    "summaryTemperature": 0,
    "summaryReasoning": true,
    "ragTemperature": 0,
    "ragReasoning": false,
    "vectorSearchLength": 18,
    "hybridSearch": true,
    "hybridKeywordWeight": 0.3,
    "ragRequestChunkLength": 6,
    "ragRerank": true,
    "rerankCandidateLength": 20,
    // 検索ログ(質問文・引用文書一覧)をSQLiteに記録するか. デフォルトOFF.
    "searchLogEnabled": false,

    // ローカルログ (localLog.js) の出力設定.
    "logDir": "./log",
    "logFile": "logout",
    "logLevel": "info",

    // 文書登録でurl未指定時に自動発行する参照URLのベースURL.
    // リバースプロキシ等の背後で動かす場合、外部から実際に到達可能なアドレスを指定する.
    // 未設定の場合はリクエストの Host ヘッダーから自動的に組み立てる.
    "publicBaseUrl": "https://example.com"
}
```

※ `//` によるコメント記述に対応しています。

## 使い方 (ライブラリとして)

```js
const vg = require("./src/vectorGroup.js");

const GROUP_NAME = "サンプルグループ";

// 1. 文書をVectorGroupに登録 (タグ/カテゴリ/サマリー生成 + ベクトル化).
await vg.putTextFileToVectorGroup(
    GROUP_NAME,
    "readme.txt",
    "http://example.com/readme.txt", // 参照元URL.
    "登録したいテキスト本文...",
);

// 2. 質問に対してベクトル検索を実施 (tags/categories で事前フィルタも可能).
const vgObj = await vg.loadVectorGroup(GROUP_NAME);
const searchResult = await vg.searchEmbedding(vgObj, "質問内容", {
    tags: ["プログラム"], // 省略可.
});

// 3. 検索結果を元にRAG推論を実行し、回答を取得.
// { message: 回答本文(string, Markdown可), list: 引用した参考文書一覧(Array<{name,url}>) }
const result = await vg.searchInference(searchResult, "質問内容");
console.log(result.message);

// グループ内のタグ/カテゴリ集計 (件数・比率) を取得.
const stats = await vg.getGroupStats(GROUP_NAME);
console.log(stats);
```

より実践的な使用例は `test.js` を参照してください。

## 使い方 (HTTP APIサーバーとして)

より詳細なAPI仕様（リクエスト/レスポンス例、エラー仕様、既知の制約）は [docs/apiServer.md](./docs/apiServer.md) を参照してください。

```sh
node src/apiServer.js
# または
PORT=3000 node src/apiServer.js
```

[Bun](https://bun.sh/) で単一実行バイナリにコンパイルすることも可能です（`./scripts/build-bun.sh`。詳細は [docs/setup.md](./docs/setup.md#bunで単一バイナリにコンパイルする場合) 参照）。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/groups` | グループ一覧 |
| POST | `/api/groups` | 空のグループ(文書0件)を新規作成 |
| GET | `/api/groups/:group/documents` | グループ内の文書一覧・文書数 (tag/category含む) |
| GET | `/api/groups/:group/stats` | グループ内の tag/category 集計 (件数・比率) |
| GET | `/api/groups/:group/tags` | グループ単位の許可タグ一覧取得 |
| PUT | `/api/groups/:group/tags` | グループ単位の許可タグ一覧設定 |
| POST | `/api/groups/:group/documents` | 文書登録 (非同期. 即時に `jobId` を返す) |
| DELETE | `/api/groups/:group/documents/:fileName` | 文書削除 |
| GET | `/api/groups/:group/documents/:fileName/raw` | 元データの取得 (url自動発行時のみ) |
| GET | `/api/jobs/:jobId` | 文書登録ジョブの状態確認 |
| POST | `/api/groups/:group/search` | RAG検索 (embedding検索 + 推論. 同期。`tags`/`categories` で絞り込み可) |
| GET | `/api/groups/:group/backup` | グループのバックアップ (.vgs/.vss + 元データを1つのJSONで) |
| POST | `/api/groups/:group/restore` | グループのレストア (バックアップから復元) |
| GET | `/api/health` | llama.cpp接続先の状態確認 (healthy/useCount/maxConnectCount) |
| GET | `/*` | 上記に一致しないGETは `src/public/` の静的ファイル・jhtml動的画面を配信 |

文書登録はサマリー生成・埋め込みベクトル化で数秒〜数十秒かかるため非同期です。`POST /api/groups/:group/documents` で即時に `jobId` を受け取り、`GET /api/jobs/:jobId` で完了を確認してください。

すべてのllama.cppサーバが同時接続数上限に達している、または不健全な場合は `503` エラーを返します（待機・リトライは行いません）。

**文書登録リクエストボディ**

```jsonc
// テキスト登録.
{ "fileName": "readme.txt", "url": "http://example.com/readme.txt", "text": "本文..." }

// PDF登録 (テキストレイヤー付きPDFのみ抽出可能).
{ "fileName": "manual.pdf", "mimeType": "application/pdf", "fileBase64": "<base64エンコードしたPDF>" }
```

`url` を省略した場合、アップロードした元データ（テキストまたはPDFバイナリ）が保存され、`GET /api/groups/:group/documents/:fileName/raw` から取得できるURLが自動的に文書の参照URLとして使われます（このURLのベースは `glint.json` の `publicBaseUrl`、未設定時はリクエストの `Host` ヘッダーから決定されます）。`url` を指定した場合は元データの保存は行われません。

## 使い方 (ブラウザから)

`apiServer.js` を起動した状態で `http://localhost:3000/` を開くと、機能別に分かれた簡易管理画面が使えます（上部の共通メニューでページ切り替え）。

| ページ | パス | 内容 |
|--------|------|------|
| RAG検索 | `/`（`index.mt.html`） | グループ・タグ指定でのRAG検索 |
| 文書登録 | `/documents.mt.html` | 文書登録（テキスト/PDF） |
| グループ管理 | `/groups.mt.html` | グループ一覧・新規作成・許可タグ一覧編集・文書一覧/タグカテゴリ集計 |

詳細は [docs/setup.md](./docs/setup.md#ブラウザからweb管理画面で使う場合) を参照してください。

## ディレクトリ構成

| パス | 役割 |
|------|------|
| `src/config.js` | `glint.json` で定義された各種設定値の管理 |
| `src/connectMan.js` | llama.cpp接続先の選択・ヘルスチェック・同時接続数管理 |
| `src/conv.js` | 型変換・テンプレート置換などの汎用変換処理 |
| `src/llamaCpp.js` | llama.cpp / OpenAI / OpenAI互換API へのアクセス処理 (model/apiKey対応) |
| `src/localLog.js` | `console.*` の出力をログファイルにも記録する仕組み |
| `src/jhtml.js` | jhtml (JSPライクなテンプレート) を実行可能なJSに変換するテンプレートエンジン |
| `src/pdfExtract.js` | PDF (テキストレイヤー付き) からのテキスト抽出 (`pdf-parse` を使用) |
| `src/prompt.js` | システムプロンプト・ユーザプロンプトの定義 (英語版を実使用、日本語版は参考用) |
| `src/sync.js` | 複数 Node.js プロセス間の同期 (ファイルロック) 処理 |
| `src/util.js` | 汎用ユーティリティ |
| `src/vectorGroup.js` | RAG文書のベクトルDB (自前実装) への登録・検索・集計処理 |
| `src/metaStore.js` | SQLite (node:sqlite/bun:sqlite) によるタグ/カテゴリ集計・FTS5全文検索・検索ログの管理 |
| `src/vectorSummary.js` | 文書サマリー情報の管理 |
| `src/xor128.js` | 乱数生成 |
| `src/apiServer.js` | 文書登録・RAG検索・バックアップ/レストア・Web画面配信を提供する HTTP APIサーバー |
| `src/public/` | ブラウザ用Web管理画面 (index/documents/groups.mt.html + js/common・menu・search・documents・groups.js + css/style.css) |
| `test.js` | 動作確認用のサンプルスクリプト |
| `tests/` | ダミー接続 (モック) を用いた自動テスト |
| `tests/eval/` | 検索精度評価用のデータセット (質問と正解文書のペア) |
| `docs/` | セットアップマニュアル・APIリファレンス等の詳細ドキュメント |
| `scripts/build-bun.sh` | Bunで単一実行バイナリにコンパイルするためのビルドスクリプト |
| `scripts/evalSearch.js` | 検索精度 (Recall@K) を計測する評価用CLIスクリプト |

## テスト

llama.cpp への実接続なしで動作確認できるダミーテストを用意しています。

```sh
node tests/testDummyLlamaCpp.js
```

## 検索精度の評価

質問と正解文書のペア（評価データセット）を用意すれば、Recall@Kで検索精度を計測できます。embeddingモデルの選定や、リランキング・ハイブリッド検索のON/OFFなど、変更の効果を数値で比較する際に使用します。データセットの形式は [tests/eval/example.json](./tests/eval/example.json) を参照してください。

```sh
node scripts/evalSearch.js "グループ名" tests/eval/評価データセット.json
node scripts/evalSearch.js "グループ名" tests/eval/評価データセット.json -k 3,5,10 -o result.json
```

## 制限事項

- 専用のベクトル検索インデックスを持たないため、1グループあたりの登録件数には実用上の上限があります（目安: 約1万件程度）。
- 大規模なコーパスや高いスループットが求められる用途には、専用のベクトルDBの利用を検討してください。
- `apiServer.js` は単一Node.jsプロセスでの利用を想定しています（`connectMan.js` の接続数管理はプロセス内メモリのみで、複数プロセス間では共有されません）。
- PDF登録はテキストレイヤー付きPDFのみ対応です。テキストレイヤーの無いスキャン画像PDFからはテキストを抽出できません（OCR等は未対応）。
