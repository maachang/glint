# glint APIクライアント (JavaScript版)

`src/apiServer.js` が提供するHTTP APIに接続して操作するためのクライアントライブラリです。
`src/`配下のモジュールは直接requireせず、あくまでHTTP経由でAPIを呼ぶだけの薄いラッパーです。

Python版は [python/README.md](./python/README.md) を参照してください。

エンドポイント仕様の詳細は [../docs/apiServer.md](../docs/apiServer.md) を参照してください。

## 使い方

```js
const GlintClient = require("./client/glintClient.js");

const client = new GlintClient("http://localhost:3000");

// グループ作成・タグ設定
await client.createGroup("サンプルグループ");
await client.setAllowedTags("サンプルグループ", ["プログラム", "生活"]);

// 文書登録 (完了まで待つ)
await client.registerTextDocumentAndWait("サンプルグループ", "readme.txt", "本文テキスト...");

// RAG検索
const result = await client.search("サンプルグループ", "質問文");
console.log(result.message, result.list);
```

## メソッド一覧

| メソッド | 対応するAPI |
|---------|-------------|
| `listGroups()` | `GET /api/groups` |
| `createGroup(group)` | `POST /api/groups` |
| `listDocuments(group, opts)` | `GET /api/groups/:group/documents`（`opts`に`page`/`pageSize`/`tag`/`search`を指定可） |
| `getStats(group)` | `GET /api/groups/:group/stats` |
| `getAllowedTags(group)` | `GET /api/groups/:group/tags` |
| `setAllowedTags(group, tags)` | `PUT /api/groups/:group/tags` |
| `registerTextDocument(group, fileName, text, opts)` | `POST /api/groups/:group/documents` (テキスト) |
| `registerPdfDocument(group, fileName, pdfBuffer, opts)` | `POST /api/groups/:group/documents` (PDF) |
| `getJob(jobId)` | `GET /api/jobs/:jobId` |
| `waitForJob(jobId, opts)` | `GET /api/jobs/:jobId` を完了までポーリング |
| `registerTextDocumentAndWait(group, fileName, text, opts)` | 登録 + 完了待ちのショートカット |
| `deleteDocument(group, fileName)` | `DELETE /api/groups/:group/documents/:fileName` |
| `getRawDocument(group, fileName)` | `GET /api/groups/:group/documents/:fileName/raw` |
| `updateDocumentTags(group, fileName, tag, category)` | `PUT /api/groups/:group/documents/:fileName/tags` |
| `search(group, message, opts)` | `POST /api/groups/:group/search` |
| `backupGroup(group)` | `GET /api/groups/:group/backup` |
| `restoreGroup(group, backupBundle, overwrite)` | `POST /api/groups/:group/restore` |
| `health()` | `GET /api/health` |

エラー時はレスポンスの `error.message` を持つ `Error` を throw します（`.code` にHTTPステータスコードが入ります）。
