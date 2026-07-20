/**
 * config.js
 *
 * RAG システム全体の設定を管理するシングルトンモジュール.
 *
 * 【設定カテゴリ】
 *   - ファイルパス        : vectorStore・参照文書の格納先
 *   - llama.cpp 接続先   : 埋め込み・推論それぞれのサーバー URL リスト
 *   - チャンク設定        : チャンクサイズ・オーバーラップサイズ
 *   - サマリー設定        : 要約生成の Temperature (プロンプト本文は prompt.js に定義)
 *   - RAG リクエスト設定  : 検索件数・チャンク数・チャンクフォーマット (プロンプト本文は prompt.js に定義)
 *
 * ※ system/user プロンプトの生成 (getSummaryRequest / getRagRequest) は
 *    prompt.js 側に移動済み. config.js は Temperature 等のパラメータのみ管理する.
 *
 * 【使い方】
 *   const Config = require('./config');
 *
 *   // JSON ファイルからロード
 *   Config.getInstance().loadConfig('./config', 'config.json');
 *
 *   // 設定値の取得
 *   const cfg = Config.getInstance();
 *   console.log(cfg.vectorStorePath);
 *   console.log(cfg.inferenceList[0].baseUrl);
 *
 *   // RAG プロンプト内の 1 チャンク分メッセージを生成 (prompt.js の getRagRequest() に渡す)
 *   const chunk = cfg.getRagRequestChunk(1, 'doc1', 'https://...', 0.98, 'サマリー文', '類似箇所');
 */
