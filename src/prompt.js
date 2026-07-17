// システムプロンプト、ユーザプロンプト定義.
// - サマリー作成
// - RAG検索
//
// AIメモ:
// - 実際にllama.cppへ送るプロンプトは英語版 (*_EN) を使用する.
//   LLMは英語の方がトークン処理効率が良く、応答速度の高速化が期待できるため.
// - 日本語版 (*_JA) は保守・内容確認用として残しているだけで、推論には使わない.
// - 【回答】【参照文書一覧】情報はありませんでした。等の「AIが実際に出力するべき
//   固定文字列」は英語版でも翻訳せず日本語のまま埋め込むこと.
//   (config.js の lastReferenceSmb 判定、vectorGroup.js の後処理がこの文字列に
//    依存しているため、翻訳すると動作が壊れる)
//
(function () {
    "use strict";

    const Conv = require("./conv");

    // ═══════════════════════════════════════════════════════════════
    // 日本語版 (参考・保守用. 推論には使用しない)
    // ═══════════════════════════════════════════════════════════════

    // サマリーシステムプロンプト (日本語版).
    const SUMMARY_REQUEST_SYSTEM_PROMPT_JA = `
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

    // サマリーユーザプロンプト (日本語版).
    const SUMMARY_REQUEST_USER_PROMPT_JA = `
## タイトル
{{fileName}}

## 参考文書
{{text}}

---
それでは指示された【回答形式】を厳守で日本語(必須)で回答を開始してください。
回答：
`.trim();

    // RAGシステムプロンプト (日本語版).
    const RAG_REQUEST_SYSTEM_PROMPT_JA = `
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

    // RAGユーザプロンプト (日本語版).
    const RAG_REQUEST_USER_PROMPT_JA = `
## 参考文書
{{chunkMessages}}

## 質問
{{message}}

---
それでは指示された【回答形式】のルールを厳守で日本語で回答を開始してください。
回答:
`.trim();

    // ═══════════════════════════════════════════════════════════════
    // 英語版 (実際に推論に使用する).
    // ═══════════════════════════════════════════════════════════════

    // サマリーシステムプロンプト (英語版・実使用).
    const SUMMARY_REQUEST_SYSTEM_PROMPT_EN = `
You are a professional Japanese editor, an expert at classifying documents into a Tag and Category, and writing a Summary. Follow the "Title and Reference Document" provided by the user.
#### "Tag": a single genre-level classification, more generic than "Category". For example: \`Program\`, \`Life\`, \`Lawsuit\`, \`Outdoor\`, etc.
#### "Category": more concise than the Summary — a single word, or at most a short noun-ending phrase, expressing the single most representative noun of the content.
#### "Summary": summarize the reference document so it can be reused by a RAG system — a concise, AI-readable summary capturing the key points of the entire document.

## Answer Format
Output "tag" and "category" strictly as valid JSON (must be parsable by JSON.parse), formatted exactly as below.
Note: you MUST wrap the JSON portion with \`~~~json\` / \`~~~\` fences exactly as shown before producing the Answer Format output.

~~~json
{
"tag": (tag content: Array),
"category": (category content: Array),
}
~~~

(summary content)

IMPORTANT: Write the tag/category values and the summary content in Japanese.
`.trim();

    // サマリーユーザプロンプト (英語版・実使用).
    const SUMMARY_REQUEST_USER_PROMPT_EN = `
## Title
{{fileName}}

## Reference Document
{{text}}

---
Now, strictly follow the specified Answer Format and begin your answer in Japanese (required).
Answer:
`.trim();

    // RAGシステムプロンプト (英語版・実使用).
    const RAG_REQUEST_SYSTEM_PROMPT_EN = `
You are an expert who answers in Japanese. Based on the "Reference Document" provided by the user, answer the "Question" as part of a RAG system.
Depending on how many reference documents were actually adopted in your answer, completely switch which Answer Format below you use.

## Answer Format
Common rule: your answer must always begin with 【回答】.

### Pattern 1: one or more reference documents were adopted in the answer
Write the answer content under 回答本文. When building the answer, do not list a document under 【参照文書一覧】 unless its summary or a similar excerpt tied to that document name was actually cited.

【回答】
回答本文
【参照文書一覧】
1. [document name](document URL)
2. [document name](document URL)

### Pattern 2: no reference documents were adopted in the answer
In this case output only "情報はありませんでした。" — do not output the string "参照文書一覧" or any URL, not even a single character.

【回答】
情報はありませんでした。

## Generation Rules (Principles)
- Strictly follow the Answer Format rules above.
- Write the answer in Japanese.
`.trim();

    // RAGユーザプロンプト (英語版・実使用).
    const RAG_REQUEST_USER_PROMPT_EN = `
## Reference Document
{{chunkMessages}}

## Question
{{message}}

---
Now, strictly follow the specified Answer Format and begin your answer in Japanese.
Answer:
`.trim();

    /**
     * サマリー問い合わせプロンプト (system/user) を生成して返す.
     *
     * user プロンプトの {{fileName}} {{text}} を置き換える.
     * 実際に使用するプロンプト本文は英語版 (高速化のため).
     *
     * @param  {string} fileName  対象のファイル名.
     * @param  {string} text      要約対象のテキスト
     * @return {{system: string, user: string}}  llama.cpp に渡す system/user プロンプト
     */
    const getSummaryRequest = function (fileName, text) {
        fileName = fileName || "";
        return {
            system: SUMMARY_REQUEST_SYSTEM_PROMPT_EN,
            user: Conv.keyValueTemplate(
                SUMMARY_REQUEST_USER_PROMPT_EN,
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
     * 実際に使用するプロンプト本文は英語版 (高速化のため).
     *
     * @param  {string} chunkMessages  Config.getRagRequestChunk() の結果を連結した文字列
     * @param  {string} message        ユーザーの質問文
     * @return {{system: string, user: string}}  llama.cpp に渡す system/user プロンプト
     */
    const getRagRequest = function (chunkMessages, message) {
        return {
            system: RAG_REQUEST_SYSTEM_PROMPT_EN,
            user: Conv.keyValueTemplate(
                RAG_REQUEST_USER_PROMPT_EN,
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
        // 日本語版 (参考・保守用).
        SUMMARY_REQUEST_SYSTEM_PROMPT_JA,
        SUMMARY_REQUEST_USER_PROMPT_JA,
        RAG_REQUEST_SYSTEM_PROMPT_JA,
        RAG_REQUEST_USER_PROMPT_JA,
        // 英語版 (実使用).
        SUMMARY_REQUEST_SYSTEM_PROMPT_EN,
        SUMMARY_REQUEST_USER_PROMPT_EN,
        RAG_REQUEST_SYSTEM_PROMPT_EN,
        RAG_REQUEST_USER_PROMPT_EN,
        getSummaryRequest,
        getRagRequest,
    };
})();
