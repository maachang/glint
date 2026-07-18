/**
 * pdfExtract.js
 *
 * PDF (テキストレイヤー付き) からテキストを抽出するモジュール.
 * スキャン画像のみのPDF (テキストレイヤー無し) からは抽出できない.
 *
 * 内部で "pdf-parse" (npm) を使用する.
 * このモジュール自体が本プロジェクトで唯一の外部npm依存の入口であり、
 * vectorGroup.js 等の既存コードにPDFの知識を持たせないための責務分離.
 *
 * 【使い方】
 *   const pdfExtract = require('./pdfExtract');
 *   const text = await pdfExtract.extractText(pdfBuffer);
 */
(function () {
    "use strict";

    const pdfParse = require("pdf-parse");

    /**
     * PDFバイナリからテキストを抽出して返す.
     *
     * @param  {Buffer} buffer  PDFファイルのバイナリ (Buffer).
     * @return {Promise<string>} 抽出したテキスト.
     * @throws {Error} PDFとして解析できない場合.
     */
    const extractText = async function (buffer) {
        const result = await pdfParse(buffer);
        return result.text;
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { extractText };
})();
