/**
 * config.js
 *
 * RAG システム全体の設定を管理するシングルトンモジュール.
 *
 * 【設定カテゴリ】
 *   - ファイルパス        : vectorStore・参照文書の格納先
 *   - llama.cpp 接続先   : 埋め込み・推論それぞれのサーバー URL リスト
 *   - チャンク設定        : チャンクサイズ・オーバーラップサイズ
 *   - サマリー設定        : 要約生成のプロンプトフォーマットと Temperature
 *   - RAG リクエスト設定  : 検索件数・チャンク数・プロンプトフォーマット
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
 *   // サマリー問い合わせプロンプトを生成
 *   const prompt = cfg.getSummaryRequest('要約したいテキスト');
 *
 *   // RAG 問い合わせプロンプトを生成
 *   const chunk  = cfg.getRagRequestChunk(1, 'doc1', 'https://...', 0.98, 'サマリー文');
 *   const prompt = cfg.getRagRequest(chunk, 'ユーザーの質問');
 */
(function () {
    "use strict";

    const fs = require("fs");
    const Conv = require("./conv");

    // ═══════════════════════════════════════════════════════════════
    // デフォルト定数(Const).
    // ═══════════════════════════════════════════════════════════════

    /** llama.cpp タイプ: 推論モード */
    const LLAMA_CPP_TYPE_INFERENCE = 0;

    /** llama.cpp タイプ: 組み込み (埋め込み) モード */
    const LLAMA_CPP_TYPE_EMBEDDING = 1;

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
    const DEFAULT_SUMMARY_TEMPERATURE = 0.5;

    /**
     * RAG 推論の Temperature デフォルト値 (正確性重視寄り: 0.15).
     * RAG では参考文書に忠実に答えさせるため低めに設定する.
     */
    const DEFAULT_RAG_TEMPERATURE = 0.5;

    /**
     * サマリー問い合わせプロンプトのデフォルトフォーマット.
     *
     * <reasoning_mode> タグで推論モードを指定し、テキストのサマリーを日本語で生成させる.
     *
     * プレースホルダー:
     *   {{text}}          : サマリー化対象のテキスト
     */
    const SUMMARY_REQUEST_FORMAT =
        "# 以下の内容のサマリーを日本語で詳しくまとめて頂きたい。\n\n ---\n\n {{text}}";

    /** ベクトル検索の最大取得件数デフォルト値 */
    const DEFAULT_VECTOR_SEARCH_LENGTH = 30;

    /** RAG リクエストに含めるチャンク数のデフォルト値 */
    const DEFAULT_RAG_REQUEST_CHANK_LENGTH = 6;

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
        "##【{{no}} 参考文書名:{{name}}】(参考文書URL: {{url}}, 類似度:{{score}})\n" +
        "```\n{{summary}}\n```\n{{chunkeds}}";

    /**
     * RAG 問い合わせプロンプト全体のフォーマットのデフォルト値.
     *
     * 回答できない場合は「情報はありませんでした。」のみを返すよう指示している.
     * 回答できる場合は参照文書一覧を末尾にマークダウン形式で列挙させる.
     *
     * プレースホルダー:
     *   {{chunkMessages}}  : getRagRequestChunk() で生成したチャンク群を連結した文字列
     *   {{message}}        : ユーザーの質問文
     */
    const DEFAULT_RAG_REQUEST_FORMAT =
        "# あなたは日本語で回答する専門家アシスタントです。\n" +
        "　以下の参考文書を使って、質問者の意見を汲んで「分かりやすく質問の趣旨を詳らか」に答えてください。\n" +
        "　参考文書の内容に対して該当質問の回答が無く質問に答えられない場合は「情報はありませんでした。」と必ず答えてください。\n" +
        "　一方で「情報はありませんでした。」以外の回答の場合は、以下の指示に従ってください。\n" +
        "    - 回答作成で参照した参考文書名を、リスト型で「URLリンクのmarkdown形式」で行い、\n" +
        "    1から始まるリスト番号を「参考文書名」の前に必ず記載してください。\n" +
        "    - 具体的には以下のマークダウンのフォーマットで記載してください。\n" +
        "      ```# 参照文書一覧\n" +
        "        {{リスト番号}}. [{{参考文書名}}]({{参考文書URL}})```\n" +
        "    - 「参考文書」は、回答内容の「一番最後の行に列挙」タイトルとして「参照文書一覧」を必ず記載してください。\n" +
        "    - 回答に関する参照文書一覧には、利用・参照しなかった「参考文書名」は列挙しないでください。\n" +
        "    - 回答が「情報はありませんでした。」以外の場合は「情報はありませんでした。」の文字を利用しないでください。\n" +
        "    \n" +
        "以上の条件で回答してください。\n" +
        "---\n\n" +
        "{{chunkMessages}}\n" +
        "質問: {{message}}\n" +
        "回答:";

    /** デフォルトの設定ファイルディレクトリパス */
    const DEFAULT_CONFIG_PATH = "./";

    /** デフォルトの設定ファイル名 */
    const DEFAULT_CONFIG_FILE = "glint.json";

    // ═══════════════════════════════════════════════════════════════
    // LlamaCppInfo
    //   llama.cpp サーバー 1 台分の接続情報を保持する値オブジェクト.
    // ═══════════════════════════════════════════════════════════════
    class LlamaCppInfo {
        /**
         * @param {number} llamaType  サーバー種別
         *                            0 = 推論 (LLAMA_CPP_TYPE_INFERENCE)
         *                            1 = 埋め込み (LLAMA_CPP_TYPE_EMBEDDING)
         * @param {string} baseUrl    接続先ベース URL (例: 'http://192.168.1.10:8080')
         */
        constructor(llamaType, baseUrl) {
            /** @type {number} 0=推論, 1=埋め込み, -1=不明 */
            this.llamaType = llamaType !== undefined ? llamaType : -1;
            /** @type {string} ベース URL */
            this.baseUrl = baseUrl !== undefined ? baseUrl : null;
            // 利用中カウント.
            this.useCount = 0;
        }

        // 利用を開始する.
        startUse() {
            this.useCount++;
        }

        // 利用終了.
        endUse() {
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
     * @param  {Object} map   { url: '...' } 形式のオブジェクト
     * @param  {number} type  LLAMA_CPP_TYPE_INFERENCE / LLAMA_CPP_TYPE_EMBEDDING
     * @param  {number} no    エントリのインデックス (エラーメッセージ用)
     * @return {LlamaCppInfo}
     * @throws {Error}        url が空の場合
     */
    const _getLlamaCppInfo = function (map, type, no) {
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
        return new LlamaCppInfo(type, url);
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
     * @return {LlamaCppInfo[]}
     * @throws {Error} キーが存在しない場合、または値の型が不正な場合
     */
    const _getLlamaCppInfoList = function (out, map, name, type) {
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
                out.push(_getLlamaCppInfo(info[i], type, i));
            }
        } else if (typeof info === "object") {
            // 単一エントリの場合
            out.push(_getLlamaCppInfo(info, type, 0));
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

    // 最適なLlamaCppサーバを返却.
    const _getOptimalLlamaCppInfo = function (list) {
        let ret = null;
        if (list.length == 1) {
            ret = list[0];
        } else {
            const len = list.length;
            for (let i = 0; i < len; i++) {
                if (ret == null) {
                    ret = list[i];
                } else if (ret.useCount > list[i].useCount) {
                    ret = list[i];
                }
            }
        }
        // 一番アクセス数の少ないサーバを返却.
        ret.startUse();
        return ret;
    };

    // ═══════════════════════════════════════════════════════════════
    // Config (シングルトン)
    // ═══════════════════════════════════════════════════════════════

    class Config {
        constructor() {
            // ─── ファイルパス ───────────────────────────────────────
            /** ディレクトリパス.  */
            this.dirPath = DEFAULT_VECTOR_STORE_PATH;

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
             * サマリー問い合わせプロンプトフォーマット.
             * getSummaryRequest() 経由で使用すること.
             * プレースホルダー: {{text}}
             */
            this.summaryRequestFormat = SUMMARY_REQUEST_FORMAT;

            // ─── RAG リクエスト設定 ─────────────────────────────────

            /** RAG 推論時の Temperature */
            this.ragTemperature = DEFAULT_RAG_TEMPERATURE;

            /** ベクトル検索の最大取得件数 */
            this.vectorSearchLength = DEFAULT_VECTOR_SEARCH_LENGTH;

            /** RAG プロンプトに含めるチャンク数 */
            this.ragRequestChunkLength = DEFAULT_RAG_REQUEST_CHANK_LENGTH;

            /**
             * RAG プロンプト内の 1 チャンク分フォーマット.
             * getRagRequestChunk() 経由で使用すること.
             * プレースホルダー:  {{no}}, {{name}}, {{url}}, {{score}}, {{summary}}
             */
            this.ragRequestChunkFormat = DEFAULT_RAG_REQUEST_CHUNK_FORMAT;

            /**
             * RAG プロンプト全体のフォーマット.
             * getRagRequest() 経由で使用すること.
             * プレースホルダー: {{chunkMessages}}, {{message}}
             */
            this.ragRequestFormat = DEFAULT_RAG_REQUEST_FORMAT;

            // ─── その他 ─────────────────────────────────

            // configファイルをロードしたかのフラグ.
            this.loadConfigFlag = false;
        }

        /**
         * サマリー問い合わせプロンプト文字列を生成して返す.
         *
         * summaryRequestFormat 内の {{text}} を
         * Conv.keyValueTemplate() で置き換える.
         * @param  {string} src   オリジナルの問い合わせ定義文字を設定します
         *                        (指定しない場合はコンフィグ値を利用).
         * @param  {string} text  要約対象のテキスト
         * @return {string}       llama.cpp に渡すプロンプト文字列
         */
        getSummaryRequest(src, text) {
            src = src || this.summaryRequestFormat;
            return Conv.keyValueTemplate(src, "text", text);
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
         * RAG 問い合わせプロンプト全体を生成して返す.
         *
         * @param  {string} src            オリジナルの問い合わせ定義文字を設定します
         *                                 (指定しない場合はコンフィグ値を利用).
         * @param  {string} chunkMessages  getRagRequestChunk() の結果を連結した文字列
         * @param  {string} message        ユーザーの質問文
         * @return {string}                llama.cpp に渡すプロンプト文字列
         */
        getRagRequest(src, chunkMessages, message) {
            src = src || this.ragRequestFormat;
            return Conv.keyValueTemplate(
                src,
                "chunkMessages",
                chunkMessages,
                "message",
                message,
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
            const raw = fs.readFileSync(path + "/" + file, "utf8");
            this.setConfig(JSON.parse(raw));
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
         *   "ragRequestChunkLength": 5
         * }
         *
         * @param {Object} json  設定内容のオブジェクト
         */
        setConfig(json) {
            // ─── llama.cpp 接続先 ───────────────────────────────────
            _getLlamaCppInfoList(
                this.embeddingList,
                json,
                "embeddingList",
                LLAMA_CPP_TYPE_EMBEDDING,
            );
            _getLlamaCppInfoList(
                this.inferenceList,
                json,
                "inferenceList",
                LLAMA_CPP_TYPE_INFERENCE,
            );
            this.healthCheckTiming = Conv.getLong(
                _mapToGetValue(
                    json,
                    "healthCheckTiming",
                    this.healthCheckTiming,
                ),
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
            this.overlapSize = Conv.getInt(
                _mapToGetValue(json, "overlapSize", this.overlapSize),
            );

            // ─── サマリー設定 ───────────────────────────────────────
            this.summaryTemperature = Conv.getFloat(
                _mapToGetValue(
                    json,
                    "summaryTemperature",
                    this.summaryTemperature,
                ),
            );
            this.summaryRequestFormat = Conv.getString(
                _mapToGetValue(
                    json,
                    "summaryRequestFormat",
                    this.summaryRequestFormat,
                ),
            );

            // ─── RAG リクエスト設定 ─────────────────────────────────
            this.vectorSearchLength = Conv.getInt(
                _mapToGetValue(
                    json,
                    "vectorSearchLength",
                    this.vectorSearchLength,
                ),
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
            this.ragRequestFormat = Conv.getString(
                _mapToGetValue(json, "ragRequestFormat", this.ragRequestFormat),
            );
        }

        /**
         * 推論サーバーリストから利用可能な baseUrl を 1 件返す.
         *
         * 現状はリストの先頭を返す簡易実装.
         * 将来的にはラウンドロビンやヘルスチェック結果による選択に拡張できる.
         *
         * @return {LlamaCppInfo} 推論サーバーの baseUrl
         * @throws {Error}        inferenceList が空の場合
         */
        getInferenceURL() {
            if (this.inferenceList.length === 0) {
                throw new Error(
                    "inferenceList is empty. Call loadConfig() first.",
                );
            }
            // 対象LlamaCppInfoサーバ情報を返却.
            return _getOptimalLlamaCppInfo(this.inferenceList);
        }

        /**
         * 埋め込みサーバーリストから利用可能な baseUrl を 1 件返す.
         *
         * @return {LlamaCppInfo} 埋め込みサーバーの baseUrl
         * @throws {Error}        embeddingList が空の場合
         */
        getEmbeddingURL() {
            if (this.embeddingList.length === 0) {
                throw new Error(
                    "embeddingList is empty. Call loadConfig() first.",
                );
            }
            // 対象LlamaCppInfoサーバ情報を返却.
            return _getOptimalLlamaCppInfo(this.embeddingList);
        }
    }

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
        CHUNK_SIZE_TO_OVERLAP_COEFFICIENT,
        chunkSizeToOverlapSize,
        getInstance,
    };
})();
