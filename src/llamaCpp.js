/**
 * LlamaCpp.js
 *
 * llama.cpp サーバーへの HTTP アクセス処理をまとめたモジュール.
 *
 * 【llama.cpp とは】
 *   C++ で実装されたローカル LLM (大規模言語モデル) 推論エンジン.
 *   --server オプションで OpenAI 互換の REST API サーバーを起動できる.
 *   このモジュールはそのサーバーに対して HTTP POST を送り、
 *   「埋め込みベクトルの取得」と「テキスト推論 (チャット補完)」を行う.
 *
 * 【エンドポイント】
 *   GET  /health              サーバーの生存確認
 *   POST /v1/embeddings       テキスト → 埋め込みベクトル変換
 *   POST /v1/chat/completions テキスト推論 (チャット補完)
 *
 * 【使い方】
 *   const LlamaCpp = require('./LlamaCpp');
 *
 *   // ヘルスチェック
 *   const ok = await LlamaCpp.health('http://localhost:8080');
 *
 *   // 埋め込みベクトル取得
 *   const emb = await LlamaCpp.getEmbedding('http://localhost:8080', 'こんにちは');
 *
 *   // 推論 (テキストだけ取得)
 *   const msg = await LlamaCpp.getInferenceMessage('http://localhost:8080', '日本の首都は?');
 */