(function () {
    "use strict";

    const fs = require("fs");
    const Conv = require("./conv");
    const ConnectMan = require("./connectMan");

    // ═══════════════════════════════════════════════════════════════
    // デフォルト定数(Const).
    // ═══════════════════════════════════════════════════════════════

    /** llama.cpp タイプ: 推論モード */
    const LLAMA_CPP_TYPE_INFERENCE = 0;

    /** llama.cpp タイプ: 組み込み (埋め込み) モード */
    const LLAMA_CPP_TYPE_EMBEDDING = 1;

    /** fetchタイムアウト:ミリ秒設定(5分) */
    const DEFAULT_FETCH_TIMEOUT = 60000 * 5;

    /** デフォルトパス. */
    const DEFAULT_PATH = "./";

    /** vectorStore 格納先パスのデフォルト値 */
    const DEFAULT_VECTOR_STORE_PATH = "./vectorStore";

    /**
     * 参照文書格納先パスのデフォルト値.
     *
     * この下に「グループ名のパス」が作成され、さらにその下に
     * { text, name, url, time } 形式の {{name}}.json が格納される.
     * vectorStore 登録時に保管され、.vgs/.vss ファイルの生成・追加に利用される.
     */
    const DEFAULT_SRC_DOCUMENT_PATH = "./docs";

    /**
     * llama.cpp 接続確認タイミングのデフォルト値 (ミリ秒).
     * 15 秒に 1 度ヘルスチェックを行う.
     */
    const DEFAULT_HEALTH_CHECK_TIMING = 15000;

    /**
     * 日本語テキスト用のデフォルトチャンクサイズ (文字数).
     * 日本語は 1 文字あたりの情報量が多いため、英語より小さめの 300 文字に設定する.
     */
    const DEFAULT_JP_CHANK_SIZE = 300;

    /**
     * チャンクサイズに対するオーバーラップサイズの係数.
     * chunkSize × 0.25 = overlapSize となる.
     */
    const CHUNK_SIZE_TO_OVERLAP_COEFFICIENT = 0.25;

    /**
     * チャンクサイズからオーバーラップサイズを計算する.
     * デフォルトはチャンクサイズの 25% をオーバーラップとする.
     *
     * 例: chunkSize=300 → overlapSize=75
     *
     * @param  {number} chunkSize  チャンクサイズ (文字数)
     * @return {number}            オーバーラップサイズ (文字数)
     */
    const chunkSizeToOverlapSize = function (chunkSize) {
        return Math.floor(chunkSize * CHUNK_SIZE_TO_OVERLAP_COEFFICIENT);
    };

    /** サマリー生成の Temperature デフォルト値 (正確性重視: 0.1-0.5) */
    const DEFAULT_SUMMARY_TEMPERATURE = 0.25;

    /**
     * RAG 推論の Temperature デフォルト値 (正確性重視寄り: 0.25).
     * RAG では参考文書に忠実に答えさせるため低めに設定する.
     */
    const DEFAULT_RAG_TEMPERATURE = 0.25;

    /** ベクトル検索の最大取得件数デフォルト値 */
    const DEFAULT_VECTOR_SEARCH_LENGTH = 30;

    /** 文書一覧APIのページングデフォルト件数 */
    const DEFAULT_DOCUMENTS_PAGE_SIZE = 50;

    /** RAG リクエストに含めるチャンク数のデフォルト値 */
    const DEFAULT_RAG_REQUEST_CHANK_LENGTH = 7;

    /** RAGのリランキング(LLMによる候補文書の再順位付け) のデフォルト値 (常時ON) */
    const DEFAULT_RAG_RERANK = true;

    /** リランキング対象とする候補文書数の上限デフォルト値 */
    const DEFAULT_RERANK_CANDIDATE_LENGTH = 20;

    /** ハイブリッド検索 (文字2-gramキーワードスコアの合成) のデフォルト値 (常時ON) */
    const DEFAULT_HYBRID_SEARCH = true;

    /** ハイブリッド検索のキーワードスコア重みのデフォルト値 (0〜1, ベクトル重視) */
    const DEFAULT_HYBRID_KEYWORD_WEIGHT = 0.3;

    /**
     * RAG リクエスト内の 1 チャンク分プロンプトフォーマットのデフォルト値.
     *
     * プレースホルダー:
     *   {{no}}      : 順位番号.
     *   {{name}}    : 文書名
     *   {{url}}     : 文書 URL
     *   {{score}}   : 類似度スコア
     *   {{summary}} : 文書のサマリーテキスト
     *   {{chunkeds}}: ベクトル座標元のテキスト塊群.
     */
    const DEFAULT_RAG_REQUEST_CHUNK_FORMAT =
        "- {{no}} 参考文書名: {{name}}, 参考文書URL: {{url}}, 類似度: {{score}}:\n" +
        "  - サマリー内容: \n{{summary}}\n質問類似箇所: \n{{chunkeds}}";

    /** デフォルトの設定ファイルディレクトリパス */
    const DEFAULT_CONFIG_PATH = "./";

    /** デフォルトの設定ファイル名 */
    const DEFAULT_CONFIG_FILE = "glint.json";

    /**
     * llama.cpp サーバー1台あたりの同時接続数上限のデフォルト値.
     * glint.json の "maxConnectCount" (グローバル) または各接続先エントリの
     * "maxConnectCount" (個別上書き) で変更可能.
     */
    const DEFAULT_MAX_CONNECT_COUNT = 8;

    /**
     * ローカルログ (localLog.js) の出力先デフォルト値.
     * glint.json の "logDir" / "logFile" / "logLevel" で変更可能.
     */
    const DEFAULT_LOG_DIR = "./log";
    const DEFAULT_LOG_FILE = "logout";
    const DEFAULT_LOG_LEVEL = "info";

    /**
     * 接続先の種別.
     *  - "llamacpp": llama.cpp サーバー (GET /health によるヘルスチェック対応).
     *  - "openai":   OpenAI / OpenAI互換API (ルーターモード等). ヘルスチェック用の
     *                共通エンドポイントが無いため、ヘルスチェックは行わず常に healthy 扱いとする.
     * glint.json で接続先エントリに "apiType" を指定しない場合は "llamacpp" として扱う
     * (= 既存の llama.cpp 運用との後方互換).
     */
    const API_TYPE_LLAMACPP = "llamacpp";
    const API_TYPE_OPENAI = "openai";

    // ═══════════════════════════════════════════════════════════════
    // LlamaCppInfo
    //   接続先サーバー 1 台 (または1モデル) 分の接続情報を保持する値オブジェクト.
    // ═══════════════════════════════════════════════════════════════
    class LlamaCppInfo {
        /**
         * @param {number} llamaType        サーバー種別
         *                                  0 = 推論 (LLAMA_CPP_TYPE_INFERENCE)
         *                                  1 = 埋め込み (LLAMA_CPP_TYPE_EMBEDDING)
         * @param {string} baseUrl          接続先ベース URL (例: 'http://192.168.1.10:8080')
         * @param {number} [maxConnectCount] このサーバーへの同時接続数上限.
         * @param {string} [model]          リクエストボディに含める "model" 名.
         *                                  未指定の場合は body に model を含めない
         *                                  (llama.cpp の単一モデル運用と後方互換).
         * @param {string} [apiKey]         Authorization: Bearer ヘッダーに使うAPIキー.
         * @param {string} [apiType]        "llamacpp" (既定) または "openai".
         *                                  "openai" の場合はヘルスチェックを行わない.
         */
        constructor(llamaType, baseUrl, maxConnectCount, model, apiKey, apiType) {
            /** @type {number} 0=推論, 1=埋め込み, -1=不明 */
            this.llamaType = llamaType !== undefined ? llamaType : -1;
            /** @type {string} ベース URL */
            this.baseUrl = baseUrl !== undefined ? baseUrl : null;
            // 利用中カウント.
            this.useCount = 0;
            /** @type {number} 同時接続数上限 (これに達したら acquire 対象から除外) */
            this.maxConnectCount =
                maxConnectCount !== undefined && maxConnectCount > 0
                    ? maxConnectCount
                    : DEFAULT_MAX_CONNECT_COUNT;
            /** @type {string|null} リクエストボディに含める model 名 (未指定時は null) */
            this.model = model || null;
            /** @type {string|null} Authorization ヘッダーに使うAPIキー (未指定時は null) */
            this.apiKey = apiKey || null;
            /** @type {string} "llamacpp" または "openai" */
            this.apiType = apiType || API_TYPE_LLAMACPP;
            /**
             * @type {boolean} ヘルスチェック対応可否.
             * "llamacpp" のみ GET /health に対応している前提のため、それ以外は
             * ヘルスチェックを行わず常に healthy 扱いにする (connectMan.js が参照).
             */
            this.supportsHealthCheck = this.apiType === API_TYPE_LLAMACPP;
            /** @type {boolean} ヘルスチェック結果 (connectMan が更新する) */
            this.healthy = true;
            /** @type {number} エラーが継続して発生し始めた時刻 (未エラー: -1) */
            this.firstErrorTime = -1;
        }

        // 利用を開始する.
        startConnect() {
            this.useCount++;
        }

        // 利用終了.
        endConnect() {
            this.useCount--;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 内部ユーティリティ
    // ═══════════════════════════════════════════════════════════════

    /**
     * map オブジェクトからキー名で値を取得する.
     * キーが存在しない場合は defValue を返す.
     *
     * @param  {Object} map       検索対象のオブジェクト
     * @param  {string} name      キー名
     * @param  {*}      defValue  キーが存在しない場合のデフォルト値
     * @return {*}
     */
    const _mapToGetValue = function (map, name, defValue) {
        const ret = Conv.getMap(map)[name];
        return ret !== undefined && ret !== null ? ret : defValue;
    };

    /**
     * 設定 JSON の 1 エントリから LlamaCppInfo を生成する内部関数.
     *
     * @param  {Object} map   { url, maxConnectCount, model, apiKey, apiType } 形式のオブジェクト
     * @param  {number} type  LLAMA_CPP_TYPE_INFERENCE / LLAMA_CPP_TYPE_EMBEDDING
     * @param  {number} no    エントリのインデックス (エラーメッセージ用)
     * @param  {Object} defaults  未指定時に使うデフォルト値
     *   {number} maxConnectCount  {string} [model]  {string} [apiKey]  {string} [apiType]
     * @return {LlamaCppInfo}
     * @throws {Error}        url が空の場合
     */
    const _getLlamaCppInfo = function (map, type, no, defaults) {
        const url = Conv.getString(_mapToGetValue(map, "url", "")).trim();
        if (url.length === 0) {
            throw new Error(
                "The URL for llamaCpp connection destination (type: " +
                    type +
                    ", no: " +
                    no +
                    ") is not set.",
            );
        }
        const maxConnectCount = Conv.getInt(
            _mapToGetValue(map, "maxConnectCount", defaults.maxConnectCount),
        );
        const model = _mapToGetValue(map, "model", defaults.model);
        const apiKey = _mapToGetValue(map, "apiKey", defaults.apiKey);
        const apiType = _mapToGetValue(map, "apiType", defaults.apiType);
        return new LlamaCppInfo(
            type,
            url,
            maxConnectCount,
            model,
            apiKey,
            apiType,
        );
    };

    /**
     * 設定 JSON の指定キーから LlamaCppInfo の配列を生成して out に格納する.
     *
     * 値が単一オブジェクト ({ url: ... }) の場合は 1 件のリストとして扱う.
     * 値が配列 ([{ url: ... }, ...]) の場合は全要素を変換する.
     *
     * @param  {LlamaCppInfo[]} out   結果を格納する配列 (既存内容は上書きされる)
     * @param  {Object}         map   設定 JSON オブジェクト
     * @param  {string}         name  設定キー名 ('embeddingList' / 'inferenceList')
     * @param  {number}         type  LLAMA_CPP_TYPE_INFERENCE / LLAMA_CPP_TYPE_EMBEDDING
     * @param  {Object}         defaults  各エントリ未指定時に使うデフォルト値
     * @return {LlamaCppInfo[]}
     * @throws {Error} キーが存在しない場合、または値の型が不正な場合
     */
    const _getLlamaCppInfoList = function (out, map, name, type, defaults) {
        const info = Conv.getMap(map)[name];
        if (info === undefined || info === null) {
            throw new Error(
                "llamaCpp destination: " + name + " definition does not exist.",
            );
        }
        out.length = 0; // 配列をクリア
        if (Array.isArray(info)) {
            // 複数エントリの場合
            for (var i = 0; i < info.length; i++) {
                out.push(_getLlamaCppInfo(info[i], type, i, defaults));
            }
        } else if (typeof info === "object") {
            // 単一エントリの場合
            out.push(_getLlamaCppInfo(info, type, 0, defaults));
        } else {
            throw new Error(
                "llamaCpp destination: " +
                    name +
                    " Invalid definition: " +
                    typeof info,
            );
        }
        return out;
    };

    // ═══════════════════════════════════════════════════════════════
    // Config (シングルトン)
    // ═══════════════════════════════════════════════════════════════

    class Config {
        constructor() {
            // ─── ファイルパス ───────────────────────────────────────
            /** ディレクトリパス.  */
            this.dirPath = DEFAULT_PATH;

            /** vectorStore 格納先パス */
            this.vectorStorePath = DEFAULT_VECTOR_STORE_PATH;

            /** 参照文書格納先パス */
            this.srcDocumentPath = DEFAULT_SRC_DOCUMENT_PATH;

            // ─── llama.cpp 接続先 ───────────────────────────────────
            /**
             * 推論モードサーバーの接続先リスト.
             * 複数台設定することでロードバランシングに対応できる.
             * @type {LlamaCppInfo[]}
             */
            this.inferenceList = [];

            /**
             * 埋め込みモードサーバーの接続先リスト.
             * @type {LlamaCppInfo[]}
             */
            this.embeddingList = [];

            /** llama.cpp ヘルスチェック間隔 (ミリ秒) */
            this.healthCheckTiming = DEFAULT_HEALTH_CHECK_TIMING;

            /**
             * llama.cpp サーバー1台あたりの同時接続数上限のデフォルト値.
             * embeddingList / inferenceList の各エントリで "maxConnectCount" が
             * 個別指定されていない場合にこの値が使われる.
             */
            this.maxConnectCount = DEFAULT_MAX_CONNECT_COUNT;

            /**
             * embeddingList / inferenceList の各エントリで "model" が個別指定
             * されていない場合に使われるデフォルトのモデル名 (未設定: null).
             * OpenAI / ルーターモード等、モデル指定が必須な接続先向け.
             */
            this.model = null;

            /**
             * embeddingList / inferenceList の各エントリで "apiKey" が個別指定
             * されていない場合に使われるデフォルトのAPIキー (未設定: null).
             * 指定時は Authorization: Bearer {apiKey} ヘッダーを送信する.
             */
            this.apiKey = null;

            /**
             * embeddingList / inferenceList の各エントリで "apiType" が個別指定
             * されていない場合に使われるデフォルトの接続先種別.
             * "llamacpp" (既定) または "openai" ("openai"はヘルスチェック非対応).
             */
            this.apiType = API_TYPE_LLAMACPP;

            // ─── fetchタイムアウト ───────────────────────────────────────
            this.fetchTimeout = DEFAULT_FETCH_TIMEOUT;

            // ─── チャンク設定 ───────────────────────────────────────
            /** チャンクの最大文字数 */
            this.chunkSize = DEFAULT_JP_CHANK_SIZE;

            /**
             * 次チャンクに引き継ぐオーバーラップ文字数.
             * デフォルトは chunkSize の 10%.
             */
            this.overlapSize = chunkSizeToOverlapSize(DEFAULT_JP_CHANK_SIZE);

            // ─── サマリー設定 ───────────────────────────────────────
            /**
             * サマリー生成時の Temperature パラメータ値.
             *
             * Temperature は LLM が次のトークンを選ぶときの「ランダム性」を制御する.
             * 0 に近いほど決定的 (毎回同じ答え) になり、大きいほど創造的になる.
             *
             *   0.1 - 0.3 : 正確性重視 (事実・指示の回答)
             *   0.7 - 0.8 : バランス重視 (対話・説明)
             *   1.0 - 1.2 : 創造性重視 (物語・創作)
             *
             * RAG では正確性重視のため 0.5 をデフォルトとする.
             */
            this.summaryTemperature = DEFAULT_SUMMARY_TEMPERATURE;

            /**
             * サマリー問い合わせ時の推論モードのOn/Offを設定します.
             *  - true: 推論モードをONで実行します.
             *  - false: 推論モードをOFFで実行します.
             *  - null or undefoned: 実行先の設定に依存します(通常はON).
             * ※ llama-server の実行モード `--reasoning off` の場合は、この定義を設定
             *    しても必ず false 扱いになるので、通常は on を指定して下さい.
             */
            this.summaryReasoning = null;

            // ─── RAG リクエスト設定 ─────────────────────────────────

            /** RAG 推論時の Temperature */
            this.ragTemperature = DEFAULT_RAG_TEMPERATURE;

            /** ベクトル検索の最大取得件数 */
            this.vectorSearchLength = DEFAULT_VECTOR_SEARCH_LENGTH;

            /**
             * 文書一覧API(GET /api/groups/:group/documents)でページングを行う際の
             * 1ページあたりの件数デフォルト値. リクエストで pageSize が指定された場合はそちらを優先する.
             */
            this.documentsPageSize = DEFAULT_DOCUMENTS_PAGE_SIZE;

            /**
             * ハイブリッド検索(文字2-gramによるキーワードスコアをコサイン類似度に
             * 合成する)のOn/Offを設定します. デフォルトON.
             * embeddingだけでは固有名詞等の完全一致検索に弱い場合を補うためのもの.
             */
            this.hybridSearch = DEFAULT_HYBRID_SEARCH;

            /**
             * ハイブリッド検索のキーワードスコアの重み (0〜1).
             * 最終スコア = (1 - w) * ベクトルスコア + w * キーワードスコア.
             */
            this.hybridKeywordWeight = DEFAULT_HYBRID_KEYWORD_WEIGHT;

            /**
             * 検索ログ(質問文・引用文書一覧等)をSQLite(metaStore.js)に記録するかどうか.
             * デフォルトOFF (質問文などの実データが蓄積されるため、明示的な opt-in とする).
             */
            this.searchLogEnabled = false;

            /** RAG プロンプトに含めるチャンク数 */
            this.ragRequestChunkLength = DEFAULT_RAG_REQUEST_CHANK_LENGTH;

            /**
             * RAG プロンプト内の 1 チャンク分フォーマット.
             * getRagRequestChunk() 経由で使用すること.
             * プレースホルダー:  {{no}}, {{name}}, {{url}}, {{score}}, {{summary}}
             */
            this.ragRequestChunkFormat = DEFAULT_RAG_REQUEST_CHUNK_FORMAT;

            /**
             * RAGのリランキング(LLMによる候補文書の再順位付け)のOn/Offを設定します.
             * ベクトル検索で絞られた候補文書に対し、RAGプロンプトに含める前に
             * LLMで質問との関連度順に並び替える. デフォルトON. 追加のLLM推論が
             * 1回発生するため、レイテンシ・コストを避けたい場合は false にする.
             */
            this.ragRerank = DEFAULT_RAG_RERANK;

            /**
             * リランキング対象とする候補文書数の上限.
             * 候補文書 (targetList) がこの件数を超える場合、ベクトルスコア上位からこの
             * 件数までをリランキング対象とし、超えた分は元のスコア順のまま後方に維持する.
             */
            this.rerankCandidateLength = DEFAULT_RERANK_CANDIDATE_LENGTH;

            /**
             * rag問い合わせ時の推論モードのOn/Offを設定します.
             *  - true: 推論モードをONで実行します.
             *  - false: 推論モードをOFFで実行します.
             *  - null or undefoned: 実行先の設定に依存します(通常はON).
             * ※ llama-server の実行モード `--reasoning off` の場合は、この定義を設定
             *    しても必ず false 扱いになるので、通常は on を指定して下さい.
             */
            this.ragReasoning = null;

            // ─── その他 ─────────────────────────────────

            /**
             * プロセス間ロックタイムアウト.
             */
            this.lockTimeout = -1;

            /**
             * ローカルログ (localLog.js) の出力先ディレクトリ.
             */
            this.logDir = DEFAULT_LOG_DIR;

            /**
             * ローカルログ (localLog.js) の出力先ファイル名 (拡張子抜き).
             */
            this.logFile = DEFAULT_LOG_FILE;

            /**
             * ローカルログ (localLog.js) のファイル出力レベル.
             * trace / debug / info / warn / error / none のいずれか.
             */
            this.logLevel = DEFAULT_LOG_LEVEL;

            /**
             * apiServer.js が文書登録時に「url未指定」の場合に自動発行する
             * 参照URLのベースURL (例: "https://example.com:3000", 末尾スラッシュ無し).
             * 未設定 (null) の場合は、リクエストの Host ヘッダーから組み立てる.
             * リバースプロキシ等の背後で動かす場合、外部から実際に到達可能な
             * アドレスと Host ヘッダーが一致しないことがあるため、その場合に指定する.
             */
            this.publicBaseUrl = null;

            // configファイルをロードしたかのフラグ.
            this.loadConfigFlag = false;
        }

        /**
         * RAG プロンプト内の 1 チャンク分のメッセージ文字列を生成して返す.
         *
         * 複数チャンクを連結する場合は、このメソッドを繰り返し呼び出して
         * 結果を連結してから getRagRequest() に渡す.
         *
         * @param  {string} src      オリジナルの問い合わせ定義文字を設定します
         *                           (指定しない場合はコンフィグ値を利用).
         * @param  {number} no       文書順位番号.
         * @param  {string} name     文書名 (docName)
         * @param  {string} url      文書 URL
         * @param  {number} score    類似度スコア
         * @param  {string} summary  文書のサマリーテキスト
         * @param  {string} chunkeds ベクトル座標元のテキスト塊群.
         * @return {string}
         */
        getRagRequestChunk(src, no, name, url, score, summary, chunkeds) {
            src = src || this.ragRequestChunkFormat;
            return Conv.keyValueTemplate(
                src,
                "no",
                no,
                "name",
                name,
                "url",
                url,
                "score",
                score,
                "summary",
                summary,
                "chunkeds",
                chunkeds,
            );
        }

        /**
         * 設定ファイル (JSON) を読み込んでコンフィグを更新する.
         *
         * ファイルパスを省略した場合はデフォルトパス (./config.json) を使用する.
         *
         * @param {string} [configPath='./']          設定ファイルのディレクトリパス
         * @param {string} [configFile='config.json'] 設定ファイル名
         * @param {boolean} notFileNoError ファイルが存在しない場合エラー返却しない場合は true.
         */
        loadConfig(configPath, configFile, notFileNoError) {
            const path = (configPath || DEFAULT_CONFIG_PATH).replace(/\/$/, "");
            const file = configFile || DEFAULT_CONFIG_FILE;
            // ファイルが存在しない場合.
            if (!fs.existsSync(path + "/" + file)) {
                // ファイル非存在でエラーなしで処理する場合.
                if (notFileNoError == true) {
                    // ロードコンフィグ完了.
                    this.loadConfigFlag = true;
                    return;
                }
                // ファイルが存在しない場合はエラー.
                throw new Error(
                    "The target configuration file does not exist: " +
                        path +
                        "/" +
                        file,
                );
            }
            // json内のコメントを除去してJSONパース.
            let jsonTxt = stripComments(
                fs.readFileSync(path + "/" + file, "utf8"),
            );
            // コメントを除去して、JSONパース.
            this.setConfig(Conv.parseJson(jsonTxt));
            // ロードコンフィグ完了.
            this.loadConfigFlag = true;
        }

        /**
         * JSON オブジェクトからコンフィグ値を読み込んで反映する.
         *
         * loadConfig() の内部処理だが、テスト時などに直接オブジェクトを
         * 渡して設定できるよう public にしている.
         *
         * 【設定 JSON のフォーマット例 (config.json)】
         * {
         *   "embeddingList": { "url": "http://192.168.0.200:8081" },
         *   "inferenceList": [
         *       { "url": "http://192.168.0.201:8080" },
         *       { "url": "http://192.168.0.202:8080" }
         *   ],
         *   "dirPath":               "./",
         *   "vectorStorePath":       "./vectorStore",
         *   "srcDocumentPath":       "./documents",
         *   "chunkSize":             500,
         *   "overlapSize":           50,
         *   "vectorSearchLength":    10,
         *   "ragRequestChunkLength": 5,
         *   "documentsPageSize":     50
         * }
         *
         * @param {Object} json  設定内容のオブジェクト
         */
        setConfig(json) {
            // ─── llama.cpp / OpenAI互換 接続先 ─────────────────────────
            // 各接続先エントリ未指定時のデフォルト値 (エントリ生成前に確定させる).
            this.maxConnectCount = Conv.getInt(
                _mapToGetValue(json, "maxConnectCount", this.maxConnectCount),
            );
            this.model = _mapToGetValue(json, "model", this.model);
            this.apiKey = _mapToGetValue(json, "apiKey", this.apiKey);
            this.apiType = _mapToGetValue(json, "apiType", this.apiType);
            const connectionDefaults = {
                maxConnectCount: this.maxConnectCount,
                model: this.model,
                apiKey: this.apiKey,
                apiType: this.apiType,
            };
            _getLlamaCppInfoList(
                this.embeddingList,
                json,
                "embeddingList",
                LLAMA_CPP_TYPE_EMBEDDING,
                connectionDefaults,
            );
            _getLlamaCppInfoList(
                this.inferenceList,
                json,
                "inferenceList",
                LLAMA_CPP_TYPE_INFERENCE,
                connectionDefaults,
            );
            this.healthCheckTiming = Conv.getLong(
                _mapToGetValue(
                    json,
                    "healthCheckTiming",
                    this.healthCheckTiming,
                ),
            );

            // ─── fetchタイムアウト ───────────────────────────────────────
            this.fetchTimeout = Conv.getInt(
                _mapToGetValue(json, "fetchTimeout", this.fetchTimeout),
            );

            // ─── ファイルパス ───────────────────────────────────────
            this.dirPath = Conv.getString(
                _mapToGetValue(json, "dirPath", this.dirPath),
            );
            this.vectorStorePath = Conv.getString(
                _mapToGetValue(json, "vectorStorePath", this.vectorStorePath),
            );
            this.srcDocumentPath = Conv.getString(
                _mapToGetValue(json, "srcDocumentPath", this.srcDocumentPath),
            );

            // ─── チャンク設定 ───────────────────────────────────────
            this.chunkSize = Conv.getInt(
                _mapToGetValue(json, "chunkSize", this.chunkSize),
            );
            // overlapSize がJSONで設定されている場合.
            if (json.overlapSize != null && json.overlapSize != undefined) {
                this.overlapSize = Conv.getInt(
                    _mapToGetValue(json, "overlapSize", this.overlapSize),
                );
            } else {
                // overlapSize がJSONで設定されていない場合.
                this.overlapSize = chunkSizeToOverlapSize(this.chunkSize);
            }

            // ─── サマリー設定 ───────────────────────────────────────
            this.summaryTemperature = Conv.getFloat(
                _mapToGetValue(
                    json,
                    "summaryTemperature",
                    this.summaryTemperature,
                ),
            );
            this.summaryReasoning = _mapToGetValue(
                json,
                "summaryReasoning",
                this.summaryReasoning,
            );
            if (
                this.summaryReasoning == true ||
                this.summaryReasoning == false
            ) {
                this.summaryReasoning = Conv.getBoolean(this.summaryReasoning);
            } else {
                this.summaryReasoning = null;
            }

            // ─── RAG リクエスト設定 ─────────────────────────────────
            this.vectorSearchLength = Conv.getInt(
                _mapToGetValue(
                    json,
                    "vectorSearchLength",
                    this.vectorSearchLength,
                ),
            );
            this.documentsPageSize = Conv.getInt(
                _mapToGetValue(
                    json,
                    "documentsPageSize",
                    this.documentsPageSize,
                ),
            );
            this.hybridSearch = Conv.getBoolean(
                _mapToGetValue(json, "hybridSearch", this.hybridSearch),
            );
            this.hybridKeywordWeight = Conv.getFloat(
                _mapToGetValue(
                    json,
                    "hybridKeywordWeight",
                    this.hybridKeywordWeight,
                ),
            );
            this.searchLogEnabled = Conv.getBoolean(
                _mapToGetValue(json, "searchLogEnabled", this.searchLogEnabled),
            );
            this.ragRequestChunkLength = Conv.getInt(
                _mapToGetValue(
                    json,
                    "ragRequestChunkLength",
                    this.ragRequestChunkLength,
                ),
            );
            this.ragTemperature = Conv.getFloat(
                _mapToGetValue(json, "ragTemperature", this.ragTemperature),
            );
            this.ragRequestChunkFormat = Conv.getString(
                _mapToGetValue(
                    json,
                    "ragRequestChunkFormat",
                    this.ragRequestChunkFormat,
                ),
            );
            this.ragReasoning = _mapToGetValue(
                json,
                "ragReasoning",
                this.ragReasoning,
            );
            if (this.ragReasoning == true || this.ragReasoning == false) {
                this.ragReasoning = Conv.getBoolean(this.ragReasoning);
            } else {
                this.ragReasoning = null;
            }
            this.ragRerank = Conv.getBoolean(
                _mapToGetValue(json, "ragRerank", this.ragRerank),
            );
            this.rerankCandidateLength = Conv.getInt(
                _mapToGetValue(
                    json,
                    "rerankCandidateLength",
                    this.rerankCandidateLength,
                ),
            );
            // ─── その他 ─────────────────────────────────
            this.lockTimeout = Conv.getInt(
                _mapToGetValue(json, "lockTimeout", this.lockTimeout),
            );

            // ─── ローカルログ ─────────────────────────────
            this.logDir = Conv.getString(
                _mapToGetValue(json, "logDir", this.logDir),
            );
            this.logFile = Conv.getString(
                _mapToGetValue(json, "logFile", this.logFile),
            );
            this.logLevel = Conv.getString(
                _mapToGetValue(json, "logLevel", this.logLevel),
            );

            // ─── apiServer ────────────────────────────────
            this.publicBaseUrl = _mapToGetValue(
                json,
                "publicBaseUrl",
                this.publicBaseUrl,
            );
            this.publicBaseUrl =
                this.publicBaseUrl != null
                    ? Conv.getString(this.publicBaseUrl).replace(/\/+$/, "")
                    : null;
        }

        /**
         * localLog.js の setting() にそのまま渡せる形式で
         * ログ出力設定を返す.
         *
         * @return {{dir: string, file: string, level: string}}
         */
        getLogSetting() {
            return {
                dir: this.logDir,
                file: this.logFile,
                level: this.logLevel,
            };
        }

        /**
         * 推論サーバーリストから利用可能な baseUrl を 1 件返す.
         *
         * healthy かつ 同時接続数上限未満のサーバの中から、最も useCount の
         * 少ないサーバを ConnectMan 経由で選択する.
         *
         * @return {LlamaCppInfo} 推論サーバーの baseUrl
         * @throws {Error}        inferenceList が空、または利用可能なサーバが無い場合
         */
        getInferenceURL() {
            if (this.inferenceList.length === 0) {
                throw new Error(
                    "inferenceList is empty. Call loadConfig() first.",
                );
            }
            // 対象LlamaCppInfoサーバ情報を返却.
            return ConnectMan.acquire(this.inferenceList);
        }

        /**
         * 埋め込みサーバーリストから利用可能な baseUrl を 1 件返す.
         *
         * healthy かつ 同時接続数上限未満のサーバの中から、最も useCount の
         * 少ないサーバを ConnectMan 経由で選択する.
         *
         * @return {LlamaCppInfo} 埋め込みサーバーの baseUrl
         * @throws {Error}        embeddingList が空、または利用可能なサーバが無い場合
         */
        getEmbeddingURL() {
            if (this.embeddingList.length === 0) {
                throw new Error(
                    "embeddingList is empty. Call loadConfig() first.",
                );
            }
            // 対象LlamaCppInfoサーバ情報を返却.
            return ConnectMan.acquire(this.embeddingList);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // jsonコメント除去.
    // ═══════════════════════════════════════════════════════════════

    /**
     * 指定位置の文字がバックスラッシュでエスケープされているかを判定する内部関数.
     *
     * 直前に連続するバックスラッシュの数が奇数の場合はエスケープされている.
     * 例: \\" → バックスラッシュ自体がエスケープされているので " は有効な区切り
     *
     * Java 版の isEscaped(str, i) に相当.
     *
     * @param  {string} str  対象文字列
     * @param  {number} i    確認する文字のインデックス
     * @return {boolean}     true = エスケープされている
     */
    function _isEscaped(str, i) {
        let count = 0;
        let j = i - 1;
        while (j >= 0 && str[j] === "\\") {
            count++;
            j--;
        }
        // バックスラッシュの数が奇数 → エスケープされている
        return count % 2 === 1;
    }

    /**
     * 文字列からコメントを除去して返す.
     *
     * ブロックコメント内・行コメント内の改行は保持する.
     * (行番号がずれないようにするため Java 版と同様の仕様)
     *
     * @param  {string}  str  処理対象の文字列
     * @param  {boolean} h2   true の場合、-- 形式のコメントも除去する (SQL 用)
     * @return {string}       コメントを除去した文字列
     */
    const stripComments = function (str, h2) {
        h2 = h2 == true;
        if (!str) return "";

        const len = str.length;
        let buf = "";
        let quote = -1; // -1: クォーテーション外 / それ以外: クォーテーション文字コード
        let comment = -1; // -1: コメント外 / 1: 行コメント / 2: ブロックコメント

        for (let i = 0; i < len; i++) {
            const c = str[i];

            // ── コメント内 ──────────────────────────────────────────
            if (comment !== -1) {
                if (comment === 1) {
                    // 行コメント (//, #, --): 改行で終了
                    if (c === "\n") {
                        buf += c;
                        comment = -1;
                    }
                    // 改行以外はバッファに追加しない (= コメントを除去)
                } else {
                    // ブロックコメント (/* ... */): */ で終了
                    if (c === "\n") {
                        // 改行はブロックコメント内でも保持する
                        buf += c;
                    } else if (c === "*" && i + 1 < len && str[i + 1] === "/") {
                        // */ を検出したらブロックコメント終了
                        i++; // '/' をスキップ
                        comment = -1;
                    }
                    // それ以外はバッファに追加しない
                }
                continue;
            }

            // ── クォーテーション内 ──────────────────────────────────
            if (quote !== -1) {
                buf += c;
                // 対応するクォーテーション文字かつエスケープされていなければ終了
                if (c === String.fromCharCode(quote) && !_isEscaped(str, i)) {
                    quote = -1;
                }
                continue;
            }

            // ── 通常文字 ────────────────────────────────────────────

            // クォーテーション開始 (" または ')
            if ((c === '"' || c === "'") && !_isEscaped(str, i)) {
                quote = c.charCodeAt(0);
                buf += c;
                continue;
            }

            // // または /* ... */
            if (c === "/" && i + 1 < len) {
                const n = str[i + 1];
                if (n === "/") {
                    comment = 1;
                    continue;
                } // 行コメント開始
                if (n === "*") {
                    comment = 2;
                    i++;
                    continue;
                } // ブロックコメント開始 ('*' をスキップ)
            }

            // -- (h2=true の場合のみ有効: SQL スタイル行コメント)
            if (h2 && c === "-" && i + 1 < len && str[i + 1] === "-") {
                comment = 1;
                continue;
            }

            // # (Shell / Python スタイル行コメント)
            if (c === "#") {
                comment = 1;
                continue;
            }

            buf += c;
        }

        return buf;
    };

    // ═══════════════════════════════════════════════════════════════
    // シングルトンインスタンス
    // ═══════════════════════════════════════════════════════════════

    /** @type {Config} シングルトンインスタンス */
    const _instance = new Config();

    /**
     * Config のシングルトンインスタンスを返す.
     *
     * @return {Config}
     */
    const getInstance = function () {
        // コンフィグファイルを読み込んでない場合.
        if (_instance.loadConfigFlag == false) {
            // デフォルトのコンフィグファイルを取得する.
            // これにより、最初の１回目だけは、コンフィグ定義を
            // 自動的に読み込むようにする.
            _instance.loadConfig(null, null, true);
        }
        return _instance;
    };

    // ═══════════════════════════════════════════════════════════════
    // exports
    // ═══════════════════════════════════════════════════════════════
    module.exports = {
        LlamaCppInfo,
        LLAMA_CPP_TYPE_INFERENCE,
        LLAMA_CPP_TYPE_EMBEDDING,
        API_TYPE_LLAMACPP,
        API_TYPE_OPENAI,
        CHUNK_SIZE_TO_OVERLAP_COEFFICIENT,
        chunkSizeToOverlapSize,
        getInstance,
    };
})();
