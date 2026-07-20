// public/js/search.js
// RAG検索ページ (index.mt.html) のロジック.
(function () {
    "use strict";

    const callApi = window.Glint.callApi;

    const searchForm = document.getElementById("searchForm");
    const searchGroupSelect = document.getElementById("searchGroupName");
    const searchResult = document.getElementById("searchResult");
    const searchElapsed = document.getElementById("searchElapsed");
    const searchTagsInput = document.getElementById("searchTags");
    const searchTagSelect = document.getElementById("searchTagSelect");
    const addSearchTagBtn = document.getElementById("addSearchTagBtn");

    // 前回入力値の復元・自動保存.
    window.Glint.bindPersistentInputs(["searchGroupName", "searchMessage", "searchTags"]);

    // ─── Markdown表示 (RAG検索結果) ───────────────────────

    // marked.js が生成したHTMLをそのまま innerHTML に入れると、LLMの回答に
    // 悪意ある/意図しないタグが含まれた場合にXSSの危険があるため、
    // 許可リスト方式のタグ・属性のみを残す簡易サニタイザを通す.
    const MARKDOWN_ALLOWED_TAGS = new Set([
        "P", "BR", "STRONG", "EM", "A", "UL", "OL", "LI", "CODE", "PRE",
        "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD",
        "TBODY", "TR", "TD", "TH", "HR", "DEL", "SPAN",
    ]);
    const MARKDOWN_ALLOWED_ATTRS = { A: ["href", "title"] };
    // 中身ごと完全に除去するタグ (人が読むためのテキストを持たないため).
    const MARKDOWN_STRIP_ENTIRELY_TAGS = new Set(["SCRIPT", "STYLE"]);

    const sanitizeHtml = function (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const walk = function (node) {
            // 走査中に子要素を削除/置換するため、事前に配列化しておく.
            Array.from(node.childNodes).forEach((child) => {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (MARKDOWN_STRIP_ENTIRELY_TAGS.has(child.tagName)) {
                        // script/style は中身のテキストも表示すべきではないため完全に削除する.
                        child.remove();
                        return;
                    }
                    if (!MARKDOWN_ALLOWED_TAGS.has(child.tagName)) {
                        // 許可されていないタグはテキストとして展開する (中身のテキストは残す).
                        child.replaceWith(document.createTextNode(child.textContent));
                        return;
                    }
                    const allowedAttrs = MARKDOWN_ALLOWED_ATTRS[child.tagName] || [];
                    Array.from(child.attributes).forEach((attr) => {
                        if (!allowedAttrs.includes(attr.name)) {
                            child.removeAttribute(attr.name);
                            return;
                        }
                        // href は http(s)/mailto/アンカーのみ許可 (javascript: 等を防ぐ).
                        if (
                            attr.name === "href" &&
                            !/^(https?:|mailto:|#)/i.test(attr.value)
                        ) {
                            child.removeAttribute(attr.name);
                        }
                    });
                    if (child.tagName === "A") {
                        child.setAttribute("target", "_blank");
                        child.setAttribute("rel", "noopener noreferrer");
                    }
                    walk(child);
                } else if (child.nodeType !== Node.TEXT_NODE) {
                    // コメント等は除去する.
                    child.remove();
                }
            });
        };
        walk(doc.body);
        return doc.body.innerHTML;
    };

    // Markdownテキストをサニタイズ済みHTMLとして要素に描画する.
    // marked.js (public/js/marked.umd.js) が読み込めていない場合はプレーンテキスト表示にフォールバックする.
    const renderMarkdown = function (el, markdownText) {
        if (typeof marked === "undefined") {
            el.textContent = markdownText;
            return;
        }
        el.innerHTML = sanitizeHtml(marked.parse(markdownText));
    };

    // RAG検索結果の { message, list } から、表示用のMarkdown文字列を組み立てる.
    // list (参考文書 {name, url} の配列) は文書名/URLをこちら側で正確に把握しているため、
    // ここで組み立てることで、LLMが直接Markdownリンクを書く際に起こり得る記法崩れ
    // (文書名/URLに括弧等が含まれる場合など) を避けられる.
    const buildSearchResultMarkdown = function (result) {
        let md = result.message || "";
        const list = Array.isArray(result.list) ? result.list : [];
        if (list.length > 0) {
            md += "\n\n---\n\n【参照文書一覧】\n";
            list.forEach((d, i) => {
                md += (i + 1) + ". [" + d.name + "](" + d.url + ")\n";
            });
        }
        return md;
    };

    // RAG検索用: 選択中グループのタグ一覧を取得し、タグ選択用<select>に反映する.
    const refreshSearchTagSelect = async function (groupName) {
        searchTagSelect.innerHTML = '<option value="">-- グループのタグから追加 --</option>';
        if (!groupName) return;
        try {
            const stats = await callApi(
                "GET",
                "/groups/" + encodeURIComponent(groupName) + "/stats",
            );
            stats.tags.forEach((t) => {
                const opt = document.createElement("option");
                opt.value = t.name;
                opt.textContent = t.name + " (" + t.count + ")";
                searchTagSelect.appendChild(opt);
            });
        } catch (e) {
            // タグ一覧の取得失敗時は選択肢を空のままにする (絞り込み自体は手入力で継続可能).
            console.error("[refreshSearchTagSelect] タグ一覧の取得に失敗:", e);
        }
    };

    // ─── イベント登録 ───────────────────────────────────

    // リロード時に前回選択済みのグループがブラウザにより復元されると
    // searchGroupSelect の change が発火しないため、タグの<select>が
    // アクティブになる度 (focus) に、その時点のグループ選択値でタグ一覧を取得し直す.
    searchTagSelect.addEventListener("focus", () => {
        refreshSearchTagSelect(searchGroupSelect.value);
    });

    addSearchTagBtn.addEventListener("click", () => {
        const tag = searchTagSelect.value;
        if (!tag) return;
        const current = searchTagsInput.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (!current.includes(tag)) {
            current.push(tag);
        }
        searchTagsInput.value = current.join(", ");
        // el.valueをプログラムで書き換えてもinputイベントは発火しないため、
        // 明示的に保存する (Glint.bindPersistentInputsによる自動保存を補う).
        window.Glint.savePersisted("searchTags", searchTagsInput.value);
    });

    searchForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        searchResult.textContent = "検索中...";
        searchElapsed.textContent = "";

        const groupName = document.getElementById("searchGroupName").value.trim();
        const message = document.getElementById("searchMessage").value.trim();
        const tagsRaw = document.getElementById("searchTags").value.trim();
        const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

        const startTime = Date.now();
        try {
            const body = { message };
            if (tags && tags.length > 0) body.tags = tags;
            const res = await callApi(
                "POST",
                "/groups/" + encodeURIComponent(groupName) + "/search",
                body,
            );
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
            const md = buildSearchResultMarkdown(res);
            renderMarkdown(searchResult, md);
            searchElapsed.textContent = "検索時間: " + elapsedSec + "秒";
            // 検索結果もページを開いた際に復元できるよう保存する.
            window.Glint.savePersisted("searchResultMarkdown", md);
            window.Glint.savePersisted("searchElapsedText", searchElapsed.textContent);
        } catch (e) {
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
            searchResult.textContent = "エラー: " + e.message;
            searchElapsed.textContent = "検索時間: " + elapsedSec + "秒 (エラー)";
        }
    });

    // 前回の検索結果を復元する.
    const savedResultMarkdown = window.Glint.loadPersisted("searchResultMarkdown");
    if (savedResultMarkdown) {
        renderMarkdown(searchResult, savedResultMarkdown);
        const savedElapsedText = window.Glint.loadPersisted("searchElapsedText");
        if (savedElapsedText) {
            searchElapsed.textContent = savedElapsedText;
        }
    }
})();
