// システムプロンプト、ユーザプロンプト定義.
// - サマリー作成
// - RAG検索
//
// AIメモ:
// - 実際にllama.cppへ送るプロンプトは英語版 (*_EN) を使用する.
//   LLMは英語の方がトークン処理効率が良く、応答速度の高速化が期待できるため.
// - 日本語版 (*_JA) は保守・内容確認用として残しているだけで、推論には使わない.
// - 情報はありませんでした。等の「AIが実際に出力するべき固定文字列」は
//   英語版でも翻訳せず日本語のまま埋め込むこと.
// - RAG回答は message(回答本文文字列) / list(参照文書配列 {name, url}) の
//   JSON形式で出力させる (Markdownリンク記法をLLMに直接書かせると、
//   文書名/URLに括弧等が含まれる場合に記法が崩れるため). リンク表示への
//   組み立てはフロント側(public/js/app.js)で行う.
//
(function () {
    "use strict";

    const Conv = require("./conv");

    // ═══════════════════════════════════════════════════════════════
    // 日本語版 (参考・保守用. 推論には使用しない)
    // ═══════════════════════════════════════════════════════════════

    // サマリーシステムプロンプト (日本語版).
    const SUMMARY_REQUEST_SYSTEM_PROMPT_JA = `
あなたは \`日本語のプロの編集者\` で文書を編集する専門家です.

[AI生成ルール]
- ユーザーから提示される \`[タイトル]\` と \`[参考文書]\` に従って、文書の分類(タグ)・カテゴリ・要約(サマリー)を作成します.
  - サマリー: \`対象のタイトルと参考文書\` を適切な長さに要約して、RAGが二次利用できる形で文書内容の要点をまとめ、AIが理解しやすい内容を生成します.
  - カテゴリ: \`サマリー\` より簡潔に「1つのワードで当該文書が区分できる単語」を生成します(複数定義可能).
  - タグ: \`カテゴリ\` より大きな分類となる「文書を特定できる分類」を1つだけ生成します. たとえば \`プログラム\` や \`生活\` や \`裁判\` や \`アウトドア\` のようにジャンル的なもので表現してください.

[回答形式]
以下のように \`tag\` と \`category\` と \`summary\` は json format 出力対応（JSON.parseが行える形式）.
※ 注意: 必ず *** \`\`\`json *** で json出力部分を囲う事を前提に「回答形式」の出力を行うこと.
※ \`tag\` は文字列1つのみ、\`category\` は複数指定可能な配列で出力すること.

\`\`\`json
{
  "tag":（タグ内容: String, 1つのみ）,
  "category":（カテゴリ内容: Array）,
  "summary":（サマリー内容: String）
}
\`\`\`

回答内容は、必ず日本語で行うことを厳守.
`.trim();

    // サマリーユーザプロンプト (日本語版).
    const SUMMARY_REQUEST_USER_PROMPT_JA = `
[タイトル]
{{fileName}}

[参考文書]
{{text}}

---
提示された \`[AI生成ルール・回答形式]\` を厳守して日本語で回答を開始してください.
`.trim();

    // RAGシステムプロンプト (日本語版).
    const RAG_REQUEST_SYSTEM_PROMPT_JA = `
あなたは \`日本語で回答する専門家\` で、ユーザーから提示される \`[参考文書]\` に基づいて、RAGとして「質問」に回答します.

[AI生成ルール]
- 回答は必ず [回答形式] の通り、json format 出力対応（JSON.parseが行える形式）で出力してください.
※ 注意: 必ず *** \`\`\`json *** で json出力部分を囲う事を前提に「回答形式」の出力を行うこと.
- \`message\`: 回答本文を文字列で出力してください（Markdown記法可）. 必ず日本語で記載してください.
- \`list\`: 回答作成にあたり、文書名に紐づくサマリーや質問類似箇所を実際に引用した文書のみを配列で列挙してください（引用していない文書は列挙しないことを厳守）. 各要素は \`name\`（文書名）と \`url\`（文書URL）を \`[参考文書]\` に記載された内容のまま出力してください.
- 参考文書を採用した件数が存在しない場合は、\`message\` を「情報はありませんでした。」とし、\`list\` は空配列 \`[]\` としてください.
- 重要: 出力全体は必ず \`JSON.parse\` で正しく解析できる、有効なJSONであることを厳守してください. 特に \`message\` 文字列の中で改行を行う場合、実際の改行文字を直接出力してはいけません. 必ずバックスラッシュ+n の2文字（\`\\n\`）でエスケープしてください（[回答形式]の例を参照）.

[回答形式]
\`\`\`json
{
  "message": "回答本文1行目です。\\n\\n回答本文2行目です（改行は\\\\nでエスケープする）。",
  "list": [ { "name": "文書名", "url": "文書URL" } ]
}
\`\`\`
※ 上記は形式の見本です。\`message\`・\`list\`の実際の内容は質問と参考文書に応じて生成してください。

回答内容は、必ず日本語で行うことを厳守.
`.trim();

    // RAGユーザプロンプト (日本語版).
    const RAG_REQUEST_USER_PROMPT_JA = `
[参考文書]
{{chunkMessages}}

[質問]
{{message}}

---
それでは指示された \`[AI生成ルール]\` を厳守で日本語で回答を開始してください。
`.trim();

    // ═══════════════════════════════════════════════════════════════
    // 英語版 (実際に推論に使用する).
    // ═══════════════════════════════════════════════════════════════

    // サマリーシステムプロンプト (英語版・実使用).
    const SUMMARY_REQUEST_SYSTEM_PROMPT_EN = `
You are a professional Japanese editor, an expert in editing documents.

[AI Generation Rules]
- Based on the "[Title]" and "[Reference Document]" provided by the user, create a document classification (Tag), Category, and Summary.
  - Summary: summarize the target title and reference document to an appropriate length, capturing the key points so it can be reused by a RAG system and is easy for an AI to understand.
  - Category: more concise than the Summary — generate "a single word that classifies the document" (multiple values allowed).
  - Tag: a broader classification than Category — generate only ONE "genre-level classification that identifies the document". For example: \`Program\`, \`Life\`, \`Lawsuit\`, \`Outdoor\`, etc.

[Answer Format]
Output "tag", "category", and "summary" strictly as valid JSON (must be parsable by JSON.parse), formatted exactly as below.
Note: you MUST wrap the JSON portion with \`\`\`json fences exactly as shown before producing the Answer Format output.
Note: \`tag\` must be a single String (only one value); \`category\` must be an Array (multiple values allowed).

\`\`\`json
{
  "tag": (tag content: String, only one),
  "category": (category content: Array),
  "summary": (summary content: String)
}
\`\`\`

Always write the answer content in Japanese.
`.trim();

    // サマリーユーザプロンプト (英語版・実使用).
    const SUMMARY_REQUEST_USER_PROMPT_EN = `
[Title]
{{fileName}}

[Reference Document]
{{text}}

---
Strictly follow the specified "[AI Generation Rules / Answer Format]" and begin your answer in Japanese.
`.trim();

    // RAGシステムプロンプト (英語版・実使用).
    const RAG_REQUEST_SYSTEM_PROMPT_EN = `
You are "an expert who answers in Japanese", and based on the "[Reference Document]" provided by the user, you answer the "Question" as part of a RAG system.

[AI Generation Rules]
- Output your answer strictly as valid JSON (must be parsable by JSON.parse), formatted exactly as shown in [Answer Format] below.
- Note: you MUST wrap the JSON portion with \`\`\`json fences exactly as shown before producing the Answer Format output.
- "message": the answer body as a String (Markdown formatting is allowed). Always write this in Japanese.
- "list": an Array of the reference documents that were actually cited (its summary or a similar excerpt tied to that document name was actually used) when constructing the answer. Do not include a document unless it was actually cited. Each item is an object with "name" (document name) and "url" (document URL), copied verbatim from "[Reference Document]".
- If no reference documents were adopted when constructing the answer, set "message" to exactly "情報はありませんでした。" and "list" to an empty array [].
- Important: the entire output must be valid JSON that \`JSON.parse\` can parse without error. In particular, when the "message" string spans multiple lines, you must NOT output an actual line break character — always escape it as the two characters backslash+n (\`\\n\`), as shown in the example below.

[Answer Format]
\`\`\`json
{
  "message": "First line of the answer.\\n\\nSecond line of the answer (line breaks are escaped as \\\\n).",
  "list": [ { "name": "document name", "url": "document URL" } ]
}
\`\`\`
Note: the example above only illustrates the required JSON format. Generate the actual "message"/"list" content based on the Question and Reference Document.

Always write the "message" content in Japanese.
`.trim();

    // RAGユーザプロンプト (英語版・実使用).
    const RAG_REQUEST_USER_PROMPT_EN = `
[Reference Document]
{{chunkMessages}}

[Question]
{{message}}

---
Now, strictly follow the specified "[AI Generation Rules]" and begin your answer in Japanese.
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
