# ✨ Glint

**「きらりと光る、一瞬の輝き」— 目的の箇所を瞬時に見つける、ローカルLLM RAGシステム**

Glint は [llama.cpp](https://github.com/ggml-org/llama.cpp) をバックエンドに利用し、**ローカルLLMのみで動作する高精度なRAG（検索拡張生成）システム**を Node.js で構築するプロジェクトです。外部のクラウドAPIやベクトルDBに依存せず、自前でベクトル検索を実装することで、構成をシンプルに保ちながら実用的な検索精度を実現しています。

---

## 特徴

- **ベクトルDB不要**: 専用のベクトル検索エンジン（Pinecone、Chroma等）を使わず、自前のベクトル検索ロジックで動作。小規模〜中規模データ（1グループあたり最大 約1万件程度）を想定した軽量構成。
- **サマリー併用型RAG**: 文書登録時にローカルLLMで「タグ・カテゴリ・サマリー」を自動生成し、通常のチャンク検索結果と組み合わせて回答生成に利用することで、検索効率と回答精度を向上。
- **完全ローカル動作**: llama.cpp サーバー（OpenAI API互換）にのみ接続。外部クラウドサービスへの通信は発生しない。
- **複数サーバ対応**: 埋め込み用・推論用のサーバーをそれぞれ複数台登録し、負荷分散接続が可能。
- **プロセス間ロック対応**: 複数の Node.js プロセスから同時にベクトルストアを更新しても安全に動作するよう、ファイルロックによる同期処理を実装。
- **プロンプトの英語化による高速化**: LLMへ送る実際のプロンプト（システム/ユーザ）は英語化されており、トークン処理効率を高めて応答速度を向上（内容確認用の日本語版も保持）。

## アーキテクチャ概要

```
┌──────────────┐        ┌───────────────────────┐
│  ドキュメント  │  --->  │ putTextFileToVectorGroup │
│ (テキストファイル)│        └───────────────────────┘
└──────────────┘                    │
                                     │ 1. ローカルLLMでサマリー(タグ/カテゴリ/要約)生成
                                     │ 2. テキストをチャンク分割
                                     │ 3. 各チャンクを埋め込みベクトル化
                                     ▼
                        ┌─────────────────────────┐
                        │ VectorStore (.vgs / .vss) │  ← 自前のベクトル検索用ファイル
                        └─────────────────────────┘
                                     │
                  質問 --->  searchEmbedding → searchInference
                                     │
                                     │ 検索結果チャンク + サマリー を
                                     │ RAGプロンプトに組み込んで推論
                                     ▼
                              回答（参照文書一覧付き）
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
    // 推論モデルサーバー (複数台指定可).
    "inferenceList": [{ "url": "http://192.168.0.235:8080" }],

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

## 使い方

```js
const vg = require("./src/vectorGroup.js");

const GROUP_NAME = "サンプルグループ";

// 1. 文書をVectorGroupに登録 (サマリー生成 + ベクトル化).
await vg.putTextFileToVectorGroup(
    GROUP_NAME,
    "readme.txt",
    "http://example.com/readme.txt", // 参照元URL.
    "登録したいテキスト本文...",
);

// 2. 質問に対してベクトル検索を実施.
const vgObj = await vg.loadVectorGroup(GROUP_NAME);
const searchResult = await vg.searchEmbedding(vgObj, "質問内容");

// 3. 検索結果を元にRAG推論を実行し、回答を取得.
const answer = await vg.searchInference(searchResult, "質問内容");
console.log(answer);
```

より実践的な使用例は `test.js` を参照してください。

## ディレクトリ構成

| パス | 役割 |
|------|------|
| `src/config.js` | `glint.json` で定義された各種設定値の管理 |
| `src/connectMan.js` | 複数プロセス間での llama.cpp 接続先の負荷管理 |
| `src/conv.js` | 型変換・テンプレート置換などの汎用変換処理 |
| `src/llamaCpp.js` | llama.cpp サーバー (OpenAI API互換) へのアクセス処理 |
| `src/prompt.js` | システムプロンプト・ユーザプロンプトの定義 (英語版を実使用) |
| `src/sync.js` | 複数 Node.js プロセス間の同期 (ファイルロック) 処理 |
| `src/util.js` | 汎用ユーティリティ・デバッグ出力 |
| `src/vectorGroup.js` | RAG文書のベクトルDB (自前実装) への登録・検索処理 |
| `src/vectorSummary.js` | 文書サマリー情報の管理 |
| `src/xor128.js` | 乱数生成 |
| `tests/` | ダミー接続 (モック) を用いた自動テスト |

## テスト

llama.cpp への実接続なしで動作確認できるダミーテストを用意しています。

```sh
node tests/testDummyLlamaCpp.js
```

## 制限事項

- 専用のベクトル検索インデックスを持たないため、1グループあたりの登録件数には実用上の上限があります（目安: 約1万件程度）。
- 大規模なコーパスや高いスループットが求められる用途には、専用のベクトルDBの利用を検討してください。
