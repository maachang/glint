/**
 * apiServer.js
 *
 * 文書登録・RAG検索を HTTP API として提供するサーバー.
 * Node.js 標準の http モジュールのみで実装 (外部依存なし).
 *
 * 【エンドポイント】
 *   GET    /groups                             グループ一覧
 *   GET    /groups/:group/documents             グループ内の文書一覧・文書数
 *   GET    /groups/:group/stats                 グループ内の tag/category 集計 (件数・比率)
 *   POST   /groups/:group/documents             文書登録 (非同期. 即時にjobIdを返す)
 *   DELETE /groups/:group/documents/:fileName  文書削除
 *   GET    /jobs/:jobId                        文書登録ジョブの状態確認
 *   POST   /groups/:group/search               RAG検索 (embedding検索 + 推論. 同期)
 *   GET    /health                             llama.cpp接続先の状態確認
 *
 * 【文書登録が非同期な理由】
 *   サマリー生成 + 埋め込みベクトル化で数秒〜数十秒かかるため、リクエストを
 *   ブロックせず即時に jobId を返し、GET /jobs/:jobId で結果を確認する形にしている.
 *
 * 【llama.cppサーバが利用不可の場合】
 *   ConnectMan.acquire() が例外を throw するので、そのまま 503 として返す
 *   (待機・リトライは行わない).
 *
 * 【使い方】
 *   node src/apiServer.js
 *   PORT=3000 node src/apiServer.js
 */
