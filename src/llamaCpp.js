/**
 * LlamaCpp.js
 *
 * llama.cpp サーバー、および OpenAI / OpenAI互換API (ルーターモード等) への
 * HTTP アクセス処理をまとめたモジュール.
 *
 * 【対応先】
 *   - llama.cpp (--server オプションで起動した OpenAI 互換サーバー)
 *   - OpenAI 本家 API
 *   - LiteLLM 等の OpenAI互換ルーター (複数モデルを "model" で切り替える構成)
 *   model / apiKey を指定しない場合は、従来通り llama.cpp の単一モデル運用として動作する.
 *
 * 【エンドポイント】
 *   GET  /health              サーバーの生存確認 (llama.cpp のみ対応)
 *   POST /v1/embeddings       テキスト → 埋め込みベクトル変換
 *   POST /v1/chat/completions テキスト推論 (チャット補完)
 *
 * 【使い方】
 *   const LlamaCpp = require('./LlamaCpp');
 *
 *   // 埋め込みベクトル取得 (llama.cpp, model指定なし)
 *   const emb = await LlamaCpp.getEmbedding('http://localhost:8080', 'こんにちは');
 *
 *   // 埋め込みベクトル取得 (OpenAI互換ルーター, model + apiKey指定)
 *   const emb2 = await LlamaCpp.getEmbedding(
 *       'https://router.example.com', 'こんにちは', 'text-embedding-3-small', 'sk-xxxx'
 *   );
 *
 *   // 推論 (テキストだけ取得)
 *   const msg = await LlamaCpp.getInferenceMessage(
 *       'http://localhost:8080', 'あなたは地理の専門家です。', '日本の首都は?'
 *   );
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
     * RAG では正確性重視のため 0.3 をデフォルトとする.
     */
    const DEF_TEMPERATURE = 0.3;

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
     * [private]複数のAbortSignalを1つに合成する.
     *
     * Node.js 18 では AbortSignal.any() が使えないため、代わりに
     * 新しいAbortControllerを作り、渡されたsignalのいずれかがabortしたら
     * それに追従してabortする形で合成する.
     *
     * @param  {Array<AbortSignal|undefined|null>} signals
     * @return {AbortSignal|undefined}  有効なsignalが1つも無い場合は undefined.
     */
    const _combineSignals = function (signals) {
        const valid = signals.filter(Boolean);
        if (valid.length === 0) {
            return undefined;
        }
        if (valid.length === 1) {
            return valid[0];
        }
        const controller = new AbortController();
        for (let i = 0; i < valid.length; i++) {
            if (valid[i].aborted) {
                controller.abort(valid[i].reason);
                break;
            }
            valid[i].addEventListener(
                "abort",
                function () {
                    controller.abort(valid[i].reason);
                },
                { once: true },
            );
        }
        return controller.signal;
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
     * @param  {string}  [apiKey]     指定時は Authorization: Bearer {apiKey} ヘッダーを送信する.
     * @param  {AbortSignal} [signal] 指定時、これが abort された場合もリクエストを中断する
     *                                (呼び出し元のクライアント切断等で中断させるための口).
     *                                内部のタイムアウト用signalとは合成して両方を有効にする.
     * @return {Promise<Object|string>}  レスポンスの JSON オブジェクト (rawText=true の場合は文字列)
     * @throws {Error}   HTTP エラーまたはレスポンスに error フィールドが含まれる場合
     */
    const _fetch = async function (baseUrl, endpoint, body, rawText, apiKey, signal) {
        const conf = Config.getInstance();
        const url = _buildUrl(baseUrl, endpoint);
        const bodyStr = typeof body === "string" ? body : JSON.stringify(body);

        const headers = { "Content-Type": "application/json" };
        // OpenAI / OpenAI互換API (ルーターモード等) 向けの認証ヘッダー.
        if (apiKey) {
            headers["Authorization"] = "Bearer " + apiKey;
        }

        const res = await fetch(url, {
            method: "POST",
            headers: headers,
            body: bodyStr,
            // タイムアウト用signalと、呼び出し元から渡された中断用signalを合成する.
            signal: _combineSignals([
                AbortSignal.timeout(conf.fetchTimeout),
                signal,
            ]),
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
     * @param  {string}             [model]  リクエストボディに含める model 名.
     *                                       未指定時は body に model を含めない
     *                                       (llama.cpp の単一モデル運用向け).
     *                                       OpenAI / ルーターモードでは必須.
     * @param  {string}             [apiKey] Authorization: Bearer ヘッダーに使うAPIキー.
     * @param  {AbortSignal}        [signal] 指定時、これがabortされたらリクエストを中断する.
     * @return {Promise<Float32Array>}       埋め込みベクトル
     * @throws {Error}              サーバーエラーまたはレスポンス構造が不正な場合
     */
    const getEmbedding = async function (baseUrl, text, model, apiKey, signal) {
        var body = {
            input: text,
            stream: false,
        };
        // model が指定されている場合のみボディに含める.
        if (model) {
            body.model = model;
        }

        var result = await _fetch(baseUrl, "v1/embeddings", body, false, apiKey, signal);

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
     *     "messages": [
     *         { "role": "system", "content": "システムプロンプト" },
     *         { "role": "user", "content": "ユーザプロンプト" },
     *     ],
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
     * @param  {string}  systemPrompt システムプロンプト
     * @param  {string}  userPrompt   ユーザプロンプト
     * @param  {number}  [temperature=-1]  Temperature 値. 0 以下 or undefined の場合は
     *                                     デフォルト値を使用.
     * @param  {number}  [maxTokens=-1]    最大生成トークン数. 0 以下 or undefined の
     *                                     場合は指定なし.
     * @param  {boolean} [reasoning=null]  推論ありで実行の場合は true, なしの場合は false
     *                                     また llama-server の起動オプションが `--reasoning off`
     *                                     の場合は true にしても変更されないので注意が必要です.
     * @param  {string}  [model]      リクエストボディに含める model 名.
     *                                未指定時は body に model を含めない
     *                                (llama.cpp の単一モデル運用向け).
     *                                OpenAI / ルーターモードでは必須.
     * @param  {string}  [apiKey]     Authorization: Bearer ヘッダーに使うAPIキー.
     * @param  {AbortSignal} [signal] 指定時、これがabortされたらリクエストを中断する.
     * @return {Promise<Object>}      /v1/chat/completions のレスポンス JSON
     * @throws {Error}   サーバーエラーの場合
     */
    const getInference = async function (
        baseUrl,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        reasoning,
        model,
        apiKey,
        signal,
    ) {
        // systemPrompt が未設定の場合は system メッセージ自体を含めない.
        var messages =
            systemPrompt !== undefined && systemPrompt !== null
                ? Conv.newList(
                      Conv.newMap("role", "system", "content", systemPrompt),
                      Conv.newMap("role", "user", "content", userPrompt),
                  )
                : Conv.newList(
                      Conv.newMap("role", "user", "content", userPrompt),
                  );
        var body = {
            // messages は OpenAI 互換フォーマット: [{ role, content }] の配列
            messages: messages,
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
        // 推論条件がfalseの場合.
        if (reasoning == false) {
            body["think"] = false; // Ollama
            body["reasoning_effort"] = "none"; // vLLM
            body["chat_template_kwargs"] = { // llama.cpp / mlx-lm
                enable_thinking: false
            };
        }
        // model が指定されている場合のみボディに含める.
        if (model) {
            body.model = model;
        }
        return _fetch(baseUrl, "v1/chat/completions", body, false, apiKey, signal);
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
        return Conv.getString(message["content"]) ||
            Conv.getString(message["reasoning_content"]);
    };

    /**
     * llama.cpp に推論を要求し、回答テキスト (content) だけを返す.
     *
     * getInference() + getResultInferenceToText() のショートカット.
     * JSON 全体ではなくテキストだけが必要な場合はこちらを使う.
     *
     * @param  {string}  baseUrl      ベース URL
     * @param  {string}  systemPrompt システムプロンプト
     * @param  {string}  userPrompt   ユーザプロンプト
     * @param  {number}  [temperature]  Temperature 値 (省略時はデフォルト)
     * @param  {number}  [maxTokens]    最大生成トークン数 (省略時は指定なし)
     * @param  {boolean} [reasoning=null]  推論ありで実行の場合は true, なしの場合は false
     *                                     また llama-server の起動オプションが `--reasoning off`
     *                                     の場合は true にしても変更されないので注意が必要です.
     * @param  {string}  [model]      リクエストボディに含める model 名 (省略時は含めない).
     * @param  {string}  [apiKey]     Authorization: Bearer ヘッダーに使うAPIキー.
     * @param  {AbortSignal} [signal] 指定時、これがabortされたらリクエストを中断する.
     * @return {Promise<string>}      LLM が生成した回答テキスト
     * @throws {Error}   サーバーエラーの場合
     */
    const getInferenceMessage = async function (
        baseUrl,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        reasoning,
        model,
        apiKey,
        signal,
    ) {
        var res = await getInference(
            baseUrl,
            systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
            reasoning,
            model,
            apiKey,
            signal,
        );
        return getResultInferenceToText(res);
    };

    // ═══════════════════════════════════════════════════════════════
    // exports
    // ═══════════════════════════════════════════════════════════════
    module.exports = {
        getEmbedding,
        getInference,
        getResultInferenceToText,
        getInferenceMessage,
    };
})();
