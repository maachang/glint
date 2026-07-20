# glint_client.py
# glint の apiServer.js (HTTP API) に接続して操作するためのクライアントライブラリ (Python版).
#
# AIメモ:
# - 外部依存パッケージを増やさないため、標準ライブラリ (urllib) のみで実装する.
# - JS版 (client/glintClient.js) とメソッド対応を保つこと。新しいAPIを追加した場合は
#   両方に反映し、docs/apiServer.md との対応も保つこと.
#
# 使用例:
#   from glint_client import GlintClient
#   client = GlintClient("http://localhost:3000")
#   groups = client.list_groups()

import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request


class GlintApiError(Exception):
    """apiServer.js が返したエラーレスポンス ({ error: { code, message } }) を表す例外."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class GlintClient:
    """glint の apiServer.js に対するHTTP APIクライアント."""

    def __init__(self, base_url):
        if not base_url:
            raise ValueError("base_url is required.")
        self.base_url = base_url[:-1] if base_url.endswith("/") else base_url

    # ─── private ────────────────────────────────────

    def _request_json(self, method, path, body=None):
        url = self.base_url + "/api" + path
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as res:
                text = res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8")
            self._raise_error(e.code, text)
            return None
        return json.loads(text) if text else {}

    def _request_raw(self, path):
        url = self.base_url + "/api" + path
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req) as res:
                buffer = res.read()
                content_type = res.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            self._raise_error(e.code, e.read().decode("utf-8"))
            return None
        return buffer, content_type

    @staticmethod
    def _raise_error(code, text):
        message = "HTTP " + str(code)
        try:
            data = json.loads(text) if text else {}
            if data.get("error") and data["error"].get("message"):
                message = data["error"]["message"]
        except ValueError:
            pass
        raise GlintApiError(code, message)

    # ─── グループ ──────────────────────────────────

    def list_groups(self):
        """グループ一覧を取得する. -> {"groups": [str, ...]}"""
        return self._request_json("GET", "/groups")

    def create_group(self, group):
        """空のグループ(文書0件)を新規作成する. -> {"group": str}"""
        return self._request_json("POST", "/groups", {"group": group})

    def list_documents(self, group):
        """グループ内の文書一覧・文書数を取得する. -> {"count": int, "documents": [...]}"""
        return self._request_json("GET", "/groups/" + urllib.parse.quote(group, safe="") + "/documents")

    def get_stats(self, group):
        """グループ内のtag/category集計(件数・比率)を取得する."""
        return self._request_json("GET", "/groups/" + urllib.parse.quote(group, safe="") + "/stats")

    def get_allowed_tags(self, group):
        """グループ単位の許可タグ一覧を取得する (空配列 = 制限なし・自由生成). -> {"tags": [str, ...]}"""
        return self._request_json("GET", "/groups/" + urllib.parse.quote(group, safe="") + "/tags")

    def set_allowed_tags(self, group, tags):
        """グループ単位で許可するタグ一覧を設定する. -> {"group": str, "tags": [str, ...]}"""
        return self._request_json(
            "PUT", "/groups/" + urllib.parse.quote(group, safe="") + "/tags", {"tags": tags}
        )

    # ─── 文書登録・削除 ─────────────────────────────

    def register_text_document(self, group, file_name, text, url=None, options=None):
        """
        テキスト文書を登録する (非同期. jobIdが返るのみで完了は待たない).
        完了を待つ場合は wait_for_job() または register_text_document_and_wait() を使う.
        -> {"jobId": str, "status": str}
        """
        body = {"fileName": file_name, "text": text}
        if url is not None:
            body["url"] = url
        if options is not None:
            body["options"] = options
        return self._request_json(
            "POST", "/groups/" + urllib.parse.quote(group, safe="") + "/documents", body
        )

    def register_pdf_document(self, group, file_name, pdf_bytes, url=None, options=None):
        """
        PDF文書を登録する (非同期. テキストレイヤー付きPDFのみ対応).
        -> {"jobId": str, "status": str}
        """
        body = {
            "fileName": file_name,
            "mimeType": "application/pdf",
            "fileBase64": base64.b64encode(pdf_bytes).decode("ascii"),
        }
        if url is not None:
            body["url"] = url
        if options is not None:
            body["options"] = options
        return self._request_json(
            "POST", "/groups/" + urllib.parse.quote(group, safe="") + "/documents", body
        )

    def get_job(self, job_id):
        """文書登録ジョブの状態を取得する. -> {"status": str, "error": str|None, "createdAt": int, "updatedAt": int}"""
        return self._request_json("GET", "/jobs/" + urllib.parse.quote(job_id, safe=""))

    def wait_for_job(self, job_id, interval_sec=1.0, timeout_sec=1800.0):
        """
        ジョブが success または error になるまでポーリングする.
        戻り値: 最終的なジョブ情報 (status == "success").
        例外: status == "error" の場合、またはタイムアウトした場合に Exception を発生させる.
        """
        start_time = time.monotonic()
        while True:
            job = self.get_job(job_id)
            if job["status"] == "success":
                return job
            if job["status"] == "error":
                raise Exception("Job failed: " + str(job["error"]))
            if time.monotonic() - start_time > timeout_sec:
                raise Exception("Job wait timed out: " + job_id)
            time.sleep(interval_sec)

    def register_text_document_and_wait(
        self, group, file_name, text, url=None, options=None, interval_sec=1.0, timeout_sec=1800.0
    ):
        """テキスト文書を登録し、ジョブの完了(success/error)まで待つ. -> 完了したジョブ情報."""
        result = self.register_text_document(group, file_name, text, url=url, options=options)
        return self.wait_for_job(result["jobId"], interval_sec=interval_sec, timeout_sec=timeout_sec)

    def delete_document(self, group, file_name):
        """文書を削除する. -> {"removed": bool}"""
        return self._request_json(
            "DELETE",
            "/groups/" + urllib.parse.quote(group, safe="") + "/documents/" + urllib.parse.quote(file_name, safe=""),
        )

    def get_raw_document(self, group, file_name):
        """
        url未指定で登録した文書の元データを取得する.
        戻り値: (buffer: bytes, content_type: str)
        例外: 元データが無い場合 GlintApiError(code=404)
        """
        return self._request_raw(
            "/groups/" + urllib.parse.quote(group, safe="") + "/documents/" +
            urllib.parse.quote(file_name, safe="") + "/raw"
        )

    def update_document_tags(self, group, file_name, tag, category=None):
        """登録済み文書のtag/categoryを修正する. -> {"name": str, "tag": str|None, "category": [str, ...]}"""
        return self._request_json(
            "PUT",
            "/groups/" + urllib.parse.quote(group, safe="") + "/documents/" +
            urllib.parse.quote(file_name, safe="") + "/tags",
            {"tag": tag, "category": category or []},
        )

    # ─── RAG検索 ───────────────────────────────────

    def search(self, group, message, tags=None, categories=None, options=None):
        """
        ベクトル検索 + RAG推論を行い、回答を返す (同期. 完了まで応答をブロックする).
        -> {"message": str, "list": [{"name": str, "url": str}, ...]}
        """
        body = {"message": message}
        if tags is not None:
            body["tags"] = tags
        if categories is not None:
            body["categories"] = categories
        if options is not None:
            body["options"] = options
        return self._request_json(
            "POST", "/groups/" + urllib.parse.quote(group, safe="") + "/search", body
        )

    # ─── バックアップ / レストア ────────────────────

    def backup_group(self, group):
        """グループのバックアップバンドルを取得する."""
        return self._request_json("GET", "/groups/" + urllib.parse.quote(group, safe="") + "/backup")

    def restore_group(self, group, backup_bundle, overwrite=False):
        """
        バックアップバンドルからグループを復元する.
        backup_bundle: backup_group() が返したバンドル (vectorStore/srcDocuments).
        -> {"restored": bool, "group": str, "documentsRestored": int}
        """
        body = {"vectorStore": backup_bundle["vectorStore"]}
        if "srcDocuments" in backup_bundle:
            body["srcDocuments"] = backup_bundle["srcDocuments"]
        if overwrite:
            body["overwrite"] = True
        return self._request_json(
            "POST", "/groups/" + urllib.parse.quote(group, safe="") + "/restore", body
        )

    # ─── ヘルスチェック ─────────────────────────────

    def health(self):
        """llama.cpp接続先(埋め込み用・推論用)の状態を取得する."""
        return self._request_json("GET", "/health")
