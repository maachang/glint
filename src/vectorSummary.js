/**
 * VectorSummary.js
 *
 * llama.cpp などの LLM によって生成された「文書サマリー」を管理するモジュール.
 *
 * 【概要】
 *   VectorStore では、各文書 (テキストファイル) を埋め込みベクトルに変換して
 *   保存するが、それとは別に「文書の要約テキスト・元URL・登録時刻」をまとめた
 *   サマリー情報も .vss ファイルに保存する.
 *   このモジュールはそのサマリー情報をメモリ上で管理する.
 *
 * 【クラス構成】
 *   VSummaryValue  : 1 文書分のサマリー情報 (テキスト・URL・登録時刻) を保持する値オブジェクト
 *   VectorSummary  : 複数文書分の VSummaryValue を文書名 (docName) をキーに管理する Map ラッパー
 *
 * 【使い方】
 *   const { VSummaryValue, VectorSummary } = require('./VectorSummary');
 *
 *   const summary = new VectorSummary();
 *   summary.put('readme', new VSummaryValue('概要テキスト', 'https://example.com'));
 *   console.log(summary.getText('readme')); // → '概要テキスト'
 */
(function () {
    "use strict";

    // ═══════════════════════════════════════════════════════════════
    // VSummaryValue
    //   1 文書分のサマリー情報を保持するシンプルな値オブジェクト.
    //   VectorSummary の内部 Map に格納される.
    // ═══════════════════════════════════════════════════════════════
    class VSummaryValue {
        /**
         * コンストラクタ.
         *
         * @param {string}        text   LLM が生成した文書の要約テキスト
         * @param {string}        url    元文書の参照先 URL (空文字列でも可)
         * @param {bigint|number} [time] サマリー登録時刻 (Unix タイムスタンプ, ミリ秒).
         *                               省略した場合は現在時刻 (Date.now()) が自動設定される.
         *                               ファイルから読み込む場合は getLong() が返す bigint を渡す.
         */
        constructor(text, url, time) {
            /** @type {string} LLM が生成した要約テキスト */
            this.text = text;

            /** @type {string} 元文書の参照先 URL */
            this.url = url;

            /**
             * @type {bigint} サマリー登録時刻 (Unix タイムスタンプ, ミリ秒).
             * バイナリ保存時に getLong() / BigInt64 で扱うため bigint で保持する.
             */
            this.time = time !== undefined ? BigInt(time) : BigInt(Date.now());
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // VectorSummary
    //   複数の VSummaryValue を「文書名 → VSummaryValue」の Map で管理するクラス.
    //
    //   VectorGroup (= 1 つの .vgs ファイル) に対して 1 インスタンスが対応する.
    //   .vss ファイルへのシリアライズ / デシリアライズは VectorFile.js が担当し、
    //   このクラスはあくまでメモリ上のデータ管理のみを行う.
    // ═══════════════════════════════════════════════════════════════
    class VectorSummary {
        /**
         * コンストラクタ.
         *
         * @param {Map<string, VSummaryValue>} [map]
         *   初期データとなる Map を渡すことができる.
         *   省略した場合は空の Map から始まる.
         *   通常は省略して new VectorSummary() で生成し、put() で追加する.
         */
        constructor(map) {
            /**
             * @type {Map<string, VSummaryValue>}
             * キー: 文書名 (docName, 拡張子なし)
             * 値  : VSummaryValue
             */
            this._map = map instanceof Map ? map : new Map();
        }

        /**
         * 内部の Map をそのまま返す.
         *
         * VectorFile.js がシリアライズするときや、エントリを直接削除したいとき
         * (例: map.delete(docName)) に使用する.
         *
         * @return {Map<string, VSummaryValue>}
         */
        getList() {
            return this._map;
        }

        /**
         * 指定した文書名でサマリーエントリを追加・上書きする.
         *
         * 同じ文書名が既に存在する場合は上書きされる (= 更新操作).
         *
         * @param {string}        name  文書名 (拡張子なし, 例: 'readme')
         * @param {VSummaryValue} vv    登録するサマリー値オブジェクト
         */
        put(name, vv) {
            this._map.set(name, vv);
        }

        /**
         * 指定した文書名の VSummaryValue を返す.
         *
         * @param  {string} name  文書名
         * @return {VSummaryValue|null}  存在しない場合は null
         */
        get(name) {
            return this._map.get(name) || null;
        }

        /**
         * 指定した文書名の要約テキストを返す.
         *
         * VSummaryValue を取得して .text を参照するショートカット.
         *
         * @param  {string} name  文書名
         * @return {string|null}  存在しない場合は null
         */
        getText(name) {
            const vv = this._map.get(name);
            return vv ? vv.text : null;
        }

        /**
         * 指定した文書名の元文書 URL を返す.
         *
         * @param  {string} name  文書名
         * @return {string|null}  存在しない場合は null
         */
        getUrl(name) {
            const vv = this._map.get(name);
            return vv ? vv.url : null;
        }

        /**
         * 指定した文書名のサマリー登録時刻を返す.
         *
         * 戻り値は bigint (Unix タイムスタンプ, ミリ秒).
         * 通常の比較には Number(time) で変換して使う.
         *
         * @param  {string} name  文書名
         * @return {bigint|null}  存在しない場合は null
         */
        getTime(name) {
            const vv = this._map.get(name);
            return vv ? vv.time : null;
        }

        /**
         * 管理している文書数を返す.
         *
         * @return {number}
         */
        size() {
            return this._map.size;
        }

        /**
         * 管理している全文書名を配列で返す.
         *
         * VectorFile.js がシリアライズするときに全エントリを列挙するために使用する.
         * 返す順序は Map への挿入順に従う.
         *
         * @return {string[]}
         */
        getDocuments() {
            return Array.from(this._map.keys());
        }
    }

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { VSummaryValue, VectorSummary };
})();
