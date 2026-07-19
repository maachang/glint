# セットアップマニュアル

Glint のセットアップ手順と `glint.json` の全設定項目リファレンスです。

## 1. 必要要件

- Node.js **18 以上**（標準の `fetch` API を使用するため）
- [llama.cpp](https://github.com/ggml-org/llama.cpp) の `--server` モードで起動した、OpenAI API 互換サーバーが最低2台（またはURLは同一で共用も可）
  - **埋め込み用**: `/v1/embeddings` に対応したモデル（例: `embeddinggemma`）
  - **推論用**: `/v1/chat/completions` に対応したチャット補完モデル
  - llama.cpp の代わりに、OpenAI本家やOpenAI互換ルーター（LiteLLM等）を使うことも可能（後述の `model`/`apiKey`/`apiType` 参照）

## 2. インストール

```sh
git clone <このリポジトリ>
cd glint
npm install
```

`npm install` で `pdf-parse`（PDFのテキストレイヤーを抽出するためのライブラリ）がインストールされます。これが本プロジェクト唯一の外部npm依存です。

## 3. llama.cpp サーバーの起動（例）

```sh
# 埋め込み用サーバー
./llama-server -m embeddinggemma.gguf --port 8081 --embedding

# 推論用サーバー
./llama-server -m your-chat-model.gguf --port 8080
```

複数台構成にする場合は、同種のサーバー（埋め込み or 推論）を複数起動し、後述の `glint.json` の `embeddingList` / `inferenceList` に列挙してください。`connectMan.js` が同時接続数・ヘルスチェックに基づいて自動的に振り分けます。

## 4. `glint.json` の作成

プロジェクトルート（`node`実行時のカレントディレクトリ）に `glint.json` を作成します。`//` によるコメント記述に対応しています。

```jsonc
{
    // ─── llama.cpp 接続先 (必須) ───────────────────────────
    "embeddingList": [
        { "url": "http://192.168.0.230:8081" }
    ],
    "inferenceList": [
        { "url": "http://192.168.0.235:8080" },
        // エントリ単位で同時接続数上限を上書きできる.
        { "url": "http://192.168.0.236:8080", "maxConnectCount": 4 },
        // OpenAI本家 / OpenAI互換ルーターを使う場合の例.
        // apiType: "openai" はヘルスチェック (/health) を行わず常にhealthy扱いにする.
        {
            "url": "https://api.openai.com",
            "model": "gpt-4o-mini",
            "apiKey": "sk-xxxxxxxx",
            "apiType": "openai"
        }
    ],

    // ─── 接続管理 ───────────────────────────────────────
    // llama.cppサーバ1台あたりの同時接続数上限のデフォルト値.
    "maxConnectCount": 8,
    // model/apiKey/apiType はエントリ単位で上書き可能な値のグローバル既定値.
    // (単一のOpenAI互換ルーターを使う場合など、全エントリで共通にしたい時に使う)
    "model": null,
    "apiKey": null,
    "apiType": "llamacpp",
    // ヘルスチェック間隔 (ミリ秒). apiServer.js 起動時に開始される.
    "healthCheckTiming": 15000,
    // fetchタイムアウト (ミリ秒). LLM推論は長時間かかることがあるため長めに.
    "fetchTimeout": 300000,

    // ─── ファイルパス ───────────────────────────────────
    // 各種相対パスの基準ディレクトリ.
    "dirPath": "./",
    // ベクトルストア (.vgs/.vss) の格納先.
    "vectorStorePath": "./vectorStore",
    // 文書登録でurl未指定時にアップロード元データを保存する場所.
    "srcDocumentPath": "./documents",

    // ─── チャンク分割 ───────────────────────────────────
    // 1チャンクの最大文字数 (日本語向けデフォルト300).
    "chunkSize": 300,
    // チャンク間のオーバーラップ文字数 (省略時 chunkSize の25%).
    "overlapSize": 75,

    // ─── サマリー生成 (文書登録時) ───────────────────────
    "summaryTemperature": 0.25,
    // true=推論モードON, false=OFF, 省略/null=サーバ側設定に依存.
    "summaryReasoning": null,

    // ─── RAG検索 ────────────────────────────────────────
    "ragTemperature": 0.25,
    // ベクトル検索の最大取得件数.
    "vectorSearchLength": 30,
    // ハイブリッド検索 (文字2-gramキーワードスコアをコサイン類似度に合成). デフォルトON.
    "hybridSearch": true,
    // ハイブリッド検索のキーワードスコアの重み (0〜1).
    "hybridKeywordWeight": 0.3,
    // RAGプロンプトに含めるチャンク数.
    "ragRequestChunkLength": 7,
    "ragRequestChunkFormat": "- {{no}} 参考文書名: {{name}}, ...",
    "ragReasoning": null,
    // 候補文書をLLMで質問との関連度順に並び替える (リランキング). デフォルトON.
    "ragRerank": true,
    // リランキング対象とする候補文書数の上限.
    "rerankCandidateLength": 20,

    // ─── プロセス間ロック ────────────────────────────────
    // sync.js のロック待ちタイムアウト (ミリ秒, -1=無限待ち).
    "lockTimeout": -1,

    // ─── ローカルログ (localLog.js) ───────────────────────
    "logDir": "./log",
    "logFile": "logout",
    // trace / debug / info / warn / error / none.
    "logLevel": "info",

    // ─── apiServer.js ───────────────────────────────────
    // 文書登録でurl未指定時に自動発行する参照URLのベースURL.
    // リバースプロキシ配下など、外部から実際に到達可能なアドレスがHostヘッダーと
    // 異なる場合に指定する (末尾スラッシュ不要). 未設定時はHostヘッダーから自動判定.
    "publicBaseUrl": "https://example.com"
}
```

### 設定項目リファレンス

| キー | デフォルト値 | 説明 |
|------|------------|------|
| `embeddingList` | (必須) | 埋め込みサーバー接続先 (`{url}` 単体 or 配列) |
| `inferenceList` | (必須) | 推論サーバー接続先 (`{url}` 単体 or 配列) |
| `maxConnectCount` | `8` | サーバ1台あたりの同時接続数上限のデフォルト値 (エントリ単位で上書き可) |
| `model` | `null` | リクエストボディに含める `model` 名のグローバル既定値 (エントリ単位で上書き可)。OpenAI/ルーターモードでは実質必須 |
| `apiKey` | `null` | `Authorization: Bearer` に使うAPIキーのグローバル既定値 (エントリ単位で上書き可) |
| `apiType` | `"llamacpp"` | 接続先種別のグローバル既定値。`"llamacpp"` または `"openai"` (エントリ単位で上書き可)。`"openai"` はヘルスチェックを行わず常にhealthy扱い |
| `healthCheckTiming` | `15000` | ヘルスチェック間隔 (ミリ秒)。`apiType: "llamacpp"` の接続先のみ対象 |
| `fetchTimeout` | `300000` | HTTPリクエストのタイムアウト (ミリ秒) |
| `dirPath` | `"./"` | 各種相対パスの基準ディレクトリ |
| `vectorStorePath` | `"./vectorStore"` | `.vgs`/`.vss` の格納先 |
| `srcDocumentPath` | `"./docs"` | url未指定時の元データ格納先 |
| `chunkSize` | `300` | 1チャンクの最大文字数 |
| `overlapSize` | `chunkSize × 0.25` | チャンク間オーバーラップ文字数 |
| `summaryTemperature` | `0.25` | サマリー生成のTemperature |
| `summaryReasoning` | `null` | サマリー生成時の推論モード on/off/未指定 |
| `ragTemperature` | `0.25` | RAG推論のTemperature |
| `vectorSearchLength` | `30` | ベクトル検索の最大取得件数 |
| `hybridSearch` | `true` | 文字2-gramキーワードスコアをコサイン類似度に合成するハイブリッド検索のON/OFF |
| `hybridKeywordWeight` | `0.3` | ハイブリッド検索のキーワードスコアの重み (0〜1) |
| `ragRequestChunkLength` | `7` | RAGプロンプトに含めるチャンク数 |
| `ragRequestChunkFormat` | (既定テンプレート) | 1チャンク分のプロンプト整形フォーマット |
| `ragReasoning` | `null` | RAG推論時の推論モード on/off/未指定 |
| `ragRerank` | `true` | 候補文書をLLMで質問との関連度順に並び替える(リランキング)かどうか |
| `rerankCandidateLength` | `20` | リランキング対象とする候補文書数の上限 |
| `lockTimeout` | `-1` | ロック待ちタイムアウト (-1=無限待ち) |
| `logDir` | `"./log"` | ローカルログの出力先ディレクトリ |
| `logFile` | `"logout"` | ローカルログのファイル名 (拡張子抜き) |
| `logLevel` | `"info"` | ログ出力レベル (`trace`/`debug`/`info`/`warn`/`error`/`none`) |
| `publicBaseUrl` | `null` | url自動発行時のベースURL (未設定時はHostヘッダーから判定) |

## 5. 動作確認 (llama.cppサーバー無しで)

実際のllama.cppサーバーを立てずに、コードの動作確認だけ行いたい場合はダミーテストを実行します。

```sh
node tests/testDummyLlamaCpp.js
```

## 6. 起動

### ライブラリとして使う場合

```js
const vg = require("./src/vectorGroup.js");
// glint.json はプロセス起動時に自動的にロードされる (Config.getInstance() 初回呼び出し時).
```

より実践的な使用例は `test.js` を参照してください。

### HTTP APIサーバーとして使う場合

```sh
node src/apiServer.js
# ポートを変える場合
PORT=8080 node src/apiServer.js
```

詳細なAPI仕様は [apiServer.md](./apiServer.md) を参照してください。

### ブラウザからWeb管理画面で使う場合

`apiServer.js` を起動した状態でブラウザから `http://localhost:3000/` を開くと、機能別に分かれた簡易管理画面が表示されます（`src/public/` 配下、`.mt.html`はサーバサイドで動的レンダリングされる）。画面は内部で本APIを `fetch()` している以外の特別な仕組みは無いため、同様のUIを自作する際のサンプルとしても参照できます。

- `/`（`index.mt.html`）: RAG検索（グループ選択・タグ絞り込み・質問入力）
- `/documents.mt.html`: 文書登録（テキスト/PDF）
- `/groups.mt.html`: グループ一覧・新規作成・許可タグ一覧編集・文書一覧/タグカテゴリ集計

各ページ上部の共通メニュー（`js/menu.js`）で切り替えられます。

### Bunで単一バイナリにコンパイルする場合

[Bun](https://bun.sh/) を使うと、`apiServer.js` を単一実行バイナリにコンパイルできます（`pdf-parse` は外部npm依存として同梱されます）。

```sh
./scripts/build-bun.sh                # ./dist/glint (+ ./dist/public) に出力
./scripts/build-bun.sh ./dist/myapp   # 出力先を指定
```

**なぜ専用スクリプトが必要か**: `pdf-parse` は内部で `` require(`./pdf.js/${options.version}/build/pdf.js`) `` という動的requireを使っており、Bunの `bun build --compile` は静的解析でバンドル対象を決めるため、これをそのままではバイナリに埋め込めません（コンパイルは成功するが、実行時にPDF登録で `Cannot find module` エラーになる）。`scripts/build-bun.sh` はビルド直前にこの動的requireを固定バージョンの静的requireへ一時的にパッチし、コンパイル完了後に `node_modules` を元の状態へ復元します。またビルド後、`src/public/`（Web管理画面）を出力先と同じディレクトリの `public/` に自動コピーします。

- 前提: `npm install` 済み、かつ `bun` コマンドがインストールされていること
- `pdf-parse` のバージョンを更新した場合、スクリプト内の `PDF_JS_VERSION` を `node_modules/pdf-parse/lib/pdf-parse.js` の `DEFAULT_OPTIONS.version` と合わせて更新する必要がある
- 生成されたバイナリは `glint.json` 等の設定ファイル・`vectorStore`・ログ出力先・`public/` を実行時にファイルシステムから読み書きするため、コンパイル後は**バイナリと同じディレクトリに `public/` を配置した状態で配布・実行する**（`scripts/build-bun.sh` が自動でコピーする）
- Bunコンパイル済みバイナリでは `__dirname` がコンパイル時の開発機の絶対パスに固定されるため、`apiServer.js` は `public/` の位置を `process.execPath`（実行中バイナリ自身の実際の場所）基準で解決するようにしている。同様に `$loadLib`（jhtmlテンプレート内のモジュールローダー）も、相対パスでの動的requireがBunコンパイル済みバイナリで解決に失敗するため、必ず絶対パスに変換してから `require()` している

## 7. トラブルシューティング

| 症状 | 確認事項 |
|------|---------|
| `inferenceList is empty. Call loadConfig() first.` | `glint.json` が読み込めていない。カレントディレクトリと `glint.json` の配置場所を確認 |
| `No available llamaCpp server (all servers are unhealthy or at max connections).` | 全llama.cppサーバが `maxConnectCount` 上限、または `/health` に応答していない。`GET /health` で状態を確認 |
| PDF登録でエラーになる | テキストレイヤーの無いスキャン画像PDFは非対応（[apiServer.md](./apiServer.md) 参照） |
| ログファイルが出力されない | `apiServer.js` を `start()` 経由で実際に起動した場合のみ有効（ライブラリとして `vectorGroup.js` を使うだけでは有効化されない） |
