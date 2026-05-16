//////////////////////////////////////////
// util.
//////////////////////////////////////////
(function () {
    "use strict";

    // タイマー処理系ライブラリ(nodejs).
    // 一旦参考.
    //const timers = require("timers/promises");

    /**
     * sleep実行.
     * > await sleep(1000);
     * のように実装することで js で sleep的な実装が行えます.
     * @param {number} msec sleepしたいミリ秒値を設定します.
     */
    const sleep = function (msec) {
        msec = msec | 0;
        return new Promise(function (resolve) {
            setTimeout(function () {
                resolve();
            }, msec)
        })
    }


    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { sleep };
})();
