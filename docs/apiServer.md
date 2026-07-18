# apiServer.js 詳細リファレンス

`src/apiServer.js` が提供する HTTP API の詳細仕様です。セットアップ手順は [setup.md](./setup.md) を参照してください。

## 起動方法

```sh
node src/apiServer.js
PORT=8080 node src/apiServer.js   # ポート指定 (環境変数. 未指定時は3000)
```

ライブラリとして起動する場合:

```js
const apiServer = require("./src/apiServer.js");
const server = apiServer.start();       // 環境変数 PORT または 3000番ポートで起動
const server2 = apiServer.start(8080);  // ポート明示指定
const server3 = apiServer.start(0);     // OSにランダムなポートを割り当てさせる (テスト用途)
```

`start()` を呼んだ時点で以下が初期化されます。

- `localLog.js` によるローカルログ出力の有効化（`glint.json` の `logDir`/`logFile`/`logLevel` を使用）
- `connectMan.js` による llama.cpp サーバー群への定期ヘルスチェック開始

## 共通仕様

- リクエスト/レスポンスは JSON（`Content-Type: application/json; charset=utf-8`）
- エラーレスポンスは以下の形式で返る

  ```json
  { "error": { "code": 404, "message": "Not found: GET /no-such-path" } }
  ```

- 全てのllama.cppサーバが同時接続数上限（`maxConnectCount`）に達している、または不健全（ヘルスチェック失敗）な場合、`ConnectMan.acquire()` が例外を throw し、そのまま **`503`** として返る（待機・リトライは行わない）
- 各リクエストの完了時にアクセスログ（メソッド・パス・ステータス・処理時間）が `console.info` で出力される（`logLevel` 設定に応じてログファイルにも記録される）

---

## エンドポイント一覧

| メソッド | パス | 概要 |
|---------|------|------|
| GET | `/groups` | グループ一覧 |
| GET | `/groups/:group/documents` | グループ内の文書一覧 |
| GET | `/groups/:group/stats` | グループ内の tag/category 集計 |
| POST | `/groups/:group/documents` | 文書登録（非同期） |
| DELETE | `/groups/:group/documents/:fileName` | 文書削除 |
| GET | `/groups/:group/documents/:fileName/raw` | 元データ（url自動発行時のみ）の取得 |
| GET | `/jobs/:jobId` | 文書登録ジョブの状態確認 |
| POST | `/groups/:group/search` | RAG検索 |
| GET | `/health` | llama.cpp接続先の状態確認 |

---

### GET `/groups`

登録済みのグループ名一覧を返す。

**レスポンス例**
```json
{ "groups": ["サンプルグループ", "another-group"] }
```

---

### GET `/groups/:group/documents`

グループ内に登録されている文書の一覧と件数を返す。各文書の `tag`/`category` は、登録時にサマリーと一緒に保存されたJSONを再パースして返す（パースできない旧形式データは `null`）。

**レスポンス例**
```json
{
  "count": 2,
  "documents": [
    {
      "name": "readme",
      "url": "http://example.com/readme.txt",
      "time": 1732000000000,
      "tag": "プログラム",
      "category": ["ドキュメント"]
    },
    { "name": "doc2", "url": "...", "time": 1732000001000, "tag": null, "category": null }
  ]
}
```

---

### GET `/groups/:group/stats`

グループ内の全文書を走査し、`tag`/`category` の出現件数・比率を集計して返す。`tag` は1文書1値、`category` は1文書で複数値を持てる前提で集計する。

**レスポンス例**
```json
{
  "totalDocuments": 10,
  "unparsedDocuments": 0,
  "tags": [
    { "name": "プログラム", "count": 6, "ratio": 0.6 },
    { "name": "生活", "count": 4, "ratio": 0.4 }
  ],
  "categories": [
    { "name": "テスト", "count": 3, "ratio": 0.3 }
  ]
}
```

---

### POST `/groups/:group/documents`

文書を登録する。サマリー生成・埋め込みベクトル化に数秒〜数十秒かかるため**非同期**。リクエストは即座に `202` + `jobId` を返し、実処理はバックグラウンドで継続される。完了確認は `GET /jobs/:jobId` で行う。

**リクエストボディ（テキスト登録）**

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `fileName` | ○ | ファイル名（拡張子込み。例: `"readme.txt"`） |
| `text` | ○ | 登録する本文テキスト |
| `url` | - | 参照元URL。省略時は自動発行（後述） |
| `options` | - | `putTextFileToVectorGroup()` に渡す追加オプション（`temperature`/`chunkSize`/`overlap`等） |

```json
{ "fileName": "readme.txt", "url": "http://example.com/readme.txt", "text": "本文..." }
```

**リクエストボディ（PDF登録）**

`mimeType` に `"application/pdf"` を指定した場合、`text` の代わりに `fileBase64` が必須になる。

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `fileName` | ○ | ファイル名（例: `"manual.pdf"`） |
| `mimeType` | ○ | `"application/pdf"` を指定 |
| `fileBase64` | ○ | PDFバイナリをbase64エンコードした文字列 |
| `url` | - | 参照元URL。省略時は自動発行 |
| `options` | - | 同上 |

```json
{ "fileName": "manual.pdf", "mimeType": "application/pdf", "fileBase64": "JVBERi0xLjQK..." }
```

> **注意**: PDFはテキストレイヤー付きのものだけ対応（`pdf-parse` でテキスト抽出）。スキャン画像のみのPDF（テキストレイヤー無し）からはテキストを抽出できず、ジョブが `error` になる。

