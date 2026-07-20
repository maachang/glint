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

## 接続先について (llama.cpp / OpenAI / OpenAI互換ルーター)

`embeddingList`/`inferenceList` の各接続先には `model`/`apiKey`/`apiType` を設定できる（`glint.json`のグローバル既定、またはエントリ単位の上書き）。`apiKey`指定時はリクエストに `Authorization: Bearer` ヘッダーが付き、`model`指定時はリクエストボディに `model` が含まれる。`apiType: "openai"` の接続先はヘルスチェック用の `/api/health` エンドポイントを持たない前提で、ヘルスチェックを行わず常に healthy 扱いになる。設定例は [setup.md](./setup.md) を参照。

## 共通仕様

- リクエスト/レスポンスは JSON（`Content-Type: application/json; charset=utf-8`）
- エラーレスポンスは以下の形式で返る

  ```json
  { "error": { "code": 404, "message": "Not found: GET /api/no-such-path" } }
  ```

- 全てのllama.cppサーバが同時接続数上限（`maxConnectCount`）に達している、または不健全（ヘルスチェック失敗）な場合、`ConnectMan.acquire()` が例外を throw し、そのまま **`503`** として返る（待機・リトライは行わない）
- 各リクエストの完了時にアクセスログ（メソッド・パス・ステータス・処理時間）が `console.info` で出力される（`logLevel` 設定に応じてログファイルにも記録される）

---

## エンドポイント一覧

| メソッド | パス | 概要 |
|---------|------|------|
| GET | `/api/groups` | グループ一覧 |
| POST | `/api/groups` | 空のグループ(文書0件)を新規作成 |
| GET | `/api/groups/:group/documents` | グループ内の文書一覧 |
| GET | `/api/groups/:group/stats` | グループ内の tag/category 集計 |
| GET | `/api/groups/:group/tags` | グループ単位の許可タグ一覧取得 |
| PUT | `/api/groups/:group/tags` | グループ単位の許可タグ一覧設定 |
| POST | `/api/groups/:group/documents` | 文書登録（非同期） |
| DELETE | `/api/groups/:group/documents/:fileName` | 文書削除 |
| GET | `/api/groups/:group/documents/:fileName/raw` | 元データ（url自動発行時のみ）の取得 |
| PUT | `/api/groups/:group/documents/:fileName/tags` | 登録済み文書のtag/category修正 |
| GET | `/api/jobs/:jobId` | 文書登録ジョブの状態確認 |
| POST | `/api/groups/:group/search` | RAG検索 |
| GET | `/api/groups/:group/backup` | グループのバックアップ (.vgs/.vss + 元データ) |
| POST | `/api/groups/:group/restore` | グループのレストア (バックアップから復元) |
| GET | `/api/health` | llama.cpp接続先の状態確認 |
| GET | `/*` | 上記に一致しないGETは `src/public/` 配下を静的配信 (`.mt.html`はjhtmlで動的レンダリング) |

---

### GET `/api/groups`

登録済みのグループ名一覧を返す。

**レスポンス例**
```json
{ "groups": ["サンプルグループ", "another-group"] }
```

---

### POST `/api/groups`

空のグループ(文書0件)を新規作成する。通常はグループは文書登録時(`POST /api/groups/:group/documents`)に暗黙的に作成されるが、文書登録前にグループ単位の設定(許可タグ一覧等)を行いたい場合に、先にグループだけを作成できる。

**リクエストボディ**
```json
{ "group": "サンプルグループ" }
```

**レスポンス例**
```json
{ "group": "サンプルグループ" }
```

`group`が無い場合は**`400`**。既に同名グループが存在する場合は**`409`**。

---

### GET `/api/groups/:group/documents`

グループ内に登録されている文書の一覧と件数を返す。各文書の `tag`/`category` は `metaStore.js`（SQLite, `documents`テーブル）で管理する値を返す。登録時のサマリーJSONから初期値が設定され、`PUT /api/groups/:group/documents/:fileName/tags` で修正した場合はその内容が反映される（パースできない旧形式データは `null`）。

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

### GET `/api/groups/:group/stats`

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

### GET `/api/groups/:group/tags`

グループ単位で許可されているタグ一覧を取得する。空配列の場合は制限なし（文書登録時にLLMが自由にタグを生成する、デフォルトの挙動）。

**レスポンス例**
```json
{ "tags": ["法律", "プログラム"] }
```

---

### PUT `/api/groups/:group/tags`

グループ単位で許可するタグ一覧を設定する。設定後、文書登録時のタグ生成プロンプトはこの一覧の中からのみ選択するようLLMに指示され、該当するものが無い場合は自動的に「その他」が採用される。空配列を設定すると制限なし（自由生成）に戻る。

**リクエストボディ**
```json
{ "tags": ["法律", "プログラム", "生活"] }
```

