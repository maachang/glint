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

    // 指定した入力要素の値を localStorage に自動保存し、ページを開いた際に復元する.
    // キーはページのパス+要素idで構成する (ページごとに独立して保持される).
    // file入力 (アップロードファイル) は値を復元できないため対象外.
    Glint.bindPersistentInputs = function (ids) {
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (!el || el.type === "file") return;

            const key = "glint:" + location.pathname + ":" + id;
            const saved = localStorage.getItem(key);
            if (saved !== null) {
                el.value = saved;
            }

            const eventName =
                el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
            el.addEventListener(eventName, () => {
                localStorage.setItem(key, el.value);
            });
        });
    };
})(window.Glint);