**レスポンス（即時, 202）**
```json
{ "jobId": "b334c20a-107d-4cab-8896-e489886f2283", "status": "pending" }
```

**バリデーションエラー（400）**
- `fileName` が無い
- テキスト登録で `text` が無い
- PDF登録で `fileBase64` が無い

#### url未指定時の自動URL発行

`url` を指定しない場合、以下の処理が行われる。

1. アップロードされた元データ（テキストはUTF-8、PDFはバイナリそのまま）を `conf.srcDocumentPath` 配下の `{groupName}/{fileName}` に保存する（実際に使用した `mimeType` もサイドカーファイル `{fileName}.meta.json` に保存）
2. `GET /groups/:group/documents/:fileName/raw` で読み出せるURLを組み立てて、文書の参照URLとして使用する
   - `glint.json` の `publicBaseUrl` が設定されていればそれをベースにする
   - 未設定の場合はリクエストの `Host` ヘッダーから `http://{Host}` を組み立てる

`url` を明示的に指定した場合、この保存は行われない（外部の実URLをそのまま使う）。

---

### DELETE `/groups/:group/documents/:fileName`

文書を削除する。`fileName` は拡張子込み（例: `note.txt`）。自動URL発行のために保存していた元データ（存在する場合）も合わせて削除される。

**レスポンス例**
```json
{ "removed": true }
```

`removed` は実際に削除対象が見つかったかどうかを示す（既に削除済みの場合は `false` で正常応答）。

---

### GET `/groups/:group/documents/:fileName/raw`

`url` 未指定で登録した文書の元データ（アップロードされたテキスト or PDFバイナリそのもの）を返す。

- `Content-Type` は登録時に実際に使用した `mimeType`（サイドカーのメタ情報）に基づく。メタ情報が無い場合のみファイル名拡張子から `.pdf` かどうかを推測してフォールバックする
- `url` を明示的に指定して登録した文書、または削除済みの文書は元データが無いため **`404`** を返す

---

### GET `/jobs/:jobId`

`POST /groups/:group/documents` が返した `jobId` の状態を確認する。

**レスポンス例（処理中）**
```json
{ "status": "pending", "error": null, "createdAt": 1732000000000, "updatedAt": 1732000000000 }
```

**レスポンス例（成功）**
```json
{ "status": "success", "error": null, "createdAt": 1732000000000, "updatedAt": 1732000000500 }
```

**レスポンス例（失敗）**
```json
{ "status": "error", "error": "Invalid PDF structure", "createdAt": 1732000000000, "updatedAt": 1732000000120 }
```

存在しない `jobId` の場合は **`404`**。ジョブ情報は完了後 **30分**でメモリから自動的に破棄される（`apiServer.js` の `JOB_TTL`）。

---

### POST `/groups/:group/search`

ベクトル検索 + RAG推論を行い、回答を返す（**同期**。完了まで応答をブロックする）。

**リクエストボディ**

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `message` | ○ | 質問文 |
| `tags` | - | 絞り込み対象のtag一覧（配列、いずれか一致でOR） |
| `categories` | - | 絞り込み対象のcategory一覧（配列、いずれか一致でOR） |
| `options` | - | `searchEmbedding()`/`searchInference()` に渡す追加オプション（`tags`/`categories`もここに含めれば同様に動作） |

```json
{ "message": "RAGとは何ですか？", "tags": ["プログラム"] }
```

**レスポンス例**
```json
{ "answer": "【回答】\n...\n\n【参照文書一覧】\n1. [readme](http://example.com/readme.txt)\n" }
```

> **注意**: `tags`/`categories` によるフィルタは、ベクトル検索で既に上位 `vectorSearchLength` 件に絞られた候補に対する**事後フィルタ**。対象の文書がそもそも上位候補に入っていない場合は結果に含まれない。厳密に絞り込みたい場合は `options.length`（検索候補数）を増やして調整する。

`message` が無い場合は **`400`**。

---

### GET `/health`

llama.cpp接続先（埋め込み用・推論用）の状態を返す。

**レスポンス例**
```json
{
  "embeddingList": [
    { "baseUrl": "http://192.168.0.230:8081", "healthy": true, "useCount": 0, "maxConnectCount": 8 }
  ],
  "inferenceList": [
    { "baseUrl": "http://192.168.0.235:8080", "healthy": true, "useCount": 1, "maxConnectCount": 8 },
    { "baseUrl": "http://192.168.0.236:8080", "healthy": false, "useCount": 0, "maxConnectCount": 4 }
  ]
}
```

- `healthy`: 直近のヘルスチェック結果（`healthCheckTiming` 間隔で自動更新）
- `useCount`: 現在処理中のリクエスト数
- `maxConnectCount`: このサーバーへの同時接続数上限

---

## 既知の制約

- **単一プロセス前提**: `connectMan.js` の接続数管理はプロセス内メモリのみ。複数プロセス/クラスタ構成では接続数がプロセス間で共有されない
- **サーキットブレーカー未実装**: `connectMan.js` は定期ヘルスチェックのみで、リクエスト単位の即時エラー検知による切り離しは行わない
- **PDF対応はテキストレイヤーのみ**: スキャン画像PDFのOCRは非対応
- **タグ/カテゴリフィルタは事後フィルタ**: 上記「POST /groups/:group/search」の注意事項を参照
