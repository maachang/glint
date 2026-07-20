/**
 * apiServer.js
 *
 * 文書登録・RAG検索を HTTP API として提供するサーバー.
 * HTTP部分は Node.js 標準の http モジュールのみで実装しているが、
 * PDF登録対応のため pdfExtract.js 経由で外部npm依存 (pdf-parse) を利用する.
 *
 * 【エンドポイント】
 *   JSON API は全て "/api" 配下 (public/配下の画面と名前空間を分離するため).
 *
 *   GET    /api/groups                             グループ一覧
 *   POST   /api/groups                             空のグループ(文書0件)を新規作成
 *   GET    /api/groups/:group/documents             グループ内の文書一覧・文書数
 *   GET    /api/groups/:group/stats                 グループ内の tag/category 集計 (件数・比率)
 *   GET    /api/groups/:group/tags                  グループ単位の許可タグ一覧取得 (空=制限なし)
 *   PUT    /api/groups/:group/tags                  グループ単位の許可タグ一覧設定
 *   POST   /api/groups/:group/documents             文書登録 (非同期. 即時にjobIdを返す)
 *   DELETE /api/groups/:group/documents/:fileName  文書削除
 *   GET    /api/groups/:group/documents/:fileName/raw  元データの取得 (url自動発行時のみ有効)
 *   PUT    /api/groups/:group/documents/:fileName/tags 登録済み文書のtag/category修正
 *   GET    /api/jobs/:jobId                        文書登録ジョブの状態確認
 *   POST   /api/groups/:group/search               RAG検索 (embedding検索 + 推論. 同期)
 *   GET    /api/groups/:group/backup               グループのバックアップ (.vgs/.vss + 元データ)
 *   POST   /api/groups/:group/restore              グループのレストア (バックアップから復元)
 *   GET    /api/health                             llama.cpp接続先の状態確認
 *   GET    /*                                     "/api" 以外は public/配下の静的ファイル配信・jhtml動的画面
 *
 * 【画面 (public/) について】
 *   "/api" 配下に一致しないGETリクエストは、public/配下のファイルを
 *   探して配信する (静的ファイルはそのまま, ".mt.html" は jhtml.js でサーバサイド
 *   レンダリングしてから配信). "/" は "public/index.mt.html" にマッピングする.
 *   機能別に複数ページに分かれており (RAG検索=index.mt.html, 文書登録=documents.mt.html,
 *   グループ管理=groups.mt.html)、各ページ上部の共通メニュー(js/menu.js)で遷移する.
 *   API呼び出しの共通処理はjs/common.jsに切り出し、各ページはjs/search.js・
 *   js/documents.js・js/groups.jsがそれぞれのロジックを担当する.
 *
 * 【文書登録が非同期な理由】
 *   サマリー生成 + 埋め込みベクトル化で数秒〜数十秒かかるため、リクエストを
 *   ブロックせず即時に jobId を返し、GET /api/jobs/:jobId で結果を確認する形にしている.
 *
 * 【PDF登録について】
 *   POST /api/groups/:group/documents のリクエストボディで "mimeType": "application/pdf"
 *   を指定した場合、"text" の代わりに "fileBase64" (PDFバイナリをbase64化したもの) を
 *   必須とする. pdfExtract.js でテキストを抽出してから登録する.
 *   ※ テキストレイヤーの無いスキャン画像PDFからは抽出できない.
 *
 * 【url未指定時の自動URL発行について】
 *   POST /api/groups/:group/documents で "url" が未指定の場合、アップロードされた
 *   元データ (テキストまたはPDFバイナリ) を conf.srcDocumentPath 配下に保存し、
 *   GET /api/groups/:group/documents/:fileName/raw で読み出せるURLを自動生成して
 *   文書の参照URLとして使用する.
 *
 * 【バックアップ/レストアについて】
 *   GET /api/groups/:group/backup は .vgs/.vss と元データ (srcDocumentPath配下) を
 *   base64化してJSON1つにまとめて返す (tar/zip等の外部依存は使わない).
 *   glint.json の設定スナップショットも参照用として含まれるが、apiKeyはマスクされ、
 *   POST /api/groups/:group/restore で復元してもグローバル設定には反映されない.
 *   restore先に既にグループが存在する場合、body.overwrite=true を指定しない限り
 *   409 エラーになる (誤った上書きを防ぐため).
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
    const fs = require("fs");
    const path = require("path");

    const Config = require("./config.js");
    const ConnectMan = require("./connectMan.js");
    const vg = require("./vectorGroup.js");
    const pdfExtract = require("./pdfExtract.js");
    const util = require("./util.js");
    const jhtml = require("./jhtml.js");

    // ═══════════════════════════════════════════════════════════════
    // jhtmlテンプレート向けライブラリローダー ($loadLib).
    // ═══════════════════════════════════════════════════════════════
    //
    // AIメモ: new Function() 経由で実行されるコード内から相対パスで require() を
    // 呼ぶと、Bunで --compile したバイナリでは "Cannot find module './x' from
    // '/$bunfs/root/...'" のように解決に失敗することを確認済み (相対パスの解決に
    // 必要な「呼び出し元ファイル」のコンテキストが失われるため).
    // 一方、絶対パスに変換してから require() すれば Bunコンパイル済みバイナリでも
    // 正しく解決できることを確認済みなので、$loadLib は必ず LIBRARY_PATH 基準の
    // 絶対パスに変換してから require() を呼ぶようにしている.
    // (このため、テンプレートから src/ 配下の任意のモジュールを動的requireできる.
    //  新しいモジュールを使う際もレジストリ登録等は不要).

    // $loadLib のライブラリ探索基準ディレクトリ (= src/).
    const LIBRARY_PATH = __dirname;

    /**
     * jhtmlテンプレート内から、src/ 配下のモジュールを名前 (相対パス) で動的にロードする.
     *
     * @param  {string} name  LIBRARY_PATH からの相対パス (例: "vectorGroup.js" や
     *                         "/vectorGroup.js"、拡張子省略も可).
     * @return {*}            require() の結果.
     * @throws {Error}        対象ファイルが存在しない場合.
     */
    const $loadLib = function (name) {
        name = ("" + name).trim();
        // 先頭の "/" は除去する (LIBRARY_PATH からの相対パスとして扱うため).
        if (name.charCodeAt(0) === 47) {
            name = name.substring(1);
        }
        // 絶対パスに変換してから require() する.
        // (相対パスのまま new Function() 内から require() すると、Bunコンパイル済み
        //  バイナリでモジュール解決に失敗するため、必ず絶対パス化してから渡すこと)
        let absPath = path.join(LIBRARY_PATH, name);
        if (fs.existsSync(absPath)) {
            return require(absPath);
        }
        // 拡張子省略時のため ".js" を付けたパスでも確認する.
        if (fs.existsSync(absPath + ".js")) {
            return require(absPath + ".js");
        }
        throw new Error("Failed to load lib: " + name);
    };

    // 画面 (静的ファイル・jhtmlテンプレート) の配信元ディレクトリ.
    //
    // AIメモ: Bunで --compile した実行バイナリでは、__dirname がコンパイル時の
    // ソースパス (開発機の絶対パス) に固定されてしまい、バイナリを別の場所に
    // 配置・配布した場合に public/ を見つけられない (存在しないパスを指してしまう)。
    // 一方 process.execPath は実行中のバイナリ自身の実際の場所を指すため、
    // Bunコンパイル済みバイナリ実行時 (process.argv[1] が "/$bunfs/" 配下になる)
    // はそちらを基準にする。通常の node/bun 実行時は __dirname を使う
    // (この場合 process.execPath は node/bun 本体のパスになり使えないため).
    const _isBunCompiledBinary =
        typeof process.argv[1] === "string" &&
        process.argv[1].startsWith("/$bunfs/");
    const PUBLIC_DIR = _isBunCompiledBinary
        ? path.join(path.dirname(process.execPath), "public")
        : path.join(__dirname, "public");
    // jhtml (動的テンプレート) の拡張子.
    const JHTML_EXTENSION = ".mt.html";
    // 拡張子 → Content-Type のマッピング.
    const STATIC_MIME_TYPES = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".ico": "image/x-icon",
    };

    // PDF登録時に受け付けるMIMEタイプ.
    const MIME_TYPE_PDF = "application/pdf";
    // テキスト登録時のMIMEタイプ.
    const MIME_TYPE_TEXT = "text/plain; charset=utf-8";
    // 元データのメタ情報 (mimeType) を保持するサイドカーファイルの拡張子.
    const RAW_META_EXTENSION = ".meta.json";

    // ═══════════════════════════════════════════════════════════════
    // 元データ保存 (url未指定時の自動URL発行用).
    // ═══════════════════════════════════════════════════════════════

    // グループ毎の元データ格納先ディレクトリを取得 (無ければ作成する).
    const _getSrcDocumentDir = function (groupName) {
        const conf = Config.getInstance();
        const dir = util.joinPath(
            conf.dirPath,
            conf.srcDocumentPath,
            groupName,
        );
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    };

    // 元データ (テキスト or PDFバイナリ) と、登録時に実際に使用した mimeType を保存する.
    // ※ mimeType はファイル名の拡張子から推測せず、登録時の判定結果をそのまま使うこと.
    const _saveRawDocument = function (groupName, fileName, buffer, mimeType) {
        const dir = _getSrcDocumentDir(groupName);
        fs.writeFileSync(dir + "/" + fileName, buffer);
        fs.writeFileSync(
            dir + "/" + fileName + RAW_META_EXTENSION,
            JSON.stringify({ mimeType }),
        );
    };

    // 保存済みの元データを読み込む (存在しない場合は null).
    const _loadRawDocument = function (groupName, fileName) {
        try {
            const conf = Config.getInstance();
            const filePath = util.joinPath(
                conf.dirPath,
                conf.srcDocumentPath,
                groupName,
                fileName,
            );
            return fs.readFileSync(filePath);
        } catch (e) {
            return null;
        }
    };

    // 保存済みの元データの mimeType を取得する.
    // メタ情報が存在しない (削除済み・旧データ等) 場合は null.
    const _loadRawDocumentMimeType = function (groupName, fileName) {
        try {
            const conf = Config.getInstance();
            const metaPath = util.joinPath(
                conf.dirPath,
                conf.srcDocumentPath,
                groupName,
                fileName + RAW_META_EXTENSION,
            );
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            return meta.mimeType || null;
        } catch (e) {
            return null;
        }
    };

    // 保存済みの元データ (+ メタ情報) を削除する (存在しない場合は何もしない).
    const _removeRawDocument = function (groupName, fileName) {
        const dir = _getSrcDocumentDir(groupName);
        try {
            fs.unlinkSync(dir + "/" + fileName);
        } catch (e) {
            // 元々存在しない場合は無視する.
        }
        try {
            fs.unlinkSync(dir + "/" + fileName + RAW_META_EXTENSION);
        } catch (e) {
            // 元々存在しない場合は無視する.
        }
    };

    // グループの元データ一覧を読み込む (バックアップ用).
    // .meta.json サイドカーファイル自体は対象から除外する.
    const _listRawDocuments = function (groupName) {
        const dir = _getSrcDocumentDir(groupName);
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch (e) {
            return [];
        }
        const ret = [];
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (name.endsWith(RAW_META_EXTENSION)) continue;
            let stat;
            try {
                stat = fs.statSync(dir + "/" + name);
            } catch (e) {
                continue;
            }
            if (!stat.isFile()) continue;
            ret.push({
                fileName: name,
                content: fs.readFileSync(dir + "/" + name),
                mimeType: _loadRawDocumentMimeType(groupName, name),
            });
        }
        return ret;
    };

    // url未指定時に自動発行する raw 取得用URLを組み立てる.
    // conf.publicBaseUrl が設定されていればそれを使い (リバースプロキシ等の背後で
    // 動かす場合を想定)、未設定ならリクエストの Host ヘッダーから組み立てる.
    const _buildRawDocumentUrl = function (req, groupName, fileName) {
        const conf = Config.getInstance();
        const base = conf.publicBaseUrl || "http://" + req.headers.host;
        return (
            base +
            "/api/groups/" + encodeURIComponent(groupName) +
            "/documents/" + encodeURIComponent(fileName) + "/raw"
        );
    };

    // ═══════════════════════════════════════════════════════════════
    // 画面配信 (public/ 配下の静的ファイル・jhtml動的テンプレート).
    // ═══════════════════════════════════════════════════════════════

    // jhtml変換結果のキャッシュ. key: 絶対パス, value: {mtimeMs, code}.
    // ファイルの mtime が変わっていたら再変換する (毎リクエストでのファイルI/O+
    // 変換コストを避けるための簡易キャッシュ).
    const _jhtmlCache = new Map();

    /**
     * リクエストパスから public/ 配下の実ファイルパスを安全に解決する.
     * "/" は index.mt.html にマッピングする.
     * public/ の外側に出るパス (../ 等) は null を返して拒否する.
     *
     * @param  {string} pathname  URLのパス部分 (クエリ抜き, デコード前).
     * @return {string|null}      解決済みの絶対パス. 不正な場合は null.
     */
    const _resolvePublicPath = function (pathname) {
        let rel = decodeURIComponent(pathname);
        if (rel === "/" || rel === "") {
            rel = "/index.mt.html";
        }
        const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
        // public/ の外側を指すパスは拒否する (パストラバーサル対策).
        if (
            resolved !== PUBLIC_DIR &&
            !resolved.startsWith(PUBLIC_DIR + path.sep)
        ) {
            return null;
        }
        return resolved;
    };

    /**
     * jhtml (.mt.html) テンプレートをサーバサイドでレンダリングして返す.
     *
     * テンプレート内では $request, $response, $out (出力関数), $loadLib (src/配下の
     * モジュールを動的にロードする関数) が利用できる.
     *
     * @param  {string} filePath  .mt.html の絶対パス.
     * @param  {http.IncomingMessage} req
     * @param  {http.ServerResponse}  res
     * @return {Promise<string>}  レンダリング結果のHTML文字列.
     */
    const _renderJHtml = async function (filePath, req, res) {
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        const cached = _jhtmlCache.get(filePath);
        let code;
        if (cached && cached.mtimeMs === mtimeMs) {
            code = cached.code;
        } else {
            const source = fs.readFileSync(filePath, "utf-8");
            // noOut=true: $out呼び出しの生ステートメントのみを取得し、
            // 実行コンテキスト ($request/$response/$loadLib) は呼び出し側で注入する.
            code = jhtml.convert(source, "$out", true);
            _jhtmlCache.set(filePath, { mtimeMs, code });
        }
        let outStr = "";
        const $out = function (s) {
            outStr += s;
        };
        const fn = new Function(
            "$request",
            "$response",
            "$out",
            "$loadLib",
            code,
        );
        await fn(req, res, $out, $loadLib);
        return outStr;
    };

    // 静的ファイル配信 + jhtml動的テンプレート配信 (public/ 配下).
    // API の各ルートに一致しなかった GET リクエストの最終フォールバックとして呼ぶ.
    const _handlePublicFile = async function (req, res, pathname) {
        const filePath = _resolvePublicPath(pathname);
        if (filePath == null) {
            _sendError(res, 403, "Forbidden path: " + pathname);
            return;
        }
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (e) {
            _sendError(res, 404, "Not found: " + pathname);
            return;
        }
        if (!stat.isFile()) {
            _sendError(res, 404, "Not found: " + pathname);
            return;
        }

        if (filePath.endsWith(JHTML_EXTENSION)) {
            try {
                const html = await _renderJHtml(filePath, req, res);
                const body = Buffer.from(html, "utf-8");
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Length": body.length,
                });
                res.end(body);
            } catch (e) {
                console.error("#jhtml render error (" + filePath + "): " + e.message);
                _sendError(res, 500, "Template rendering error: " + e.message);
            }
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": body.length,
        });
        res.end(body);
    };

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
    // body: { fileName, url, text } または
    //       { fileName, url, mimeType: "application/pdf", fileBase64 }
    const _handlePutDocument = async function (req, res, groupName) {
        const body = await _readJsonBody(req);
        const fileName = body.fileName;
        let url = body.url;
        const isPdf = body.mimeType === MIME_TYPE_PDF;

        if (!fileName) {
            _sendError(res, 400, "fileName is required in the request body.");
            return;
        }
        if (isPdf) {
            if (typeof body.fileBase64 !== "string" || body.fileBase64.length === 0) {
                _sendError(
                    res,
                    400,
                    "fileBase64 is required when mimeType is " + MIME_TYPE_PDF + ".",
                );
                return;
            }
        } else if (typeof body.text !== "string") {
            _sendError(res, 400, "text is required in the request body.");
            return;
        }

        // 元データのバイナリ表現 (url未指定時の自動保存・PDFテキスト抽出で使う).
        const rawBuffer = isPdf
            ? Buffer.from(body.fileBase64, "base64")
            : Buffer.from(body.text, "utf8");

        // url が未指定の場合、元データを保存して読み出し用URLを自動発行する.
        if (!url) {
            _saveRawDocument(
                groupName,
                fileName,
                rawBuffer,
                isPdf ? MIME_TYPE_PDF : MIME_TYPE_TEXT,
            );
            url = _buildRawDocumentUrl(req, groupName, fileName);
        }

        const jobId = _createJob();
        // レスポンスは即時に返し、実処理はバックグラウンドで継続する.
        _sendJson(res, 202, { jobId, status: "pending" });

        console.info(
            "[job:" + jobId + "] start putTextFileToVectorGroup: group=" +
                groupName + " fileName=" + fileName +
                (isPdf ? " (pdf)" : ""),
        );
        try {
            // PDFの場合は先にテキストを抽出してから登録する.
            const text = isPdf
                ? await pdfExtract.extractText(rawBuffer)
                : body.text;
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
        // 自動発行URL用に保存していた元データも合わせて削除する (無ければ無視).
        _removeRawDocument(groupName, fileName);
        _sendJson(res, 200, { removed });
    };

    // GET /api/groups/:group/documents/:fileName/raw
    const _handleGetRawDocument = function (req, res, groupName, fileName) {
        const buffer = _loadRawDocument(groupName, fileName);
        if (buffer == null) {
            _sendError(
                res,
                404,
                "Raw source data does not exist for: " + fileName,
            );
            return;
        }
        // 登録時に実際に使用した mimeType を優先する.
        // (メタ情報が無い場合のみ、ファイル名拡張子から推測してフォールバックする)
        const contentType =
            _loadRawDocumentMimeType(groupName, fileName) ||
            (fileName.toLowerCase().endsWith(".pdf")
                ? MIME_TYPE_PDF
                : MIME_TYPE_TEXT);
        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": buffer.length,
        });
        res.end(buffer);
    };

    // GET /api/groups
    const _handleListGroups = function (req, res) {
        const groups = vg.listGroups();
        _sendJson(res, 200, { groups });
    };

    // POST /api/groups
    // body: { group: string }
    // 空のグループ(文書0件)を新規作成する. 通常はputTextFileToVectorGroup()で
    // 文書を登録した時点で暗黙的にグループが作成されるが、文書登録前にグループ単位の
    // 設定(許可タグ一覧等)を行いたい場合に、先にグループだけを作成できるようにするもの.
    const _handleCreateGroup = async function (req, res) {
        const body = await _readJsonBody(req);
        if (typeof body.group !== "string" || body.group.length === 0) {
            _sendError(res, 400, "group is required in the request body.");
            return;
        }
        try {
            await vg.createGroup(body.group);
        } catch (e) {
            _sendError(res, 409, e.message);
            return;
        }
        _sendJson(res, 201, { group: body.group });
    };

    // GET /groups/:group/documents
    const _handleListDocuments = async function (req, res, groupName) {
        const result = await vg.getGroupDocuments(groupName);
        _sendJson(res, 200, result);
    };

    // GET /api/groups/:group/stats
    const _handleGroupStats = async function (req, res, groupName) {
        const stats = await vg.getGroupStats(groupName);
        _sendJson(res, 200, stats);
    };

    // PUT /api/groups/:group/documents/:fileName/tags
    // body: { tag: string|null, category: string[] }
    // 登録済み文書のtag/categoryを修正する (要約本文・埋め込みチャンクは変更しない).
    const _handleUpdateDocumentTags = async function (req, res, groupName, fileName) {
        const body = await _readJsonBody(req);
        if (body.tag !== undefined && body.tag !== null && typeof body.tag !== "string") {
            _sendError(res, 400, "tag must be a string or null.");
            return;
        }
        if (body.category !== undefined && !Array.isArray(body.category)) {
            _sendError(res, 400, "category (Array<string>) is required in the request body.");
            return;
        }
        let result;
        try {
            result = await vg.updateDocumentTagCategory(
                groupName,
                fileName,
                body.tag,
                body.category || [],
            );
        } catch (e) {
            if (e.code === "ENOENT") {
                _sendError(res, 404, e.message);
                return;
            }
            _sendError(res, 400, e.message);
            return;
        }
        _sendJson(res, 200, result);
    };

    // GET /api/groups/:group/tags
    // グループ単位で許可されているタグ一覧を取得する (空配列 = 制限なし・自由生成).
    const _handleGetAllowedTags = async function (req, res, groupName) {
        let tags;
        try {
            tags = await vg.getAllowedTags(groupName);
        } catch (e) {
            if (e.code === "ENOENT") {
                _sendError(
                    res,
                    404,
                    "The specified group does not exist: " + groupName,
                );
                return;
            }
            throw e;
        }
        _sendJson(res, 200, { tags });
    };

    // PUT /api/groups/:group/tags
    // body: { tags: string[] }
    // グループ単位で許可するタグ一覧を設定する (空配列を設定すると制限なしに戻る).
    const _handleSetAllowedTags = async function (req, res, groupName) {
        const body = await _readJsonBody(req);
        if (!Array.isArray(body.tags)) {
            _sendError(res, 400, "tags (Array<string>) is required in the request body.");
            return;
        }
        let savedTags;
        try {
            savedTags = await vg.setAllowedTags(groupName, body.tags);
        } catch (e) {
            if (e.code === "ENOENT") {
                _sendError(
                    res,
                    404,
                    "The specified group does not exist: " + groupName,
                );
                return;
            }
            throw e;
        }
        _sendJson(res, 200, { group: groupName, tags: savedTags });
    };

    // ═══════════════════════════════════════════════════════════════
    // バックアップ / レストア.
    // ═══════════════════════════════════════════════════════════════

    // 現在の glint.json 設定内容のスナップショットを返す (参照用).
    // apiKey はバックアップ経由での漏洩を避けるため "***" にマスクする.
    const _getConfigSnapshot = function () {
        const conf = Config.getInstance();
        const toEntrySnapshot = (info) => ({
            baseUrl: info.baseUrl,
            maxConnectCount: info.maxConnectCount,
            model: info.model,
            apiKey: info.apiKey ? "***" : null,
            apiType: info.apiType,
        });
        return {
            embeddingList: conf.embeddingList.map(toEntrySnapshot),
            inferenceList: conf.inferenceList.map(toEntrySnapshot),
            maxConnectCount: conf.maxConnectCount,
            model: conf.model,
            apiKey: conf.apiKey ? "***" : null,
            apiType: conf.apiType,
            healthCheckTiming: Number(conf.healthCheckTiming),
            fetchTimeout: conf.fetchTimeout,
            dirPath: conf.dirPath,
            vectorStorePath: conf.vectorStorePath,
            srcDocumentPath: conf.srcDocumentPath,
            chunkSize: conf.chunkSize,
            overlapSize: conf.overlapSize,
            summaryTemperature: conf.summaryTemperature,
            summaryReasoning: conf.summaryReasoning,
            ragTemperature: conf.ragTemperature,
            vectorSearchLength: conf.vectorSearchLength,
            hybridSearch: conf.hybridSearch,
            hybridKeywordWeight: conf.hybridKeywordWeight,
            searchLogEnabled: conf.searchLogEnabled,
            ragRequestChunkLength: conf.ragRequestChunkLength,
            ragReasoning: conf.ragReasoning,
            ragRerank: conf.ragRerank,
            rerankCandidateLength: conf.rerankCandidateLength,
            lockTimeout: conf.lockTimeout,
            logDir: conf.logDir,
            logFile: conf.logFile,
            logLevel: conf.logLevel,
            publicBaseUrl: conf.publicBaseUrl,
        };
    };

    // GET /api/groups/:group/backup
    const _handleBackupGroup = async function (req, res, groupName) {
        const files = await vg.exportGroupFiles(groupName);
        if (files.vgs == null && files.vss == null) {
            _sendError(
                res,
                404,
                "The specified group does not exist: " + groupName,
            );
            return;
        }
        const srcDocuments = _listRawDocuments(groupName);
        const bundle = {
            group: groupName,
            createdAt: Date.now(),
            // 参照用のスナップショット. restore時にこの内容が glint.json に
            // 自動反映されることは無い (グローバル設定のため).
            glintConfigSnapshot: _getConfigSnapshot(),
            vectorStore: {
                vgs: files.vgs ? files.vgs.toString("base64") : null,
                vss: files.vss ? files.vss.toString("base64") : null,
            },
            srcDocuments: srcDocuments.map((d) => ({
                fileName: d.fileName,
                mimeType: d.mimeType,
                content: d.content.toString("base64"),
            })),
        };
        const txt = JSON.stringify(bundle);
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition":
                'attachment; filename="' + groupName + '-backup.json"',
            "Content-Length": Buffer.byteLength(txt),
        });
        res.end(txt);
    };

    // POST /api/groups/:group/restore
    // body: { overwrite?, vectorStore: {vgs, vss}, srcDocuments?: [{fileName, mimeType, content}] }
    // GET /api/groups/:group/backup が返すバンドルをそのまま渡せる形式.
    // glintConfigSnapshot が含まれていても glint.json への反映は行わない (参照用のため無視する).
    const _handleRestoreGroup = async function (req, res, groupName) {
        const body = await _readJsonBody(req);
        if (body.vectorStore == null) {
            _sendError(
                res,
                400,
                "vectorStore is required in the request body.",
            );
            return;
        }
        const vgsBuffer = body.vectorStore.vgs
            ? Buffer.from(body.vectorStore.vgs, "base64")
            : null;
        const vssBuffer = body.vectorStore.vss
            ? Buffer.from(body.vectorStore.vss, "base64")
            : null;

        try {
            await vg.importGroupFiles(
                groupName,
                vgsBuffer,
                vssBuffer,
                null,
                body.overwrite === true,
            );
        } catch (e) {
            // 既に存在していて overwrite 未指定の場合など.
            _sendError(res, 409, e.message);
            return;
        }

        let documentsRestored = 0;
        const srcDocuments = Array.isArray(body.srcDocuments)
            ? body.srcDocuments
            : [];
        for (let i = 0; i < srcDocuments.length; i++) {
            const doc = srcDocuments[i];
            if (!doc.fileName || typeof doc.content !== "string") continue;
            _saveRawDocument(
                groupName,
                doc.fileName,
                Buffer.from(doc.content, "base64"),
                doc.mimeType || null,
            );
            documentsRestored++;
        }

        console.info(
            "[restore] group=" + groupName +
                " documentsRestored=" + documentsRestored,
        );
        _sendJson(res, 200, {
            restored: true,
            group: groupName,
            documentsRestored,
        });
    };

    // POST /api/groups/:group/search
    // body: { message, tags?, categories?, options? }
    // tags/categories はベクトル検索の候補チャンクに対する事前フィルタ (いずれか一致でOR).
    const _handleSearch = async function (req, res, groupName) {
        const body = await _readJsonBody(req);
        const message = body.message;
        if (typeof message !== "string" || message.length === 0) {
            _sendError(res, 400, "message is required in the request body.");
            return;
        }
        // クライアントが切断(ページ遷移・リロード・タブクローズ等)した場合に、
        // llama.cppへの埋め込み/推論リクエストを中断させるためのsignal.
        // これが無いと、切断後も応答(または5分のタイムアウト)まで処理・接続スロット
        // 占有が続いてしまう.
        // ※ req(IncomingMessage)の"close"は、リクエストボディを読み終えた時点
        //   (_readJsonBody完了時)で切断とは無関係にほぼ即時発火してしまうため、
        //   誤検知になる. res(ServerResponse)の"close"は、正常応答完了後 or
        //   クライアント切断による premature close の両方で発火するが、応答完了後の
        //   発火はabort()を呼んでも無害 (既にPromiseが解決済みのため) なので、
        //   これを使う.
        const abortController = new AbortController();
        res.on("close", () => {
            abortController.abort();
        });
        // options に tags/categories をマージする (options 側の指定を優先).
        const options = Object.assign(
            { tags: body.tags, categories: body.categories },
            body.options,
            { signal: abortController.signal },
        );
        const vgObj = await vg.loadVectorGroup(groupName);
        const result = await vg.search(vgObj, message, options);
        _sendJson(res, 200, result);
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
        const fullSeg = _pathSegments(pathname);

        // "/api/..." 以外は JSON API の対象外.
        // (public/ 配下の静的ファイル・jhtml動的テンプレートと名前空間を分離するため)
        if (fullSeg[0] !== "api") {
            if (req.method === "GET") {
                await _handlePublicFile(req, res, pathname);
                return;
            }
            console.warn("Not found: " + req.method + " " + pathname);
            _sendError(res, 404, "Not found: " + req.method + " " + pathname);
            return;
        }
        // 先頭の "api" セグメントを除去し、以降は従来通りのルーティングを行う.
        const seg = fullSeg.slice(1);

        // GET /api/health
        if (req.method === "GET" && seg.length === 1 && seg[0] === "health") {
            _handleHealth(req, res);
            return;
        }
        // GET /api/jobs/:jobId
        if (req.method === "GET" && seg.length === 2 && seg[0] === "jobs") {
            _handleGetJob(req, res, seg[1]);
            return;
        }
        // GET /api/groups
        if (req.method === "GET" && seg.length === 1 && seg[0] === "groups") {
            _handleListGroups(req, res);
            return;
        }
        // POST /api/groups
        if (req.method === "POST" && seg.length === 1 && seg[0] === "groups") {
            await _handleCreateGroup(req, res);
            return;
        }
        // /api/groups/:group/documents[/...]
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
            // GET /api/groups/:group/documents/:fileName/raw
            if (
                req.method === "GET" &&
                seg.length === 5 &&
                seg[4] === "raw"
            ) {
                _handleGetRawDocument(req, res, groupName, seg[3]);
                return;
            }
            // PUT /api/groups/:group/documents/:fileName/tags
            if (
                req.method === "PUT" &&
                seg.length === 5 &&
                seg[4] === "tags"
            ) {
                await _handleUpdateDocumentTags(req, res, groupName, seg[3]);
                return;
            }
        }
        // GET /api/groups/:group/stats
        if (
            req.method === "GET" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "stats"
        ) {
            await _handleGroupStats(req, res, seg[1]);
            return;
        }
        // GET /api/groups/:group/tags
        if (
            req.method === "GET" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "tags"
        ) {
            await _handleGetAllowedTags(req, res, seg[1]);
            return;
        }
        // PUT /api/groups/:group/tags
        if (
            req.method === "PUT" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "tags"
        ) {
            await _handleSetAllowedTags(req, res, seg[1]);
            return;
        }
        // POST /api/groups/:group/search
        if (
            req.method === "POST" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "search"
        ) {
            await _handleSearch(req, res, seg[1]);
            return;
        }
        // GET /api/groups/:group/backup
        if (
            req.method === "GET" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "backup"
        ) {
            await _handleBackupGroup(req, res, seg[1]);
            return;
        }
        // POST /api/groups/:group/restore
        if (
            req.method === "POST" &&
            seg.length === 3 &&
            seg[0] === "groups" &&
            seg[2] === "restore"
        ) {
            await _handleRestoreGroup(req, res, seg[1]);
            return;
        }

        // "/api" 配下だが、どのAPIルートにも一致しなかった場合.
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
                // クライアント切断 (req.on("close")によるAbortController.abort()等) 由来の
                // 例外の場合、既にres側も書き込み不能になっている可能性があるため、
                // その場合は書き込みを試みない (ここでres.writeHead()を呼ぶと
                // 例外が発生し、キャッチされないPromise rejectionになりかねないため).
                if (res.writableEnded || res.destroyed) {
                    return;
                }
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
