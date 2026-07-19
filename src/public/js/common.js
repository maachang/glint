// public/js/common.js
// 各ページ(index/documents/groups)から共通で使うヘルパー.
// window.Glint 名前空間に生やし、各ページのスクリプトより先に読み込むこと.
window.Glint = window.Glint || {};
(function (Glint) {
    "use strict";

    // JSON APIのベースパス (画面 public/ とは名前空間を分離している).
    const API_BASE = "/api";

    // API呼び出し共通ヘルパー. エラー時は { error } を投げる.
    Glint.callApi = async function (method, path, body) {
        const res = await fetch(API_BASE + path, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json();
        if (!res.ok) {
            const message = json && json.error ? json.error.message : res.statusText;
            throw new Error(message);
        }
        return json;
    };

    Glint.escapeHtml = function (s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    };

    // key(任意の識別子)のlocalStorageキーを組み立てる.
    // ページのパスを含めることで、ページごとに独立して保持される.
    const _persistKey = function (key) {
        return "glint:" + location.pathname + ":" + key;
    };

    // 任意のkeyで値をlocalStorageに保存する (入力要素に限らず使える).
    Glint.savePersisted = function (key, value) {
        localStorage.setItem(_persistKey(key), value);
    };

    // 任意のkeyで保存済みの値を取得する. 未保存の場合は null.
    Glint.loadPersisted = function (key) {
        return localStorage.getItem(_persistKey(key));
    };

    // 指定した入力要素の値を localStorage に自動保存し、ページを開いた際に復元する.
    // file入力 (アップロードファイル) は値を復元できないため対象外.
    // ※ ボタン等から el.value をプログラムで書き換えた場合は input/change イベントが
    //   発火しないため自動保存されない。その場合は呼び出し側で Glint.savePersisted()
    //   を直接呼ぶこと.
    Glint.bindPersistentInputs = function (ids) {
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (!el || el.type === "file") return;

            const saved = Glint.loadPersisted(id);
            if (saved !== null) {
                el.value = saved;
            }

            const eventName =
                el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
            el.addEventListener(eventName, () => {
                Glint.savePersisted(id, el.value);
            });
        });
    };
})(window.Glint);
