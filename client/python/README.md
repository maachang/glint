# glint APIクライアント (Python版)

`src/apiServer.js` が提供するHTTP APIに接続して操作するためのクライアントライブラリです（[client/glintClient.js](../glintClient.js) のPython版）。
外部パッケージには依存せず、標準ライブラリ (`urllib`) のみで実装しています。Python 3系で動作します。

エンドポイント仕様の詳細は [../../docs/apiServer.md](../../docs/apiServer.md) を参照してください。

## 使い方

```python
from glint_client import GlintClient

client = GlintClient("http://localhost:3000")

# グループ作成・タグ設定
client.create_group("サンプルグループ")
client.set_allowed_tags("サンプルグループ", ["プログラム", "生活"])

# 文書登録 (完了まで待つ)
client.register_text_document_and_wait("サンプルグループ", "readme.txt", "本文テキスト...")

# RAG検索
result = client.search("サンプルグループ", "質問文")
print(result["message"], result["list"])
```

エラー時は `GlintApiError`（`code`/`message` 属性を持つ）を発生させます。

## メソッド一覧

| メソッド | 対応するAPI |
|---------|-------------|
| `list_groups()` | `GET /api/groups` |
| `create_group(group)` | `POST /api/groups` |
| `list_documents(group, page=None, page_size=None, tag=None, search=None)` | `GET /api/groups/:group/documents` |
| `get_stats(group)` | `GET /api/groups/:group/stats` |
| `get_allowed_tags(group)` | `GET /api/groups/:group/tags` |
| `set_allowed_tags(group, tags)` | `PUT /api/groups/:group/tags` |
| `register_text_document(group, file_name, text, url=None, options=None)` | `POST /api/groups/:group/documents` (テキスト) |
| `register_pdf_document(group, file_name, pdf_bytes, url=None, options=None)` | `POST /api/groups/:group/documents` (PDF) |
| `get_job(job_id)` | `GET /api/jobs/:jobId` |
| `wait_for_job(job_id, interval_sec, timeout_sec)` | `GET /api/jobs/:jobId` を完了までポーリング |
| `register_text_document_and_wait(...)` | 登録 + 完了待ちのショートカット |
| `delete_document(group, file_name)` | `DELETE /api/groups/:group/documents/:fileName` |
| `get_raw_document(group, file_name)` | `GET /api/groups/:group/documents/:fileName/raw` |
| `update_document_tags(group, file_name, tag, category=None)` | `PUT /api/groups/:group/documents/:fileName/tags` |
| `search(group, message, tags=None, categories=None, options=None)` | `POST /api/groups/:group/search` |
| `backup_group(group)` | `GET /api/groups/:group/backup` |
| `restore_group(group, backup_bundle, overwrite=False)` | `POST /api/groups/:group/restore` |
| `health()` | `GET /api/health` |
