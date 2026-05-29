//////////////////////////////////////////
// util.
//////////////////////////////////////////
(function () {
    "use strict";

    // デバッグモードセット
    let _DEBUG = false;
    const debugMode = function (mode) {
        _DEBUG = mode == true;
    };

    // デバッグ出力.
    const debugOut = function () {
        if (!_DEBUG) {
            return;
        }
        let args = Array.prototype.slice.call(arguments);
        console.debug.apply(console, args);
    };

    // 文字列を置き換える.
    const changeString = function (base, src, dest) {
        base = String(base);
        return base.split(src).join(dest);
    };

    /**
     * [private]複数のパスを結合.
     * @param {arguments} パスを複数設定します.
     * @return {string} 結合されたパスが返却されます.
     */
    const joinPath = function () {
        let args = Array.prototype.slice.call(arguments);
        // １つの配列で設定.
        if (args.length == 1 && Array.isArray(args[0])) {
            args = args[0];
        }
        const len = args.length;
        let n;
        let ret = "";
        for (let i = 0; i < len; i++) {
            if (i != 0) {
                ret += "/";
            }
            n = args[i];
            if (n.endsWith("/")) n = n.slice(0, -1);
            if (n.startsWith("/")) n = n.substring(1);
            ret += n;
        }
        return ret;
    };

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
            }, msec);
        });
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { debugMode, debugOut, changeString, joinPath, sleep };
})();
