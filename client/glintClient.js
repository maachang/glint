// client/glintClient.js
// glintのapiServer.js (HTTP API) に接続して操作するためのクライアントライブラリ.
//
// AIメモ:
// - apiServer.js側の実装(src/)とは独立させ、あくまでHTTP経由でAPIを呼ぶだけの
//   薄いラッパーとする (src/配下のモジュールを直接requireしない).
// - Node.js標準の fetch (Node 22.5+, package.jsonのenginesに準拠) を使用する.
// - エンドポイント仕様は docs/apiServer.md を参照. 新しいAPIを追加した場合は
//   このファイルにもメソッドを追加し、docs/apiServer.mdとの対応を保つこと.
//
// 使用例:
//   const GlintClient = require("./client/glintClient.js");
//   const client = new GlintClient("http://localhost:3000");
//   const { groups } = await client.listGroups();
//
(function () {
    "use strict";

    /**
     * glint の apiServer.js に対するHTTP APIクライアント.
     */
    class GlintClient {
        /**
         * @param {string} baseUrl  apiServer.js の待受ベースURL (例: "http://localhost:3000").
         * @param {object} [options]
         *   - {typeof fetch} [fetchImpl]  差し替え用のfetch実装 (省略時はグローバルfetch).
         */
        constructor(baseUrl, options) {
            if (typeof baseUrl !== "string" || baseUrl.length === 0) {
                throw new Error("baseUrl is required.");
            }
            this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
            this._fetch = (options && options.fetchImpl) || fetch;
        }

        /**
         * [private]JSON API呼び出しの共通処理.
         * エラーレスポンス ({ error: { code, message } }) の場合は Error を throw する
         * (Error.code にHTTPステータスコードを設定する).
         *
         * @param  {string} method
         * @param  {string} path    "/api" 以降のパス (先頭 "/" 込み).
         * @param  {object} [body]  JSONボディ (省略時は送信しない).
         * @return {Promise<object>}
         */
        async _requestJson(method, path, body) {
            const res = await this._fetch(this.baseUrl + "/api" + path, {
                method,
                headers: body !== undefined ? { "Content-Type": "application/json" } : {},
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
            const text = await res.text();
            const data = text.length > 0 ? JSON.parse(text) : {};
            if (!res.ok) {
                const message =
                    data && data.error && data.error.message
                        ? data.error.message
                        : "HTTP " + res.status;
                const err = new Error(message);
                err.code = res.status;
                throw err;
            }
            return data;
        }

        // ─── グループ ──────────────────────────────────

        /** グループ一覧を取得する. @return {Promise<{groups: string[]}>} */
        listGroups() {
            return this._requestJson("GET", "/groups");
        }

        /**
         * 空のグループ(文書0件)を新規作成する.
         * @param  {string} group
         * @return {Promise<{group: string}>}
         */
        createGroup(group) {
            return this._requestJson("POST", "/groups", { group });
        }

        /**
         * グループ内の文書一覧・文書数を取得する.
         *
         * opts (page/pageSize/tag/searchのいずれか) を指定した場合、ページング・
         * タグ絞り込み・ファイル名部分検索付きの結果を返す (指定しない場合は全件, 後方互換).
         *
         * @param  {string} group
         * @param  {object} [opts]
         *   - {number} [page]      1始まりのページ番号 (指定時はページング結果を返す).
         *   - {number} [pageSize]  1ページあたりの件数 (省略時はapiServer.js側のConfigのdocumentsPageSize).
         *   - {string} [tag]       完全一致で絞り込むタグ.
         *   - {string} [search]    文書名の部分一致検索文字列.
         * @return {Promise<{count: number, documents: Array}>} opts未指定時 (全件).
         * @return {Promise<{total: number, page: number, pageSize: number, documents: Array}>} opts指定時.
         */
        listDocuments(group, opts) {
            opts = opts || {};
            const query = new URLSearchParams();
            if (opts.page !== undefined) query.set("page", opts.page);
            if (opts.pageSize !== undefined) query.set("pageSize", opts.pageSize);
            if (opts.tag !== undefined) query.set("tag", opts.tag);
            if (opts.search !== undefined) query.set("search", opts.search);
            const qs = query.toString();
            return this._requestJson(
                "GET",
                "/groups/" + encodeURIComponent(group) + "/documents" + (qs ? "?" + qs : ""),
            );
        }

        /**
         * グループ内のtag/category集計(件数・比率)を取得する.
         * @param  {string} group
         * @return {Promise<object>}
         */
        getStats(group) {
            return this._requestJson("GET", "/groups/" + encodeURIComponent(group) + "/stats");
        }

        /**
         * グループ単位の許可タグ一覧を取得する (空配列 = 制限なし・自由生成).
         * @param  {string} group
         * @return {Promise<{tags: string[]}>}
         */
        getAllowedTags(group) {
            return this._requestJson("GET", "/groups/" + encodeURIComponent(group) + "/tags");
        }

        /**
         * グループ単位で許可するタグ一覧を設定する.
         * @param  {string}   group
         * @param  {string[]} tags
         * @return {Promise<{group: string, tags: string[]}>}
         */
        setAllowedTags(group, tags) {
            return this._requestJson("PUT", "/groups/" + encodeURIComponent(group) + "/tags", { tags });
        }

        // ─── 文書登録・削除 ─────────────────────────────

        /**
         * テキスト文書を登録する (非同期. jobIdが返るのみで完了は待たない).
         * 完了を待ちたい場合は waitForJob() または registerTextDocumentAndWait() を使う.
         *
         * @param  {string} group
         * @param  {string} fileName  拡張子込みのファイル名.
         * @param  {string} text      本文テキスト.
         * @param  {object} [opts]
         *   - {string} [url]      参照元URL (省略時は自動発行).
         *   - {object} [options]  putTextFileToVectorGroup()への追加オプション.
         * @return {Promise<{jobId: string, status: string}>}
         */
        registerTextDocument(group, fileName, text, opts) {
            opts = opts || {};
            const body = { fileName, text };
            if (opts.url !== undefined) body.url = opts.url;
            if (opts.options !== undefined) body.options = opts.options;
            return this._requestJson(
                "POST",
                "/groups/" + encodeURIComponent(group) + "/documents",
                body,
            );
        }

        /**
         * PDF文書を登録する (非同期. テキストレイヤー付きPDFのみ対応).
         *
         * @param  {string} group
         * @param  {string} fileName    拡張子込みのファイル名 (例: "manual.pdf").
         * @param  {Buffer} pdfBuffer   PDFバイナリ.
         * @param  {object} [opts]
         *   - {string} [url]
         *   - {object} [options]
         * @return {Promise<{jobId: string, status: string}>}
         */
        registerPdfDocument(group, fileName, pdfBuffer, opts) {
            opts = opts || {};
            const body = {
                fileName,
                mimeType: "application/pdf",
                fileBase64: Buffer.isBuffer(pdfBuffer)
                    ? pdfBuffer.toString("base64")
                    : Buffer.from(pdfBuffer).toString("base64"),
            };
            if (opts.url !== undefined) body.url = opts.url;
            if (opts.options !== undefined) body.options = opts.options;
            return this._requestJson(
                "POST",
                "/groups/" + encodeURIComponent(group) + "/documents",
                body,
            );
        }

        /**
         * 文書登録ジョブの状態を取得する.
         * @param  {string} jobId
         * @return {Promise<{status: string, error: string|null, createdAt: number, updatedAt: number}>}
         */
        getJob(jobId) {
            return this._requestJson("GET", "/jobs/" + encodeURIComponent(jobId));
        }

        /**
         * ジョブが success または error になるまでポーリングする.
         * @param  {string} jobId
         * @param  {object} [opts]
         *   - {number} [intervalMs=1000]  ポーリング間隔.
         *   - {number} [timeoutMs=1800000] タイムアウト (デフォルト30分. 長文書のサマリー生成・埋め込みは時間がかかるため).
         * @return {Promise<object>}  最終的なジョブ情報 (status === "success").
         * @throws {Error} status === "error" の場合、またはタイムアウトした場合.
         */
        async waitForJob(jobId, opts) {
            opts = opts || {};
            const intervalMs = opts.intervalMs || 1000;
            const timeoutMs = opts.timeoutMs || 1800000;
            const startTime = Date.now();
            for (;;) {
                const job = await this.getJob(jobId);
                if (job.status === "success") {
                    return job;
                }
                if (job.status === "error") {
                    throw new Error("Job failed: " + job.error);
                }
                if (Date.now() - startTime > timeoutMs) {
                    throw new Error("Job wait timed out: " + jobId);
                }
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }

        /**
         * テキスト文書を登録し、ジョブの完了(success/error)まで待つ.
         * @param  {string} group
         * @param  {string} fileName
         * @param  {string} text
         * @param  {object} [opts]  registerTextDocument()のoptsに加え、waitForJob()のintervalMs/timeoutMsも指定可.
         * @return {Promise<object>}  完了したジョブ情報.
         */
        async registerTextDocumentAndWait(group, fileName, text, opts) {
            const { jobId } = await this.registerTextDocument(group, fileName, text, opts);
            return this.waitForJob(jobId, opts);
        }

        /**
         * 文書を削除する.
         * @param  {string} group
         * @param  {string} fileName  拡張子込みのファイル名.
         * @return {Promise<{removed: boolean}>}
         */
        deleteDocument(group, fileName) {
            return this._requestJson(
                "DELETE",
                "/groups/" + encodeURIComponent(group) + "/documents/" + encodeURIComponent(fileName),
            );
        }

        /**
         * url未指定で登録した文書の元データを取得する.
         * @param  {string} group
         * @param  {string} fileName
         * @return {Promise<{buffer: Buffer, contentType: string}>}
         * @throws {Error} 元データが無い場合 (.code = 404)
         */
        async getRawDocument(group, fileName) {
            const res = await this._fetch(
                this.baseUrl +
                    "/api/groups/" + encodeURIComponent(group) +
                    "/documents/" + encodeURIComponent(fileName) + "/raw",
            );
            if (!res.ok) {
                const err = new Error("HTTP " + res.status);
                err.code = res.status;
                throw err;
            }
            const arrayBuffer = await res.arrayBuffer();
            return {
                buffer: Buffer.from(arrayBuffer),
                contentType: res.headers.get("content-type"),
            };
        }

        /**
         * 登録済み文書のtag/categoryを修正する.
         * @param  {string}      group
         * @param  {string}      fileName
         * @param  {string|null} tag
         * @param  {string[]}    [category]
         * @return {Promise<{name: string, tag: string|null, category: string[]}>}
         */
        updateDocumentTags(group, fileName, tag, category) {
            return this._requestJson(
                "PUT",
                "/groups/" + encodeURIComponent(group) + "/documents/" +
                    encodeURIComponent(fileName) + "/tags",
                { tag, category: category || [] },
            );
        }

        // ─── RAG検索 ───────────────────────────────────

        /**
         * ベクトル検索 + RAG推論を行い、回答を返す (同期. 完了まで応答をブロックする).
         * @param  {string}   group
         * @param  {string}   message
         * @param  {object}   [opts]
         *   - {string[]} [tags]
         *   - {string[]} [categories]
         *   - {object}   [options]  hybridSearch/hybridKeywordWeight/ragRerank/rerankCandidateLength等.
         * @return {Promise<{message: string, list: Array<{name: string, url: string}>}>}
         */
        search(group, message, opts) {
            opts = opts || {};
            const body = { message };
            if (opts.tags !== undefined) body.tags = opts.tags;
            if (opts.categories !== undefined) body.categories = opts.categories;
            if (opts.options !== undefined) body.options = opts.options;
            return this._requestJson(
                "POST",
                "/groups/" + encodeURIComponent(group) + "/search",
                body,
            );
        }

        // ─── バックアップ / レストア ────────────────────

        /**
         * グループのバックアップバンドルを取得する.
         * @param  {string} group
         * @return {Promise<object>}  vectorStore/srcDocuments/glintConfigSnapshotを含むバンドル.
         */
        backupGroup(group) {
            return this._requestJson("GET", "/groups/" + encodeURIComponent(group) + "/backup");
        }

        /**
         * バックアップバンドルからグループを復元する.
         * @param  {string}  group
         * @param  {object}  backupBundle  backupGroup()が返したバンドル (vectorStore/srcDocuments).
         * @param  {boolean} [overwrite]   既存グループを上書きするか.
         * @return {Promise<{restored: boolean, group: string, documentsRestored: number}>}
         */
        restoreGroup(group, backupBundle, overwrite) {
            const body = { vectorStore: backupBundle.vectorStore };
            if (backupBundle.srcDocuments !== undefined) {
                body.srcDocuments = backupBundle.srcDocuments;
            }
            if (overwrite) body.overwrite = true;
            return this._requestJson(
                "POST",
                "/groups/" + encodeURIComponent(group) + "/restore",
                body,
            );
        }

        // ─── ヘルスチェック ─────────────────────────────

        /**
         * llama.cpp接続先(埋め込み用・推論用)の状態を取得する.
         * @return {Promise<{embeddingList: Array, inferenceList: Array}>}
         */
        health() {
            return this._requestJson("GET", "/health");
        }
    }

    module.exports = GlintClient;
})();