(function () {
    "use strict";

    const Conv = require("./conv");
    const Config = require("./config");

    // fetchタイムアウト: 15分.
    const _FETCH_TIMEOUT = 60000 * 15;

    // ═══════════════════════════════════════════════════════════════
    // 定数
    // ═══════════════════════════════════════════════════════════════

    /**
     * デフォルトの Temperature パラメータ値.
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
    const DEF_TEMPERATURE = 0.5;

    // ═══════════════════════════════════════════════════════════════
    // 内部ユーティリティ
    // ═══════════════════════════════════════════════════════════════

    /**
     * URL の末尾スラッシュを除去し、エンドポイント先頭のスラッシュを除去して
     * 完全な URL を組み立てる内部ヘルパー.
     *
     * 例: ('http://localhost:8080/', '/v1/embeddings') → 'http://localhost:8080/v1/embeddings'
     *
     * @param  {string} baseUrl   ベース URL (例: 'http://localhost:8080')
     * @param  {string} endpoint  エンドポイントパス (例: 'v1/embeddings' または '/v1/embeddings')
     * @return {string}           完全な URL
     */
    const _buildUrl = function (baseUrl, endpoint) {
        if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
        if (endpoint.startsWith("/")) endpoint = endpoint.slice(1);
        return baseUrl + "/" + endpoint;
    };

    /**
     * llama.cpp サーバーに JSON をボディとして POST し、レスポンスを返す内部関数.
     *
     * 【エラーハンドリング】
     *   レスポンス JSON に { error: { code, message } } が含まれる場合は
     *   Error をスローする.
     *
     * @param  {string}  baseUrl      ベース URL
     * @param  {string}  endpoint     エンドポイントパス
     * @param  {Object}  body         POST ボディ (JSON シリアライズ前の Object)
     * @param  {boolean} [rawText]    true の場合、JSON パースせずに文字列のまま返す
     * @return {Promise<Object|string>}  レスポンスの JSON オブジェクト (rawText=true の場合は文字列)
     * @throws {Error}   HTTP エラーまたはレスポンスに error フィールドが含まれる場合
     */
    const _fetch = async function (baseUrl, endpoint, body, rawText) {
        const conf = Config.getInstance();
        const url = _buildUrl(baseUrl, endpoint);
        const bodyStr = typeof body === "string" ? body : JSON.stringify(body);

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bodyStr,
            signal: AbortSignal.timeout(conf.fetchTimeout), // タイムアウト設定.
            keepalive: true,
        });

        const resText = await res.text();

        // rawText モードの場合は文字列をそのまま返す (JSON パース不要な場合)
        if (rawText) return resText;

        // JSON としてパース
        var json;
        try {
            json = JSON.parse(resText);
        } catch (e) {
            throw new Error("JSON parse error: " + resText);
        }

        // エラーレスポンスの確認.
        // llama.cpp は失敗時に { error: { code, message } } を返す.
        if (json && typeof json === "object" && json.error) {
            var err = json.error;
            if (err.code !== undefined && err.message !== undefined) {
                // code と message が分離できた場合
                throw new Error("[" + err.code + "] " + err.message);
            }
            // 分離できない場合は生のレスポンスをエラーメッセージにする
            throw new Error(resText);
        }

        return json;
    };

    // ═══════════════════════════════════════════════════════════════
    // ヘルスチェック
    // ═══════════════════════════════════════════════════════════════

    /**
     * llama.cpp サーバーの生存確認を行う.
     *
     * GET /health にアクセスし、接続できれば true、
     * 接続できない (タイムアウト・接続拒否など) 場合は false を返す.
     * エラーはスローせず false として吸収する.
     *
     * @param  {string}           baseUrl  ベース URL (例: 'http://localhost:8080')
     * @return {Promise<boolean>}          true = サーバーが利用可能
     */
    const health = async function (baseUrl) {
        if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
        try {
            await fetch(baseUrl + "/health");
            return true;
        } catch (e) {
            // 接続できない場合は false を返す (エラーはスローしない)
            return false;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // 埋め込みベクトル取得
    // ═══════════════════════════════════════════════════════════════

    /**
     * テキストを埋め込みベクトル (Float32Array) に変換して返す.
     *
     * llama.cpp の POST /v1/embeddings エンドポイントを使用する.
     *
     * 【リクエスト例】
     *   POST /v1/embeddings
     *   { "model": "embeddinggemma", "input": "テキスト" }
     *
     * 【レスポンス構造 (抜粋)】
     *   {
     *     "data": [
     *       { "embedding": [0.1, -0.3, ...], "index": 0 }
     *     ]
     *   }
     *   → data[0].embedding を Float32Array に変換して返す.
     *
     * @param  {string}             baseUrl  ベース URL
     * @param  {string}             text     ベクトル変換対象のテキスト
     * @return {Promise<Float32Array>}       埋め込みベクトル
     * @throws {Error}              サーバーエラーまたはレスポンス構造が不正な場合
     */
    const getEmbedding = async function (baseUrl, text) {
        var body = {
            model: "embeddinggemma", // llama.cpp で使用する埋め込みモデル名
            input: text,
            stream: false,
        };

        var result = await _fetch(baseUrl, "v1/embeddings", body);

        // レスポンスから data[0].embedding を取り出す
        var list = Conv.getList(Conv.getMap(result)["data"]);
        var embList = Conv.getList(Conv.getMap(list[0])["embedding"]);

        // number[] → Float32Array に変換して返す
        var len = embList.length;
        var ret = new Float32Array(len);
        for (var i = 0; i < len; i++) {
            ret[i] = Conv.getFloat(embList[i]);
        }
        return ret;
    };

    // ═══════════════════════════════════════════════════════════════
    // テキスト推論 (チャット補完)
    // ═══════════════════════════════════════════════════════════════

    /**
     * llama.cpp にテキスト推論を要求し、レスポンス全体の JSON を返す.
     *
     * temperature と maxTokens を省略した場合はデフォルト値が使われる.
     *
     * 【リクエスト例】
     *   POST /v1/chat/completions
     *   {
     *     "messages": [{ "role": "user", "content": "質問テキスト" }],
     *     "temperature": 0.3
     *   }
     *
     * 【レスポンス構造 (抜粋)】
     *   {
     *     "choices": [{ "message": { "role": "assistant", "content": "回答テキスト" } }],
     *     "usage": { ... },
     *     "timings": { ... }
     *   }
     *
     * @param  {string}  baseUrl      ベース URL
     * @param  {string}  prompt       質問テキスト
     * @param  {number}  [temperature=-1]  Temperature 値. 0 以下 or undefined の場合は
     *                                     デフォルト値を使用.
     * @param  {number}  [maxTokens=-1]    最大生成トークン数. 0 以下 or undefined の
     *                                     場合は指定なし.
     * @return {Promise<Object>}      /v1/chat/completions のレスポンス JSON
     * @throws {Error}   サーバーエラーの場合
     */
    const getInference = async function (
        baseUrl,
        prompt,
        temperature,
        maxTokens,
    ) {
        var body = {
            // messages は OpenAI 互換フォーマット: [{ role, content }] の配列
            messages: Conv.newList(
                Conv.newMap("role", "user", "content", prompt),
            ),
            // temperature が 0 より大きい場合は指定値、それ以外はデフォルト値を使用
            temperature:
                temperature !== undefined && temperature > 0
                    ? temperature
                    : DEF_TEMPERATURE,
            // ストリーム受信は行わない.
            stream: false,
        };
        // maxTokens が 0 より大きい場合のみボディに追加
        // (省略すると llama.cpp が自動で決定する)
        if (maxTokens !== undefined && maxTokens > 0) {
            body.max_tokens = maxTokens;
        }
        return _fetch(baseUrl, "v1/chat/completions", body);
    };

    /**
     * getInference() のレスポンス JSON から回答テキスト (content) だけを抽出して返す.
     *
     * 【抽出パス】
     *   json.choices[0].message.content
     *
     * @param  {Object} json  getInference() の戻り値
     * @return {string}       LLM が生成した回答テキスト
     * @throws {Error}        レスポンス構造が期待通りでない場合
     */
    const getResultInferenceToText = function (json) {
        var top = Conv.getMap(json);
        var list = Conv.getList(top["choices"]);
        var choiceTop = Conv.getMap(list[0]);
        var message = Conv.getMap(choiceTop["message"]);
        return Conv.getString(message["content"]);
    };

    /**
     * llama.cpp に推論を要求し、回答テキスト (content) だけを返す.
     *
     * getInference() + getResultInferenceToText() のショートカット.
     * JSON 全体ではなくテキストだけが必要な場合はこちらを使う.
     *
     * @param  {string}  baseUrl      ベース URL
     * @param  {string}  prompt       質問テキスト
     * @param  {number}  [temperature]  Temperature 値 (省略時はデフォルト)
     * @param  {number}  [maxTokens]    最大生成トークン数 (省略時は指定なし)
     * @return {Promise<string>}      LLM が生成した回答テキスト
     * @throws {Error}   サーバーエラーの場合
     */
    const getInferenceMessage = async function (
        baseUrl,
        prompt,
        temperature,
        maxTokens,
    ) {
        var res = await getInference(baseUrl, prompt, temperature, maxTokens);
        return getResultInferenceToText(res);
    };

    // ═══════════════════════════════════════════════════════════════
    // exports
    // ═══════════════════════════════════════════════════════════════
    module.exports = {
        health,
        getEmbedding,
        getInference,
        getResultInferenceToText,
        getInferenceMessage,
    };
})();
