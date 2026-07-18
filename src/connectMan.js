// llama.cpp の接続先を管理する.
// ここでは「複数のNode.jsのプロセス」に対して接続中の llama-serverに
// 他のプロセスがアクセスする事で「返却時間が遅くなった」り「メモリ枯渇」
// これを防ぐための「管理」を行います.
//
// AIメモ:
// - config.js の LlamaCppInfo (embeddingList/inferenceList の各要素) を直接
//   受け取って選択・状態更新する. LlamaCppInfo と別に並行管理用のクラスを
//   持つと二重管理で不整合の元になるため、あえて independent なクラスは持たない.
// - config.js から require されるため、循環参照を避けるためにこのファイルは
//   config.js を require しない (healthCheckTiming 等は呼び出し元から
//   パラメータとして受け取る).
//
(function () {
    "use strict";

    /**
     * list の中から「healthy かつ 同時接続数上限未満」なサーバのうち、
     * useCount が最も少ないものを選択して返す.
     *
     * 該当するサーバが1つも無い場合は例外を throw する
     * (呼び出し元で 503 相当のエラーとして扱うことを想定).
     *
     * @param  {LlamaCppInfo[]} list  config.js の embeddingList / inferenceList.
     * @return {LlamaCppInfo}         選択されたサーバ情報 (startConnect() 済み).
     * @throws {Error} 利用可能なサーバが1つも無い場合.
     */
    const acquire = function (list) {
        const len = list.length;
        let ret = null;
        for (let i = 0; i < len; i++) {
            const info = list[i];
            // healthy でない、または同時接続数上限に達しているサーバは対象外.
            if (info.healthy === false) {
                continue;
            }
            if (info.useCount >= info.maxConnectCount) {
                continue;
            }
            if (ret == null || ret.useCount > info.useCount) {
                ret = info;
            }
        }
        if (ret == null) {
            throw new Error(
                "No available llamaCpp server (all servers are unhealthy or at max connections).",
            );
        }
        ret.startConnect();
        return ret;
    };

    /**
     * 指定サーバに対してヘルスチェック (GET /health) を実施し、
     * info.healthy を更新する.
     *
     * @param  {LlamaCppInfo} info  対象サーバ情報.
     * @return {Promise<boolean>}   ヘルスチェック結果 (true=正常).
     */
    const checkHealth = async function (info) {
        let baseUrl = info.baseUrl;
        if (baseUrl.endsWith("/")) {
            baseUrl = baseUrl.slice(0, -1);
        }
        try {
            const res = await fetch(baseUrl + "/health");
            info.healthy = res.ok;
        } catch (e) {
            info.healthy = false;
        }
        return info.healthy;
    };

    /**
     * list に含まれる全サーバへの定期ヘルスチェックを開始する.
     *
     * @param  {LlamaCppInfo[]} list        ヘルスチェック対象のサーバ一覧.
     * @param  {number}         intervalMs  チェック間隔 (ミリ秒).
     * @return {NodeJS.Timeout}             stopHealthCheck() に渡すハンドル.
     */
    const startHealthCheck = function (list, intervalMs) {
        return setInterval(function () {
            const len = list.length;
            for (let i = 0; i < len; i++) {
                // 個々のチェックは非同期で並行実行 (待ち合わせ不要).
                checkHealth(list[i]);
            }
        }, intervalMs);
    };

    /**
     * startHealthCheck() で開始した定期ヘルスチェックを停止する.
     *
     * @param {NodeJS.Timeout} handle  startHealthCheck() の戻り値.
     */
    const stopHealthCheck = function (handle) {
        clearInterval(handle);
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { acquire, checkHealth, startHealthCheck, stopHealthCheck };
})();
