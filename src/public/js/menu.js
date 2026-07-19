// public/js/menu.js
// 各ページ上部のメニュー(<nav id="appMenu">)をJSで描画する.
// jhtml(.mt.html)にHTML部分のinclude機構が無いため、共通メニューは
// HTMLをページごとに複製せず、このスクリプトで生成する方式にしている.
(function () {
    "use strict";

    const PAGES = [
        { href: "/", label: "RAG検索" },
        { href: "/documents.mt.html", label: "文書登録" },
        { href: "/groups.mt.html", label: "グループ管理" },
    ];

    const menuEl = document.getElementById("appMenu");
    if (!menuEl) return;

    const current = location.pathname;
    PAGES.forEach((p) => {
        const a = document.createElement("a");
        a.href = p.href;
        a.textContent = p.label;
        a.className = "menu-link";
        const isCurrent =
            p.href === current ||
            (p.href === "/" && (current === "/" || current === "/index.mt.html"));
        if (isCurrent) {
            a.classList.add("active");
        }
        menuEl.appendChild(a);
    });
})();
