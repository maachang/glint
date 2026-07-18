////////////////////////////////////////////////////
// 同期処理(lock, unlock)を実施する.
// （ファイルを利用したロック)
////////////////////////////////////////////////////
(function () {
    "use strict";
    const fs = require("fs");
    const conf = require("./config.js");
    const util = require("./util.js");

    // [lock]randomUUID作成用.
    const crypto = require("crypto");
    // [lock]fileでロック用.
    const pfs = require("fs").promises;

    // 対象プロセスIDの存在確認.
    const _isPid = function (pid) {
        try {
            // シグナル 0 はプロセスの存在チェックのみを行う
            process.kill(Number(pid), 0);
            return true; // エラーが起きなければプロセスは存在している
        } catch (e) {
            // エラーコードが EPERM の場合は「プロセスは存在するが権限がない」という意味なので、存在はしている
            return e.code === "EPERM";
        }
    };

    // ロックファイルの中身を取得.
    const _getLockFile = function (fileName, fileInfo) {
        try {
            if (typeof fileName == "string") {
                fileInfo = fs.readFileSync(fileName, "utf-8");
            }
            // {{pid}}_{{unixTime}}_{{randomUuid}}
            const list = fileInfo.split("_");
            return {
                pid: Number(list[0]),
                unixTime: Number(list[1]),
                randomUuid: list[2],
            };
        } catch (e) {
            return null;
        }
    };

    /**
     * ロック処理を実施.
     * [*]指定しない場合はコンフィグ値がセットされます.
     *
     * AIメモ:
     * - 以前は「ロック中のプロセスIDが自分自身と同じ場合は待たずに素通りする」
     *   実装だったが、これは「同一プロセス内で複数の非同期タスクが同じ名前で
     *   並行して lock() を呼ぶ」ケース（例: apiServer.js が同一グループ名への
     *   登録リクエストを並行処理する場合）で、本来待つべき別タスクの実行と
     *   競合してファイル破損を招く不具合があったため削除した.
     * - 同一プロセス内での「真の再入」（自分がロックを保持したまま同じ名前で
     *   再度 lock() を呼ぶ）が必要な場合は、呼び出し元でロック無し版の内部関数を
     *   別途用意して直接呼ぶこと (vectorGroup.js の _loadVectorGroupUnlocked() を参照).
     *   PIDだけでは「真の再入」と「別タスクの並行呼び出し」を区別できないため.
     *
     * @param {string} name ロック名を設定します.
     * @param {string} dirName [*]ロックファイル出力先のディレクトリパスを設定します.
     * @param {number} timeout [*]タイムアウト値を設定します(省略時は -1=無限待ち)
     * @returns {Promise<string>} ロックファイル設定内容のユニーク値が返却されます.
     */
    const lock = async function (name, dirName, timeout) {
        dirName = dirName || conf.getInstance().dirPath;
        timeout = timeout || conf.getInstance().fetchTimeout;
        // ロックファイル名を作成.
        const lockName = "." + name + ".lock";
        const lockFilePath = util.joinPath(dirName, lockName);

        // 既にロックファイルが存在する場合.
        // タイムアウト確認を行う.
        const tm = Date.now();
        // 実行ユニークキーを生成.
        const uk = process.pid + "_" + tm + "_" + crypto.randomUUID();
        let fh, lv;
        while (true) {
            // ロック条件獲得.
            try {
                // ロックファイルの確認.
                fh = null;
                fh = await pfs.open(lockFilePath, "wx");
                // 存在しない場合は、新しいロックファイルを作成.
                await fh.writeFile(uk);
                // ユニークキーを返却.
                return uk;
            } catch (e) {
                // ロックファイルが存在する場合.
                if (e.code === "EEXIST") {
                    // 対象ロックファイルが有効か確認する.
                    lv = _getLockFile(lockFilePath);
                    // ロックファイル内容の取得に失敗.
                    // ロック中のプロセスIDが存在しない（デッドロックの可能性).
                    if (lv == null || !_isPid(lv.pid)) {
                        try {
                            // 削除前に内容が変わっていないか確認
                            const current = fs.readFileSync(
                                lockFilePath,
                                "utf-8",
                            );
                            const currentLv = _getLockFile(null, current);
                            if (
                                currentLv != null &&
                                currentLv.pid === lv?.pid
                            ) {
                                fs.unlinkSync(lockFilePath);
                            }
                        } catch (e) {
                            // 他プロセスが先に削除済みなら無視.
                        }
                        continue;
                    }
                    // タイムアウトの場合.
                    if (timeout != -1 && Date.now() > tm + timeout) {
                        // タイムアウト例外.
                        throw new Error(
                            "Lock timeout detected: " + dirName + "/" + name,
                        );
                    }
                    // 既にロックファイルが存在するので、リトライ.
                    await util.sleep(50);
                    continue;
                }
                // それ以外場合は例外出力.
                throw e;
            } finally {
                // ファイルハンドルをクローズ.
                if (fh != null) {
                    try {
                        await fh.close();
                    } catch (ee) {}
                }
            }
        }
    };

    /**
     * アンロック処理を実施.
     * [*]指定しない場合はコンフィグ値がセットされます.
     * @param {string} name ロック名を設定します.
     * @param {string} uk lock処理結果の返却値を設定します.
     * @param {string} dirName [*]ロックファイル出力先のディレクトリパスを設定します.
     */
    const unlock = function (name, uk, dirName) {
        dirName = dirName || conf.getInstance().dirPath;
        // ロックファイル名を作成.
        const lockName = "." + name + ".lock";
        const lockFilePath = util.joinPath(dirName, lockName);
        let v = null;
        try {
            // ファイルを取得.
            v = fs.readFileSync(lockFilePath, "utf-8");
        } catch (e) {
            // ロックファイルが存在しない場合.
            throw new Error(
                "The lock file does not exist(" + dirName + "/" + name + ")",
            );
        }
        // ロックファイル内容と一致しない場合.
        // (lock() は必ず有効なユニーク値を返すため、通常 uk が null になることはない)
        if (v != uk) {
            throw new Error(
                "The contents of the lock file do not match(" +
                    dirName +
                    "/" +
                    name +
                    ") src: " +
                    uk +
                    " value: " +
                    v,
            );
        }
        try {
            // ロックファイルを削除.
            fs.unlinkSync(lockFilePath);
            return true;
        } catch (e) {
            // ロックファイル削除失敗の場合.
            throw new Error(
                "An error occurred when deleting the lock file(" +
                    dirName +
                    "/" +
                    name +
                    ")",
            );
        }
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = { lock, unlock };
})();
