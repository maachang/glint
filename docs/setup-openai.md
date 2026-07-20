# OpenAI接続向けセットアップガイド

ローカルにllama.cppサーバーを用意せず、OpenAI本家のAPIキーだけで個人利用したい場合のセットアップ手順です。基本的なセットアップ・全設定項目リファレンスは [setup.md](./setup.md) を参照してください。本ドキュメントはOpenAI接続時に固有の内容のみ扱います。

## 1. 必要なもの

- Node.js **22.5 以上**（[setup.md](./setup.md#1-必要要件) と同じ）
- OpenAI APIキー（https://platform.openai.com/ で発行）

llama.cppサーバーの用意は不要です。

## 2. `glint.json` の作成

`example/glint.openai.json` をコピーしてプロジェクトルートに `glint.json` として配置し、`apiKey` を実際のキーに書き換えます。

```sh
cp example/glint.openai.json glint.json
```

```jsonc
{
    "embeddingList": [
        {
            "url": "https://api.openai.com",
            "model": "text-embedding-3-small",
            "apiKey": "sk-xxxxxxxx",
            "apiType": "openai"
        }
    ],
    "inferenceList": [
        {
            "url": "https://api.openai.com",
            "model": "gpt-4o-mini",
            "apiKey": "sk-xxxxxxxx",
            "apiType": "openai"
        }
    ],
    "maxConnectCount": 8,
    "fetchTimeout": 300000,
    "dirPath": "./test",
    "vectorStorePath": "./vectorStore",
    "srcDocumentPath": "./documents",
    "chunkSize": 300,
    "summaryTemperature": 0,
    "summaryReasoning": false,
    "ragTemperature": 0,
    "ragReasoning": false,
    "vectorSearchLength": 18,
    "ragRequestChunkLength": 6
}
```

- `model` は埋め込み用・推論用それぞれ好みのモデル名に置き換えてください（上記は一例で、どのモデルを使うべきかの推奨はしていません）。
- `apiType: "openai"` を指定すると `Authorization: Bearer <apiKey>` ヘッダーが付与され、リクエストボディに `model` が含まれます。
- OpenAI互換ルーター（LiteLLM等）を使う場合も同様に `apiType: "openai"` を指定し、`url` をルーターのエンドポイントに変更してください。

## 3. ローカルllama.cpp運用との違い

- **ヘルスチェックが行われない**: `apiType: "openai"` の接続先は `/health` エンドポイント（llama.cpp独自）を持たない前提のため、`connectMan.js` はヘルスチェックを行わず常にhealthy扱いにします。`healthCheckTiming` の設定はOpenAI接続先には影響しません。
- **複数サーバ分散が基本不要**: ローカル運用では複数台のllama.cppサーバーに負荷分散する構成が一般的ですが、OpenAI利用時は `embeddingList`/`inferenceList` にそれぞれ1エントリだけで十分です。同時実行数の制御は `maxConnectCount` で行い、OpenAI側のレート制限（Rate Limit）を超えないよう調整してください。
- **API課金が発生する**: 文書登録（サマリー生成・埋め込みベクトル化）およびRAG検索のたびにOpenAI APIが呼び出され、課金対象になります。大量の文書を一括登録する場合や、`scripts/evalSearch.js` で繰り返し評価を行う場合は、事前にコストを見積もることを推奨します。

## 4. 動作確認

```sh
node src/apiServer.js
```

起動後、`http://localhost:3000/` からWeb管理画面で文書登録・RAG検索を試すか、`example/test2.js`（`client/glintClient.js` 経由でHTTP APIを呼ぶサンプル）をコピーして実行してください。

## 5. トラブルシューティング

| 症状 | 確認事項 |
|------|---------|
| `401 Unauthorized` 等の認証エラー | `apiKey` が正しいか、OpenAI側でAPIキーが有効か確認 |
| レート制限エラーが頻発する | `maxConnectCount` を下げてOpenAI側のレート制限に収まるよう調整 |
| 応答が異常に遅い/タイムアウトする | `fetchTimeout` を延長する。モデル自体の応答速度に依存するため、より高速なモデルへの変更も検討 |
