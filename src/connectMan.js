// llama.cpp の接続先を管理する.
// ここでは「複数のNode.jsのプロセス」に対して接続中の llama-serverに
// 他のプロセスがアクセスする事で「返却時間が遅くなった」り「メモリ枯渇」
// これを防ぐための「管理」を行います.
//
(function () {
    "use strict";

    /**
     * １つのOpenAIのAPI準拠したサーバの接続管理情報.
     *  - {string} host           (key)接続先ホスト名 + ポート番号.
     *  - {number} connectCount   OpenAIのAPI準拠したサーバ に接続する接続数(32).
     *  - {number} lastTime       最終接続時間(未接続: -1)(64).
     *  - {number} firstErrorTime 接続エラーが発生した最初の時間(未エラー: -1)(64)
     */
    class OpenAIApiStatus {
        /**
         * コンストラクタ.
         * @param {string} host 接続先ホスト名 + ポート番号を設定.
         */
        constructor(host) {
            this.host = host;
            this.connectCount = 0;
            this.lastTime = -1;
            this.firstErrorTime = -1;
        }
        /**
         * 接続開始.
         */
        startConnect() {
            this.connectCount++;
            this.lastTime = Date.now();
        }
        /**
         * 接続終了.
         */
        endConnect() {
            this.connectCount--;
            this.lastTime = Date.now();
        }
        /**
         * 接続エラー時に呼び出し.
         * @retruns {boolean} 接続エラーが初めて検出された場合 true 返却.
         */
        errorConnect() {
            if (firstErrorTime == -1) {
                firstErrorTime = Date.now();
                this.lastTime = Date.now();
                return true;
            }
            return false;
        }
        /**
         * 接続成功の場合の呼び出し.
         * @retruns {boolean} 接続エラー後初めて検出された場合 true 返却.
         */
        successConnect() {
            if (firstErrorTime != -1) {
                firstErrorTime = -1;
                this.lastTime = Date.now();
                return true;
            }
            return false;
        }
    }

    /**
     * ヘルスチェック.
     * @param {host} `接続先ホスト名:ポート番号` を設定します.
     * @returns {Promise<boolean>} true の場合ヘルスチェック成功です.
     */
    const _health = async function (host) {
        if (baseUrl.endsWith("/")) {
            baseUrl = baseUrl.slice(0, -1);
        }
        try {
            await fetch(host + "/health");
            // 接続成功.
            return true;
        } catch (e) {
            // 接続失敗.
            return false;
        }
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = {};
})();