(function () {
    "use strict";

    const http = require("http");
    const crypto = require("crypto");

    const Config = require("./config.js");
    const ConnectMan = require("./connectMan.js");
    const vg = require("./vectorGroup.js");

    // デフォルトの待受ポート.
    const DEFAULT_PORT = 3000;

    // ジョブ結果を保持する期間 (完了後 30分でメモリから破棄する).
    const JOB_TTL = 30 * 60000;

    // ジョブ破棄のスイープ間隔.
    const JOB_SWEEP_INTERVAL = 60000;

    // ═══════════════════════════════════════════════════════════════
    // ジョブ管理 (文書登録の非同期処理状態を保持する).
    // ═══════════════════════════════════════════════════════════════

    /** @type {Map<string, Object>} jobId -> { status, error, createdAt, updatedAt } */
    const _jobs = new Map();

    // 新規ジョブを作成して jobId を返す.
    const _createJob = function () {
        const jobId = crypto.randomUUID();
        _jobs.set(jobId, {
            status: "pending",
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        return jobId;
    };

    // ジョブの状態を更新する.
    const _updateJob = function (jobId, status, error) {
        const job = _jobs.get(jobId);
        if (job == null) {
            return;
        }
        job.status = status;
        job.error = error || null;
        job.updatedAt = Date.now();
    };

    // 完了から一定時間経過したジョブをメモリから破棄する.
    setInterval(function () {
        const now = Date.now();
        for (const [jobId, job] of _jobs) {
            if (job.status !== "pending" && now - job.updatedAt > JOB_TTL) {
                _jobs.delete(jobId);
            }
        }
    }, JOB_SWEEP_INTERVAL);

    // ═══════════════════════════════════════════════════════════════
    // HTTP ユーティリティ.
    // ═══════════════════════════════════════════════════════════════

    // レスポンスをJSONで返す.
    const _sendJson = function (res, statusCode, body) {
        const txt = JSON.stringify(body);
        res.writeHead(statusCode, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(txt),
        });
        res.end(txt);
    };

    // エラーをJSON形式で返す (llamaCpp.jsのエラー形式に合わせる).
    const _sendError = function (res, statusCode, message) {
        _sendJson(res, statusCode, {
            error: { code: statusCode, message: String(message) },
        });
    };

    // リクエストボディを読み取り JSON として parse する.
    const _readJsonBody = function (req) {
        return new Promise((resolve, reject) => {
            let body = "";
            req.on("data", (chunk) => {
                body += chunk;
            });
            req.on("end", () => {
                if (body.length === 0) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error("Invalid JSON body: " + e.message));
                }
            });
            req.on("error", reject);
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // ルーティング.
    // ═══════════════════════════════════════════════════════════════

    // パスセグメントを取得 (先頭/末尾の "/" を除去し、URLデコードして分割).
    const _pathSegments = function (pathname) {
        return pathname
            .replace(/^\/+|\/+$/g, "")
            .split("/")
            .map(decodeURIComponent);
    };

    // POST /groups/:group/documents
    const _handlePutDocument = async function (req, res, groupName) {
        const body = await _readJsonBody(req);
        const fileName = body.fileName;
        const url = body.url;
        const text = body.text;
        if (!fileName || typeof text !== "string") {
            _sendError(
                res,
                400,
                "fileName and text are required in the request body.",
            );
            return;
        }

        const jobId = _createJob();
        // レスポンスは即時に返し、実処理はバックグラウンドで継続する.
        _sendJson(res, 202, { jobId, status: "pending" });

        console.info(
            "[job:" + jobId + "] start putTextFileToVectorGroup: group=" +
                groupName + " fileName=" + fileName,
        );
        try {
            await vg.putTextFileToVectorGroup(
                groupName,
                fileName,
                url,
                text,
                body.options,
            );
            _updateJob(jobId, "success");
            console.info("[job:" + jobId + "] success");
        } catch (e) {
            console.error("[job:" + jobId + "] error: " + e.message);
            _updateJob(jobId, "error", e.message);
        }
    };

    // GET /jobs/:jobId
    const _handleGetJob = function (req, res, jobId) {
        const job = _jobs.get(jobId);
        if (job == null) {
            _sendError(res, 404, "The specified jobId does not exist: " + jobId);
            return;
        }
        _sendJson(res, 200, job);
    };

    // DELETE /groups/:group/documents/:fileName
    const _handleDeleteDocument = async function (
        req,
        res,
        groupName,
        fileName,
    ) {
        const removed = await vg.removeTextFileFromVectorGroup(
            groupName,
            fileName,
        );
        _sendJson(res, 200, { removed });
    };

    // GET /groups
    const _handleListGroups = function (req, res) {
        const groups = vg.listGroups();
        _sendJson(res, 200, { groups });
    };

    // GET /groups/:group/documents
    const _handleListDocuments = async function (req, res, groupName) {
        const vgObj = await vg.loadVectorGroup(groupName);
        const summary = vgObj.getSummary();
        const names = summary.getDocuments();
        const documents = names.map((name) => {
            // 保存済みサマリーテキストから tag/category を再抽出する.
            // 旧形式など解析できない場合は null にする.
            const parsed = vg.parseSummaryJson(summary.getText(name));
            return {
                name,
                url: summary.getUrl(name),
                time: Number(summary.getTime(name)),
                tag: parsed ? parsed.tag ?? null : null,
                category: parsed ? parsed.category ?? null : null,
            };
        });
        _sendJson(res, 200, { count: documents.length, documents });
    };

    // GET /groups/:group/stats
    const _handleGroupStats = async function (req, res, groupName) {
        const stats = await vg.getGroupStats(groupName);
        _sendJson(res, 200, stats);
    };

    // POST /groups/:group/search
    // body: { message, tags?, categories?, options? }
    // tags/categories はベクトル検索結果に対する事後フィルタ (いずれか一致でOR).
    const _handleSearch = async function (req, res, groupName) {
        const body = await _readJsonBody(req);
        const message = body.message;
        if (typeof message !== "string" || message.length === 0) {
            _sendError(res, 400, "message is required in the request body.");
            return;
        }
        // options に tags/categories をマージする (options 側の指定を優先).
        const options = Object.assign(
            { tags: body.tags, categories: body.categories },
            body.options,
        );
        const vgObj = await vg.loadVectorGroup(groupName);
        const answer = await vg.search(vgObj, message, options);
        _sendJson(res, 200, { answer });
    };

    // GET /health
    const _handleHealth = function (req, res) {
        const conf = Config.getInstance();
        const toStatus = (info) => ({
            baseUrl: info.baseUrl,
            healthy: info.healthy,
            useCount: info.useCount,
            maxConnectCount: info.maxConnectCount,
        });
        _sendJson(res, 200, {
            embeddingList: conf.embeddingList.map(toStatus),
            inferenceList: conf.inferenceList.map(toStatus),
        });
    };

    // 1リクエストをルーティングして処理する.
    const _route = async function (req, res) {
        const pathname = req.url.split("?")[0];
        const seg = _pathSegments(pathname);

        // GET /health
        if (req.method === "GET" && seg.length === 1 && seg[0] === "health") {
            _handleHealth(req, res);
            return;
        }
        // GET /jobs/:jobId
        if (req.method === "GET" && seg.length === 2 && seg[0] === "jobs") {
            _handleGetJob(req, res, seg[1]);
            return;
        }
        // GET /groups
        if (req.method === "GET" && seg.length === 1 && seg[0] === "groups") {
            _handleListGroups(req, res);
            return;
        }
        // /groups/:group/documents[/...]
        if (seg[0] === "groups" && seg[2] === "documents") {
            const groupName = seg[1];
            if (req.method === "GET" && seg.length === 3) {
                await _handleListDocuments(req, res, groupName);
                return;
            }
            if (req.method === "POST" && seg.length === 3) {
                await _handlePutDocument(req, res, groupName);
                return;
            }
            if (req.method === "DELETE" && seg.length === 4) {
                await _handleDeleteDocument(req, res, groupName, seg[3]);
                return;
            }
        }
        // GET /groups/:group/stats
        if (
            req.method === "GET" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "stats"
        ) {
            await _handleGroupStats(req, res, seg[1]);
            return;
        }
        // POST /groups/:group/search
        if (
            req.method === "POST" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "search"
        ) {
            await _handleSearch(req, res, seg[1]);
            return;
        }

        console.warn("Not found: " + req.method + " " + pathname);
        _sendError(res, 404, "Not found: " + req.method + " " + pathname);
    };

    // ═══════════════════════════════════════════════════════════════
    // サーバー起動.
    // ═══════════════════════════════════════════════════════════════

    /**
     * APIサーバーを起動する.
     *
     * @param  {number} [port]  待受ポート (省略時は環境変数 PORT または 3000).
     * @return {http.Server}
     */
    const start = function (port) {
        // port=0 (OSにランダムなポートを割り当てさせる) が呼び出し元から明示的に
        // 渡された場合でも "||" で潰されないよう undefined/null のみで判定する.
        port =
            port !== undefined && port !== null
                ? port
                : Number(process.env.PORT) || DEFAULT_PORT;

        const conf = Config.getInstance();

        // ローカルログ出力を有効化する.
        // localLog.js は require した時点でグローバルの console を置き換えるため、
        // apiServer.js が実際に起動される場合のみ有効になるよう start() 内で require する
        // (vectorGroup.js 等をライブラリとして使うだけの場合に console を汚さないため).
        const LocalLog = require("./localLog.js");
        LocalLog.setting(conf.getLogSetting());

        // llama.cppサーバ群への定期ヘルスチェックを開始する.
        // healthCheckTiming は BigInt で保持されているため Number に変換する.
        const healthCheckTiming = Number(conf.healthCheckTiming);
        ConnectMan.startHealthCheck(conf.embeddingList, healthCheckTiming);
        ConnectMan.startHealthCheck(conf.inferenceList, healthCheckTiming);

        const server = http.createServer((req, res) => {
            const tm = Date.now();
            const method = req.method;
            const pathname = req.url.split("?")[0];
            res.on("finish", () => {
                console.info(
                    method + " " + pathname + " " + res.statusCode +
                        " " + (Date.now() - tm) + "msec",
                );
            });
            _route(req, res).catch((e) => {
                console.error("#apiServer error: " + e.message);
                _sendError(res, 503, e.message);
            });
        });
        server.listen(port, () => {
            console.log(
                "glint apiServer listening on port " + server.address().port,
            );
        });
        return server;
    };

    // このファイルが直接実行された場合はサーバーを起動する.
    if (require.main === module) {
        start();
    }

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { start };
})();