**レスポンス例**
```json
{ "group": "サンプルグループ", "tags": ["法律", "プログラム", "生活"] }
```

`tags` が配列でない場合は **`400`**。既存グループが存在しない場合は **`404`**。許可タグ一覧の実体は`metaStore.js`（SQLite）で管理している（`.vgs`/`.vss`自体は読み書きしない）。

---

### POST `/api/groups/:group/documents`

文書を登録する。サマリー生成・埋め込みベクトル化に数秒〜数十秒かかるため**非同期**。リクエストは即座に `202` + `jobId` を返し、実処理はバックグラウンドで継続される。完了確認は `GET /api/jobs/:jobId` で行う。

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
2. `GET /api/groups/:group/documents/:fileName/raw` で読み出せるURLを組み立てて、文書の参照URLとして使用する
   - `glint.json` の `publicBaseUrl` が設定されていればそれをベースにする
   - 未設定の場合はリクエストの `Host` ヘッダーから `http://{Host}` を組み立てる

`url` を明示的に指定した場合、この保存は行われない（外部の実URLをそのまま使う）。

---

### DELETE `/api/groups/:group/documents/:fileName`

文書を削除する。`fileName` は拡張子込み（例: `note.txt`）。自動URL発行のために保存していた元データ（存在する場合）も合わせて削除される。

**レスポンス例**
```json
{ "removed": true }
```

`removed` は実際に削除対象が見つかったかどうかを示す（既に削除済みの場合は `false` で正常応答）。

---

### GET `/api/groups/:group/documents/:fileName/raw`

`url` 未指定で登録した文書の元データ（アップロードされたテキスト or PDFバイナリそのもの）を返す。

- `Content-Type` は登録時に実際に使用した `mimeType`（サイドカーのメタ情報）に基づく。メタ情報が無い場合のみファイル名拡張子から `.pdf` かどうかを推測してフォールバックする
- `url` を明示的に指定して登録した文書、または削除済みの文書は元データが無いため **`404`** を返す

---

### PUT `/api/groups/:group/documents/:fileName/tags`

登録済み文書の `tag`/`category` を修正する（`metaStore.js` の `documents` テーブルのみ更新。登録時に生成された要約本文・埋め込みチャンクは一切変更しない）。

**リクエストボディ**
```json
{ "tag": "生活", "category": ["日常"] }
```

- `tag`: 文字列または `null`（タグ無しにする場合）
- `category`: 文字列配列（省略時は空配列扱い）。常に自由入力（許可タグ一覧による制限は無い）
- グループに許可タグ一覧（`PUT /api/groups/:group/tags`）が設定されている場合、`tag` はその一覧内の値または `"その他"` でなければならない。それ以外を指定した場合は **`400`**
- グループ・文書が存在しない場合は **`404`**

**レスポンス例**
```json
{ "name": "readme", "tag": "生活", "category": ["日常"] }
```

---

### GET `/api/jobs/:jobId`

`POST /api/groups/:group/documents` が返した `jobId` の状態を確認する。

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

### POST `/api/groups/:group/search`

ベクトル検索 + RAG推論を行い、回答を返す（**同期**。完了まで応答をブロックする）。

**リクエストボディ**

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `message` | ○ | 質問文 |
| `tags` | - | 絞り込み対象のtag一覧（配列、いずれか一致でOR） |
| `categories` | - | 絞り込み対象のcategory一覧（配列、いずれか一致でOR） |
| `options` | - | `searchEmbedding()`/`searchInference()` に渡す追加オプション（`tags`/`categories`もここに含めれば同様に動作） |

`options` には以下も指定可能（いずれも省略時は `glint.json` の設定値を使用）。

| `options`内フィールド | 説明 |
|-----------------------|------|
| `hybridSearch` | ベクトル類似度に文字2-gramキーワードスコアを合成するハイブリッド検索のON/OFF |
| `hybridKeywordWeight` | ハイブリッド検索のキーワードスコアの重み (0〜1) |
| `ragRerank` | 候補文書をLLMで質問との関連度順に並び替える(リランキング)かどうか |
| `rerankCandidateLength` | リランキング対象とする候補文書数の上限 |

```json
{ "message": "RAGとは何ですか？", "tags": ["プログラム"] }
```

**レスポンス例**
```json
{
  "message": "回答本文（Markdown可）",
  "list": [
    { "name": "readme", "url": "http://example.com/readme.txt" }
  ]
}
```

`message` は回答本文（Markdown記法可）、`list` は回答内で実際に引用された参考文書（`name`/`url`）の配列。参照文書のリンク表示（Markdownの `[name](url)` 形式への組み立てなど）はAPI側では行わず、クライアント側（`public/js/search.js`）の責務とする（文書名/URLに括弧等の記号が含まれる場合でも、クライアント側で正確に組み立てることでMarkdownリンク記法の崩れを避けられる）。

