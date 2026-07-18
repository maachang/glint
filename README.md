# ✨ Glint

**「きらりと光る、一瞬の輝き」— 目的の箇所を瞬時に見つける、ローカルLLM RAGシステム**

Glint は [llama.cpp](https://github.com/ggml-org/llama.cpp) をバックエンドに利用し、**ローカルLLMのみで動作する高精度なRAG（検索拡張生成）システム**を Node.js で構築するプロジェクトです。外部のクラウドAPIやベクトルDBに依存せず、自前でベクトル検索を実装することで、構成をシンプルに保ちながら実用的な検索精度を実現しています。

---

## 特徴

- **ベクトルDB不要**: 専用のベクトル検索エンジン（Pinecone、Chroma等）を使わず、自前のベクトル検索ロジックで動作。小規模〜中規模データ（1グループあたり最大 約1万件程度）を想定した軽量構成。
- **サマリー併用型RAG**: 文書登録時にローカルLLMで「タグ・カテゴリ・サマリー」を自動生成し、通常のチャンク検索結果と組み合わせて回答生成に利用することで、検索効率と回答精度を向上。
- **タグ/カテゴリによる絞り込み検索**: RAG検索結果をタグ・カテゴリで事後フィルタリングできる。グループ内のタグ/カテゴリ集計（件数・比率）も取得可能。
- **完全ローカル動作**: llama.cpp サーバー（OpenAI API互換）にのみ接続。外部クラウドサービスへの通信は発生しない。
- **複数サーバ対応 + 接続管理**: 埋め込み用・推論用のサーバーをそれぞれ複数台登録し、`connectMan.js` が同時接続数上限・定期ヘルスチェックに基づいて負荷分散する。
- **プロセス間ロック対応**: 複数の Node.js プロセスから同時にベクトルストアを更新しても安全に動作するよう、ファイルロックによる同期処理を実装。
- **プロンプトの英語化による高速化**: LLMへ送る実際のプロンプト（システム/ユーザ）は英語化されており、トークン処理効率を高めて応答速度を向上（内容確認用の日本語版も保持）。
- **HTTP APIサーバー**: 文書登録・RAG検索・グループ管理を外部から利用できる HTTP API を Node.js 標準の `http` モジュールのみで提供（外部依存なし）。

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
                        ┌─────────────────────────┐
                        │ VectorStore (.vgs / .vss) │  ← 自前のベクトル検索用ファイル
                        └─────────────────────────┘
                                     │
                  質問 --->  searchEmbedding → (tag/category絞り込み) → searchInference
                                     │
                                     │ 検索結果チャンク + サマリー を
                                     │ RAGプロンプトに組み込んで推論
                                     ▼
                              回答（参照文書一覧付き）

  ※ 埋め込み・推論の接続先は connectMan.js が health / 同時接続数を見て選択する.
```

## 必要要件

- Node.js **18 以上**（標準の `fetch` API を使用）
- [llama.cpp](https://github.com/ggml-org/llama.cpp) の `--server` モードで起動した OpenAI API 互換サーバー
  - 埋め込み用モデル（例: `embeddinggemma`）
  - 推論用モデル（チャット補完対応モデル）

## セットアップ

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
    "ragRequestChunkLength": 6
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

// 2. 質問に対してベクトル検索を実施 (tags/categories で事後フィルタも可能).
const vgObj = await vg.loadVectorGroup(GROUP_NAME);
const searchResult = await vg.searchEmbedding(vgObj, "質問内容", {
    tags: ["プログラム"], // 省略可.
});

// 3. 検索結果を元にRAG推論を実行し、回答を取得.
const answer = await vg.searchInference(searchResult, "質問内容");
console.log(answer);

// グループ内のタグ/カテゴリ集計 (件数・比率) を取得.
const stats = await vg.getGroupStats(GROUP_NAME);
console.log(stats);
```

より実践的な使用例は `test.js` を参照してください。

## 使い方 (HTTP APIサーバーとして)

```sh
node src/apiServer.js
# または
PORT=3000 node src/apiServer.js
```

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/groups` | グループ一覧 |
| GET | `/groups/:group/documents` | グループ内の文書一覧・文書数 (tag/category含む) |
| GET | `/groups/:group/stats` | グループ内の tag/category 集計 (件数・比率) |
| POST | `/groups/:group/documents` | 文書登録 (非同期. 即時に `jobId` を返す) |
| DELETE | `/groups/:group/documents/:fileName` | 文書削除 |
| GET | `/jobs/:jobId` | 文書登録ジョブの状態確認 |
| POST | `/groups/:group/search` | RAG検索 (embedding検索 + 推論. 同期。`tags`/`categories` で絞り込み可) |
| GET | `/health` | llama.cpp接続先の状態確認 (healthy/useCount/maxConnectCount) |

文書登録はサマリー生成・埋め込みベクトル化で数秒〜数十秒かかるため非同期です。`POST /groups/:group/documents` で即時に `jobId` を受け取り、`GET /jobs/:jobId` で完了を確認してください。

すべてのllama.cppサーバが同時接続数上限に達している、または不健全な場合は `503` エラーを返します（待機・リトライは行いません）。

## ディレクトリ構成

| パス | 役割 |
|------|------|
| `src/config.js` | `glint.json` で定義された各種設定値の管理 |
| `src/connectMan.js` | llama.cpp接続先の選択・ヘルスチェック・同時接続数管理 |
| `src/conv.js` | 型変換・テンプレート置換などの汎用変換処理 |
| `src/llamaCpp.js` | llama.cpp サーバー (OpenAI API互換) へのアクセス処理 |
| `src/prompt.js` | システムプロンプト・ユーザプロンプトの定義 (英語版を実使用、日本語版は参考用) |
| `src/sync.js` | 複数 Node.js プロセス間の同期 (ファイルロック) 処理 |
| `src/util.js` | 汎用ユーティリティ・デバッグ出力 |
| `src/vectorGroup.js` | RAG文書のベクトルDB (自前実装) への登録・検索・集計処理 |
| `src/vectorSummary.js` | 文書サマリー情報の管理 |
| `src/xor128.js` | 乱数生成 |
| `src/apiServer.js` | 文書登録・RAG検索を提供する HTTP APIサーバー (Node標準httpのみ) |
| `test.js` | 動作確認用のサンプルスクリプト |
| `tests/` | ダミー接続 (モック) を用いた自動テスト |

## テスト

llama.cpp への実接続なしで動作確認できるダミーテストを用意しています。

```sh
node tests/testDummyLlamaCpp.js
```

## 制限事項

- 専用のベクトル検索インデックスを持たないため、1グループあたりの登録件数には実用上の上限があります（目安: 約1万件程度）。
- 大規模なコーパスや高いスループットが求められる用途には、専用のベクトルDBの利用を検討してください。
- `apiServer.js` は単一Node.jsプロセスでの利用を想定しています（`connectMan.js` の接続数管理はプロセス内メモリのみで、複数プロセス間では共有されません）。
- タグ/カテゴリによる検索フィルタは、ベクトル検索で既に絞られた上位候補に対する事後フィルタです。フィルタ対象の文書が上位候補に入っていない場合は検索結果に含まれません。
