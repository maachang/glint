// システムプロンプト、ユーザプロンプト定義.
// - サマリー作成
// - RAG検索
//
(function () {
    "use strict";

    const Conv = require("./conv");

    // サマリーシステムプロンプト.
    const SUMMARY_REQUEST_SYSTEM_PROMPT = `
あなたは ** 日本語のプロの編集者 ** で文書の分類(タグ)・カテゴリ・要約(サマリー)を編集する専門家です。ユーザーから提示される「タイトルと参考文書」に従って回答してください。
####「タグ」は「カテゴリ」を更に固有定義化した「１つのジャンル」で表現してください。たとえば \`プログラム\` や \`生活\` や \`裁判\` や \`アウトドア\` のようにジャンル的なもので。
####「カテゴリ」は「サマリー」より簡潔に「1つのワード」「最大でも体言止めの短いフレーズで」「内容を最も象徴する『名詞』のみ」で表現してください。
####「サマリー」は参考文書内容として、RAGが二次利用できる形「文書内容の要点をまとめ、AIが理解しやすい内容」でまとめてください。

## 回答形式
以下のように tagとcategoryは json format 出力対応（JSON.parseが行える形式）を必ず厳守で
※ 注意: 必ず *** ~~~json *** で json出力部分を囲う事を前提に「回答形式」の出力を行うこと

~~~json
{
"tag":（タグ内容: Array）,
"category":（カテゴリ内容: Array）,
}
~~~

（サマリー内容）
`.trim();

    // サマリーユーザプロンプト.
    const SUMMARY_REQUEST_USER_PROMPT = `
## タイトル
{{fileName}}

## 参考文書
{{text}}

---
それでは指示された【回答形式】を厳守で日本語(必須)で回答を開始してください。
回答：
`.trim();

    // RAGシステムプロンプト.
    const RAG_REQUEST_SYSTEM_PROMPT = `
あなたは ** 日本語で回答する専門家 ** です。ユーザーから提示される「参考文書」に基づいて、RAGとして「質問」に回答してください。
回答の際は、参考文書を採用した件数に応じて、以下の【回答形式】を完全に切り替えて回答してください。

## 回答形式
※回答共通: 【回答】より、AIの回答開始とする事を厳守します。

### パターン1: 回答作成に対して、参考文書を採用した件数が ** 存在する ** 場合
※ AIが回答した内容は 回答本文 に記載してください。あと回答を作成する際に 文書名 に紐づくサマリーや質問類似箇所を引用していない内容は【参照文書一覧】に列挙しないことを厳守してください。

【回答】
回答本文
【参照文書一覧】
1. [文書名](文書URL)
2. [文書名](文書URL)

### パターン2: 回答作成に対して、参考文書を採用した件数が ** 存在しない ** 場合
※この場合「情報はありませんでした。」のみで「参照文書一覧」という文字列やURLは、1文字も出力してはいけません。

【回答】
情報はありませんでした。

## 生成ルール(原則)
- 上記の【回答形式】のルールを厳守する
- 日本語で回答する
`.trim();

    // RAGユーザプロンプト.
    const RAG_REQUEST_USER_PROMPT = `
## 参考文書
{{chunkMessages}}

## 質問
{{message}}

---
それでは指示された【回答形式】のルールを厳守で日本語で回答を開始してください。
回答:
`.trim();

    /**
     * サマリー問い合わせプロンプト (system/user) を生成して返す.
     *
     * user プロンプトの {{fileName}} {{text}} を置き換える.
     *
     * @param  {string} fileName  対象のファイル名.
     * @param  {string} text      要約対象のテキスト
     * @return {{system: string, user: string}}  llama.cpp に渡す system/user プロンプト
     */
    const getSummaryRequest = function (fileName, text) {
        fileName = fileName || "";
        return {
            system: SUMMARY_REQUEST_SYSTEM_PROMPT,
            user: Conv.keyValueTemplate(
                SUMMARY_REQUEST_USER_PROMPT,
                "fileName",
                fileName,
                "text",
                text,
            ),
        };
    };

    /**
     * RAG 問い合わせプロンプト (system/user) を生成して返す.
     *
     * user プロンプトの {{chunkMessages}} {{message}} を置き換える.
     *
     * @param  {string} chunkMessages  Config.getRagRequestChunk() の結果を連結した文字列
     * @param  {string} message        ユーザーの質問文
     * @return {{system: string, user: string}}  llama.cpp に渡す system/user プロンプト
     */
    const getRagRequest = function (chunkMessages, message) {
        return {
            system: RAG_REQUEST_SYSTEM_PROMPT,
            user: Conv.keyValueTemplate(
                RAG_REQUEST_USER_PROMPT,
                "chunkMessages",
                chunkMessages,
                "message",
                message,
            ),
        };
    };

    // ═══════════════════════════════════════════════════════════════
    // exports
    // ═══════════════════════════════════════════════════════════════
    module.exports = {
        SUMMARY_REQUEST_SYSTEM_PROMPT,
        SUMMARY_REQUEST_USER_PROMPT,
        RAG_REQUEST_SYSTEM_PROMPT,
        RAG_REQUEST_USER_PROMPT,
        getSummaryRequest,
        getRagRequest,
    };
})();