> **補足**: `tags`/`categories` によるフィルタは、ベクトル検索のスコアリングを行う**前**に対象チャンクそのものを絞り込む事前フィルタ。対象タグ/カテゴリを持つ文書がベクトル検索の上位候補に入っていない場合でも取り逃さない。

`message` が無い場合は **`400`**。

---

### GET `/api/groups/:group/backup`

グループの `.vgs`/`.vss`（ベクトルストア）、`srcDocumentPath`配下の元データ、`glint.json`の現在の設定スナップショットを1つのJSONにまとめて返す（tar/zip等の外部依存は使わず、バイナリはbase64化してJSONに埋め込む）。`Content-Disposition: attachment` 付きでダウンロード可能。

**レスポンス構造（概要）**
```json
{
  "group": "サンプルグループ",
  "createdAt": 1732000000000,
  "glintConfigSnapshot": { "...": "現在のglint.json相当の設定値 (apiKeyは\"***\"にマスク)" },
  "vectorStore": { "vgs": "<base64>", "vss": "<base64>" },
  "srcDocuments": [
    { "fileName": "doc1.txt", "mimeType": "text/plain; charset=utf-8", "content": "<base64>" }
  ]
}
```

`glintConfigSnapshot` は参照用であり、`POST /api/groups/:group/restore` で復元してもグローバル設定 (`glint.json`) には反映されない。存在しないグループを指定した場合は **`404`**。

---

### POST `/api/groups/:group/restore`

`GET /api/groups/:group/backup` が返したバンドルをそのまま渡して、グループを復元する。

**リクエストボディ**

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `vectorStore` | ○ | `{ vgs, vss }`（base64。バックアップの値をそのまま渡す） |
| `srcDocuments` | - | `[{ fileName, mimeType, content }]`（base64。省略時は元データを復元しない） |
| `overwrite` | - | `true` の場合、既存グループを上書きする |

**レスポンス例**
```json
{ "restored": true, "group": "サンプルグループ", "documentsRestored": 2 }
```

- レストア先に既にグループが存在し、`overwrite: true` が指定されていない場合は **`409`**
- 別のグループ名に復元した場合、文書一覧の `url`（自動発行されたもの）はバックアップ時点の元グループ名を指したまま残る点に注意（`.vss`のバイト列をそのまま復元するため）
- `vectorStore` が無い場合は **`400`**

---

### GET `/*`（Web管理画面 / 静的ファイル配信）

`/api` で始まらないGETリクエストは、`src/public/` 配下のファイルを配信するフォールバックとして扱われる（`/api` 配下で該当ルートが無い場合は静的配信にはフォールバックせず `404` を返す）。

- `/` は `src/public/index.mt.html` にマッピングされる
- `.mt.html` ファイルは `src/jhtml.js`（JSPライクなテンプレートエンジン）でサーバサイドレンダリングされる。テンプレート内では以下が使える
  - `$request` / `$response`: Node標準の `http.IncomingMessage`/`http.ServerResponse`
  - `$out(string)`: 出力用の組み込み関数
  - `$loadLib(name)`: `src/` 配下のモジュールを名前（相対パス）で動的にロードする関数（例: `$loadLib("vectorGroup.js")`）。内部で絶対パスに変換してから `require()` するため、Bunコンパイル済みバイナリでも正しく動作する
- 変換結果は mtime ベースでメモリキャッシュされる（ファイル変更時は自動的に再変換）
- それ以外の拡張子（`.css`/`.js`/`.png`等）はそのまま静的配信される
- `src/public/` の外側を指すパス（パストラバーサル）は **`403`**、存在しないファイルは **`404`**

`src/public/` 配下が、ブラウザから本APIを利用できる簡易管理画面になっている。機能別に3ページに分かれ、各ページ上部の共通メニュー（`js/menu.js`）で切り替える。

| ページ | ファイル | 内容 |
|--------|---------|------|
| RAG検索 | `index.mt.html` + `js/search.js` | グループ・タグ指定でのRAG検索 |
| 文書登録 | `documents.mt.html` + `js/documents.js` | 文書登録（テキスト/PDF） |
| グループ管理 | `groups.mt.html` + `js/groups.js` | グループ一覧・新規作成・許可タグ一覧編集・文書一覧/タグカテゴリ集計 |

`js/common.js`（API呼び出し共通処理）は全ページで共通利用する。

---

### GET `/api/health`

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
- **tag/category修正は集計・事前フィルタ用データのみ反映**: `PUT /api/groups/:group/documents/:fileName/tags` は`documents`テーブルのみを更新する。登録時に生成済みの要約本文・埋め込みチャンク（RAG回答生成時にLLMへ渡される内容）は再生成されないため、修正内容はタグ/カテゴリ集計・事前フィルタには反映されるが、RAG回答の文面には反映されない
