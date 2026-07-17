// llama.cpp 接続部分をダミー化した動作確認テスト.
//
// 実際の llama.cpp サーバーを起動せずに、ローカルの HTTP サーバーで
// /v1/embeddings, /v1/chat/completions を模擬応答させることで、
// src/llamaCpp.js ・ src/config.js (system/user プロンプト分離) が
// 意図した通りに動作しているかを確認する.
//
// 実行方法: node tests/testDummyLlamaCpp.js

const http = require("http");
const assert = require("assert");

const Config = require("../src/config.js");
const LlamaCpp = require("../src/llamaCpp.js");
const Prompt = require("../src/prompt.js");

// テスト結果集計.
let okCount = 0;
let ngCount = 0;
const check = function (name, cond) {
    if (cond) {
        okCount++;
        console.log("  OK: " + name);
    } else {
        ngCount++;
        console.error("  NG: " + name);
    }
};

// ダミーサーバーを起動する.
// /v1/chat/completions は受信した messages をそのままレスポンスに埋め込んで返す.
const startDummyServer = function () {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                res.setHeader("Content-Type", "application/json");

                if (req.method === "POST" && req.url === "/v1/embeddings") {
                    res.end(
                        JSON.stringify({
                            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
                        }),
                    );
                    return;
                }

                if (
                    req.method === "POST" &&
                    req.url === "/v1/chat/completions"
                ) {
                    const reqJson = JSON.parse(body || "{}");
                    // 受信した messages 内容をそのまま JSON 文字列として
                    // 回答テキストに埋め込んで返す (system/user 分離の検証用).
                    res.end(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        role: "assistant",
                                        content: JSON.stringify(
                                            reqJson.messages,
                                        ),
                                    },
                                },
                            ],
                        }),
                    );
                    return;
                }

                res.statusCode = 404;
                res.end(JSON.stringify({ error: { code: 404, message: "not found" } }));
            });
        });
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            resolve({ server, baseUrl: "http://127.0.0.1:" + port });
        });
    });
};

const main = async function () {
    const { server, baseUrl } = await startDummyServer();
    try {
        // ダミーサーバーを埋め込み・推論両方の接続先として設定.
        Config.getInstance().setConfig({
            embeddingList: { url: baseUrl },
            inferenceList: { url: baseUrl },
        });

        console.log("[1] getEmbedding() 動作確認");
        const emb = await LlamaCpp.getEmbedding(baseUrl, "テスト文");
        check("Float32Array が返る", emb instanceof Float32Array);
        check("要素数が一致する", emb.length === 3);

        console.log("[2] getInferenceMessage() system/user 分離確認");
        const msg1 = await LlamaCpp.getInferenceMessage(
            baseUrl,
            "システム指示",
            "ユーザー質問",
        );
        const sentMessages1 = JSON.parse(msg1);
        check(
            "messages が2件 (system+user)",
            sentMessages1.length === 2,
        );
        check(
            "1件目が system ロール",
            sentMessages1[0].role === "system" &&
                sentMessages1[0].content === "システム指示",
        );
        check(
            "2件目が user ロール",
            sentMessages1[1].role === "user" &&
                sentMessages1[1].content === "ユーザー質問",
        );

        console.log("[3] systemPrompt=null の場合 system メッセージ省略確認");
        const msg2 = await LlamaCpp.getInferenceMessage(
            baseUrl,
            null,
            "ユーザー質問のみ",
        );
        const sentMessages2 = JSON.parse(msg2);
        check("messages が1件 (userのみ)", sentMessages2.length === 1);
        check(
            "唯一のメッセージが user ロール",
            sentMessages2[0].role === "user" &&
                sentMessages2[0].content === "ユーザー質問のみ",
        );

        console.log(
            "[4] Prompt.getSummaryRequest() の system/user がそのまま推論に渡る確認",
        );
        const conf = Config.getInstance();
        const sumPrompt = Prompt.getSummaryRequest("doc1", "本文サンプル");
        const msg3 = await LlamaCpp.getInferenceMessage(
            baseUrl,
            sumPrompt.system,
            sumPrompt.user,
        );
        const sentMessages3 = JSON.parse(msg3);
        check(
            "system がプロンプト定義と一致",
            sentMessages3[0].content === sumPrompt.system,
        );
        check(
            "user に fileName/text が展開されている",
            sentMessages3[1].content.includes("doc1") &&
                sentMessages3[1].content.includes("本文サンプル"),
        );

        console.log(
            "[5] Prompt.getRagRequest() の system/user がそのまま推論に渡る確認",
        );
        const chunk = conf.getRagRequestChunk(
            null,
            1,
            "doc1",
            "http://example.com",
            0.9,
            "サマリー内容",
            "類似箇所テキスト",
        );
        const ragPrompt = Prompt.getRagRequest(chunk, "質問文サンプル");
        const msg4 = await LlamaCpp.getInferenceMessage(
            baseUrl,
            ragPrompt.system,
            ragPrompt.user,
        );
        const sentMessages4 = JSON.parse(msg4);
        check(
            "system がプロンプト定義と一致",
            sentMessages4[0].content === ragPrompt.system,
        );
        check(
            "user に chunkMessages/message が展開されている",
            sentMessages4[1].content.includes("doc1") &&
                sentMessages4[1].content.includes("質問文サンプル"),
        );
    } finally {
        server.close();
    }

    console.log("");
    console.log("結果: OK=" + okCount + " NG=" + ngCount);
    if (ngCount > 0) {
        process.exitCode = 1;
    }
};

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
