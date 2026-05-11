/**
 * Conv.js
 *
 * 各種データ型の変換・テキスト処理をまとめたユーティリティモジュール.
 *
 * 【モジュール構成】
 *   型変換系  : getBoolean / getInt / getLong / getFloat / getDouble / getString / getMap / getList
 *   オブジェクト生成系: newMap / newList
 *   文字列処理系: getCutExtension / stripMarkdown / exclusionText / trimEnterText / keyValueTemplate
 *
 * 【使い方】
 *   const Conv = require('./Conv');
 *   const n = Conv.getInt('42');        // → 42
 *   const s = Conv.stripMarkdown('**太字**'); // → '太字'
 */
(function (global) {
    "use strict";
    // ═══════════════════════════════════════════════════════════════
    // 型変換系
    //   対象値を指定の型に変換して返す.
    //   変換できない場合は Error をスロー.
    // ═══════════════════════════════════════════════════════════════

    /**
     * 値を boolean に変換して返す.
     *
     * - boolean 型はそのまま返す.
     * - 文字列 'true' (大文字小文字区別なし) → true、それ以外 → false.
     * - それ以外の型は Error をスロー.
     *
     * @param  {*} o  変換対象の値
     * @return {boolean}
     * @throws {Error}  変換できない型が渡された場合
     */
    const getBoolean = function (o) {
        if (typeof o === "boolean") {
            return o;
        } else if (typeof o === "string") {
            return o.trim().toLowerCase() === "true";
        }
        throw new Error("Boolean conversion failed: " + o);
    };

    /**
     * 値を整数 (int 相当) に変換して返す.
     *
     * - number 型は Math.trunc() で小数部を切り捨てて返す.
     * - 文字列は parseInt() で変換する.
     * - bigint は number にキャストして返す.
     * - それ以外の型は Error をスロー.
     *
     * @param  {*} o  変換対象の値
     * @return {number}  整数値
     * @throws {Error}   変換できない型が渡された場合
     */
    const getInt = function (o) {
        if (typeof o === "number") {
            return Math.trunc(o);
        } else if (typeof o === "bigint") {
            return Number(o);
        } else if (typeof o === "string") {
            var n = parseInt(o.trim(), 10);
            if (!isNaN(n)) return n;
        }
        throw new Error("Integer conversion failed: " + o);
    };

    /**
     * 値を long (64bit 整数) 相当の bigint に変換して返す.
     *
     * JavaScript には Java の long に対応するネイティブ整数型がないため、
     * bigint を使用する.
     * - bigint はそのまま返す.
     * - number は BigInt() でキャストする.
     * - 文字列は BigInt() でパースする.
     * - それ以外の型は Error をスロー.
     *
     * @param  {*} o  変換対象の値
     * @return {bigint}
     * @throws {Error}  変換できない型が渡された場合
     */
    const getLong = function (o) {
        if (typeof o === "bigint") {
            return o;
        } else if (typeof o === "number") {
            return BigInt(Math.trunc(o));
        } else if (typeof o === "string") {
            try {
                return BigInt(o.trim());
            } catch (e) {}
        }
        throw new Error("Long conversion failed: " + o);
    };

    /**
     * 値を単精度浮動小数点数 (float 相当) に変換して返す.
     *
     * JavaScript では float と double の区別がないため、
     * number をそのまま返す (精度は double 相当).
     * - number / bigint はそのまま number にキャストして返す.
     * - 文字列は parseFloat() で変換する.
     * - それ以外の型は Error をスロー.
     *
     * @param  {*} o  変換対象の値
     * @return {number}
     * @throws {Error}  変換できない型が渡された場合
     */
    const getFloat = function (o) {
        if (typeof o === "number") {
            return o;
        } else if (typeof o === "bigint") {
            return Number(o);
        } else if (typeof o === "string") {
            var n = parseFloat(o.trim());
            if (!isNaN(n)) return n;
        }
        throw new Error("Float conversion failed: " + o);
    };

    /**
     * 値を倍精度浮動小数点数 (double 相当) に変換して返す.
     *
     * getFloat() と同等 (JavaScript では float/double の区別がないため).
     *
     * @param  {*} o  変換対象の値
     * @return {number}
     * @throws {Error}  変換できない型が渡された場合
     */
    const getDouble = function (o) {
        if (typeof o === "number") {
            return o;
        } else if (typeof o === "bigint") {
            return Number(o);
        } else if (typeof o === "string") {
            var n = parseFloat(o.trim());
            if (!isNaN(n)) return n;
        }
        throw new Error("Double conversion failed: " + o);
    };

    /**
     * 値を文字列に変換して返す.
     *
     * - null / undefined は Error をスロー.
     * - 文字列はそのまま返す.
     * - それ以外は String() でキャストして返す.
     *
     * @param  {*} o  変換対象の値
     * @return {string}
     * @throws {Error}  null / undefined が渡された場合
     */
    const getString = function (o) {
        if (o === null || o === undefined) {
            throw new Error("String conversion failed: " + o);
        } else if (typeof o === "string") {
            return o;
        }
        return String(o);
    };

    /**
     * 値を Object (Map 相当) として返す.
     *
     * Java の Map<String, Object> に相当する型チェックを行う.
     * null でなく、typeof が 'object' で、配列でなければ Map 相当とみなす.
     *
     * @param  {*} o  変換対象の値
     * @return {Object}
     * @throws {Error}  Object でない場合
     */
    const getMap = function (o) {
        if (o !== null && typeof o === "object" && !Array.isArray(o)) {
            return o;
        }
        throw new Error("Map conversion failed: " + o);
    };

    /**
     * 値を Array (List 相当) として返す.
     *
     * Java の List に相当する型チェックを行う.
     *
     * @param  {*} o  変換対象の値
     * @return {Array}
     * @throws {Error}  Array でない場合
     */
    const getList = function (o) {
        if (Array.isArray(o)) {
            return o;
        }
        throw new Error("List conversion failed: " + o);
    };

    // ═══════════════════════════════════════════════════════════════
    // オブジェクト生成系
    // ═══════════════════════════════════════════════════════════════

    /**
     * キーと値のペアを可変長引数で受け取り、Object を生成して返す.
     *
     * Java 版の Conv.newMap(key1, val1, key2, val2, ...) に相当.
     * 引数は偶数個で、偶数番目がキー・奇数番目が値.
     *
     * 例:
     *   Conv.newMap('role', 'user', 'content', 'こんにちは')
     *   // → { role: 'user', content: 'こんにちは' }
     *
     * @param  {...*} args  キーと値を交互に並べた可変長引数
     * @return {Object}
     */
    const newMap = function () {
        var map = {};
        for (var i = 0; i < arguments.length; i += 2) {
            map[arguments[i]] = arguments[i + 1];
        }
        return map;
    };

    /**
     * 可変長引数から Array を生成して返す.
     *
     * Java 版の Conv.newList(val1, val2, ...) に相当.
     *
     * 例:
     *   Conv.newList({ role: 'user', content: 'hi' })
     *   // → [{ role: 'user', content: 'hi' }]
     *
     * @param  {...*} args  格納する値の可変長引数
     * @return {Array}
     */
    const newList = function () {
        return Array.prototype.slice.call(arguments);
    };

    // ═══════════════════════════════════════════════════════════════
    // 文字列処理系
    // ═══════════════════════════════════════════════════════════════

    /**
     * ファイル名から拡張子を除去して文書名を返す.
     *
     * 例: 'readme.txt' → 'readme'
     *     'readme'     → 'readme'  (拡張子がない場合はそのまま)
     *
     * @param  {string} fileName  ファイル名
     * @return {string}           拡張子なしの文書名
     */
    const getCutExtension = function (fileName) {
        var p = fileName.lastIndexOf(".");
        if (p !== -1) {
            return fileName.substring(0, p);
        }
        return fileName;
    };

    /**
     * マークダウン記法を除去または変換する.
     *
     * LLM が出力したマークダウンテキストをベクトル化や表示に適した
     * プレーンテキストに変換するために使用する.
     *
     * 【変換ルール (Java 版と同じ順番・正規表現)】
     *   1. コードブロック (``` ... ```) を ~~~ ... ~~~ に変換 (中身は保持)
     *   2. インラインコード (`code`) → code (バッククォートだけ除去)
     *   3. 太字・斜体 (***text***, **text**, *text*, __text__, _text_) → text
     *   4. 画像 (![alt](url)) → alt テキストのみ残す
     *   5. リンク ([text](url)) → text のみ残す
     *   6. 見出し (# Header, ## Header, ...) → 行頭の # を除去
     *   7. 引用 (> Quote) → 行頭の > を除去
     *   8. 水平線 (---, ***, ___) → 行ごと除去
     *   9. リスト記号 (* Item, 1. Item) → そのまま保持.
     *
     * @param  {string} text  変換対象のテキスト
     * @return {string}       マークダウン除去後のテキスト
     */
    const stripMarkdown = function (text) {
        if (!text) return text;
        var result = text;
        // 1. コードブロック ``` ... ``` を ~~~ ... ~~~ に変換 (中身は保持)
        result = result.replace(/```(.+?)```/gs, "~~~$1~~~");
        // 2. インラインコード `code` → code
        result = result.replace(/`(.+?)`/g, "$1");
        // 3. 太字・斜体: ***text*** / ___text___ → text
        result = result.replace(/(\*\*\*|___)(.*?)\1/g, "$2");
        // 3. 太字: **text** / __text__ → text
        result = result.replace(/(\*\*|__)(.*?)\1/g, "$2");
        // 3. 斜体: *text* / _text_ → text
        result = result.replace(/(\*|_)(.*?)\1/g, "$2");
        // 4. 画像: ![alt](url) → alt
        result = result.replace(/!\[(.*?)\]\(.*?\)/g, "$1");
        // 5. リンク: [text](url) → text
        result = result.replace(/\[(.*?)\]\(.*?\)/g, "$1");
        // 6. 見出し: 行頭の # を除去
        result = result.replace(/^#{1,6}\s+/gm, "");
        // 7. 引用: 行頭の > を除去
        result = result.replace(/^>\s+/gm, "");
        // 8. 水平線: --- / *** / ___ を除去
        result = result.replace(/^[\*\-_]{3,}\s*$/gm, "");
        return result.trim();
    };

    /**
     * テキストから不要な文字 (全角スペース・キャリッジリターン・タブ) を除去する.
     *
     * VectorStore への登録前にテキストをクレンジングするために使用する.
     * 改行 (\n) はそのまま保持する.
     *
     * 除去対象:
     *   - 全角スペース (U+3000, '　')
     *   - キャリッジリターン (\r)
     *   - タブ (\t)
     *
     * @param  {string} text  クレンジング対象のテキスト
     * @return {string}       不要文字を除去したテキスト
     */
    const exclusionText = function (text) {
        if (!text) return text;
        // 全角スペース・\r・\t をまとめて除去する正規表現
        return text.replace(/[　\r\t]/g, "");
    };

    /**
     * テキストから余分な空行・行頭末尾の空白を除去する.
     *
     * 複数の空行が続く箇所を詰め、各行を trim() することで
     * LLM 入力テキストをコンパクトにする.
     *
     * 例:
     *   '行1\n\n\n行2\n  行3  \n'
     *   → '行1\n行2\n行3'
     *
     * @param  {string} text  対象テキスト
     * @return {string}       空行・余分な空白を除去したテキスト
     */
    const trimEnterText = function (text) {
        if (!text) return text;
        var lines = text.split("\n");
        var result = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.length > 0) {
                result.push(line);
            }
        }
        return result.join("\n");
    };

    /**
     * テンプレート文字列内のプレースホルダーをキーと値で置き換える.
     *
     * プレースホルダーの形式: {{key}}
     * スペースを入れると置換されない.
     *
     * 例:
     *   Conv.keyValueTemplate('こんにちは{{name}}さん', 'name', '太郎')
     *   // → 'こんにちは太郎さん'
     *
     * 例 (複数キー):
     *   Conv.keyValueTemplate('{{a}} と {{b}}', 'a', 'リンゴ', 'b', 'バナナ')
     *   // → 'リンゴ と バナナ'
     *
     * @param  {string} src        テンプレート文字列
     * @param  {...*}   keyValues  キーと値を交互に並べた可変長引数
     * @return {string}            置き換え後の文字列
     */
    const keyValueTemplate = function (src) {
        var keyValues = Array.prototype.slice.call(arguments, 1);
        var ret = src;
        for (var i = 0; i < keyValues.length; i += 2) {
            var k = String(keyValues[i]).trim();
            var v = String(keyValues[i + 1]);
            // split + join で全出現箇所を置換 (replaceAll の代替)
            ret = ret.split("{{" + k + "}}").join(v);
        }
        return ret;
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    // Node.js(CommonJS)環境とブラウザ環境の両方に対応
    if (typeof exports !== "undefined") {
        module.exports = {
            getBoolean,
            getInt,
            getLong,
            getFloat,
            getDouble,
            getString,
            getMap,
            getList,
            newMap,
            newList,
            getCutExtension,
            stripMarkdown,
            exclusionText,
            trimEnterText,
            keyValueTemplate,
        };
    } else {
        global.Conv = {
            getBoolean,
            getInt,
            getLong,
            getFloat,
            getDouble,
            getString,
            getMap,
            getList,
            newMap,
            newList,
            getCutExtension,
            stripMarkdown,
            exclusionText,
            trimEnterText,
            keyValueTemplate,
        };
    }
})(typeof window !== "undefined" ? window : globalThis || this);
