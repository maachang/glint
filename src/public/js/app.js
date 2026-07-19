// public/js/app.js
// ブラウザ側から apiServer.js のJSON APIを fetch() で呼び出す画面ロジック.
(function () {
    "use strict";

    const groupSelect = document.getElementById("groupSelect");
    const refreshGroupsBtn = document.getElementById("refreshGroupsBtn");
    const documentsArea = document.getElementById("documentsArea");
    const putDocumentForm = document.getElementById("putDocumentForm");
    const putStatus = document.getElementById("putStatus");
    const searchForm = document.getElementById("searchForm");
    const searchGroupSelect = document.getElementById("searchGroupName");
    const searchResult = document.getElementById("searchResult");
    const searchTagsInput = document.getElementById("searchTags");
    const searchTagSelect = document.getElementById("searchTagSelect");
    const addSearchTagBtn = document.getElementById("addSearchTagBtn");
    const allowedTagsChips = document.getElementById("allowedTagsChips");
    const allowedTagInput = document.getElementById("allowedTagInput");
    const addAllowedTagBtn = document.getElementById("addAllowedTagBtn");
    const saveAllowedTagsBtn = document.getElementById("saveAllowedTagsBtn");
    const allowedTagsStatus = document.getElementById("allowedTagsStatus");
    const newGroupNameInput = document.getElementById("newGroupName");
    const createGroupBtn = document.getElementById("createGroupBtn");
    const createGroupStatus = document.getElementById("createGroupStatus");

    // 編集中の許可タグ一覧 (保存ボタン押下時にPUTする).
    let allowedTagsDraft = [];

    // JSON APIのベースパス (画面 public/ とは名前空間を分離している).
    const API_BASE = "/api";

    // API呼び出し共通ヘルパー. エラー時は { error } を投げる.
    const callApi = async function (method, path, body) {
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

    // ファイルを base64 文字列として読み込む.
    const readFileAsBase64 = function (file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // "data:application/pdf;base64,xxxx" の "xxxx" 部分だけ取り出す.
                const result = reader.result;
                resolve(result.substring(result.indexOf(",") + 1));
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    };

    // 指定した <select> の内容を、現在の選択値を維持しつつグループ一覧で置き換える.
    const _fillGroupOptions = function (selectEl, groups) {
        const current = selectEl.value;
        selectEl.innerHTML = '<option value="">-- グループを選択 --</option>';
        groups.forEach((g) => {
            const opt = document.createElement("option");
            opt.value = g;
            opt.textContent = g;
            selectEl.appendChild(opt);
        });
        if (groups.includes(current)) {
            selectEl.value = current;
        }
    };

    // グループ一覧を再読み込みして、文書一覧用・RAG検索用の <select> 両方に反映する.
    const refreshGroups = async function () {
        try {
            const { groups } = await callApi("GET", "/groups");
            _fillGroupOptions(groupSelect, groups);
            _fillGroupOptions(searchGroupSelect, groups);
        } catch (e) {
            documentsArea.innerHTML =
                '<p class="error">グループ一覧の取得に失敗しました: ' + e.message + "</p>";
        }
    };

    // 指定グループの文書一覧・タグ/カテゴリ集計を表示する.
    const showGroupDocuments = async function (groupName) {
        if (!groupName) {
            documentsArea.innerHTML = '<p class="hint">グループを選択してください。</p>';
            return;
        }
        documentsArea.innerHTML = '<p class="hint">読み込み中...</p>';
        try {
            const [docs, stats] = await Promise.all([
                callApi("GET", "/groups/" + encodeURIComponent(groupName) + "/documents"),
                callApi("GET", "/groups/" + encodeURIComponent(groupName) + "/stats"),
            ]);

            let html = "<p>文書数: " + docs.count + "</p>";

            if (stats.tags.length > 0) {
                html += "<p>タグ: ";
                stats.tags.forEach((t) => {
                    html +=
                        '<span class="tag-chip">' + escapeHtml(t.name) + " (" + t.count + ")</span>";
                });
                html += "</p>";
            }

            html += "<table><thead><tr><th>文書名</th><th>タグ</th><th>カテゴリ</th><th>URL</th><th></th></tr></thead><tbody>";
            docs.documents.forEach((d) => {
                html +=
                    "<tr>" +
                    "<td>" + escapeHtml(d.name) + "</td>" +
                    "<td>" + escapeHtml(d.tag || "") + "</td>" +
                    "<td>" + escapeHtml((d.category || []).join(", ")) + "</td>" +
                    '<td><a href="' + escapeHtml(d.url) + '" target="_blank">link</a></td>' +
                    '<td><button data-doc="' + escapeHtml(d.name) + '" class="deleteDocBtn">削除</button></td>' +
                    "</tr>";
            });
            html += "</tbody></table>";

            documentsArea.innerHTML = html;

            // 削除ボタンにイベントを設定する.
            documentsArea.querySelectorAll(".deleteDocBtn").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    const docName = btn.getAttribute("data-doc");
                    if (!confirm(docName + " を削除しますか？")) return;
                    try {
                        // DELETE は拡張子の有無に関わらず一致させられるため、
                        // 一覧が返す拡張子抜きの docName をそのまま渡せば良い.
                        await callApi(
                            "DELETE",
                            "/groups/" + encodeURIComponent(groupName) + "/documents/" +
                                encodeURIComponent(docName),
                        );
                        showGroupDocuments(groupName);
                    } catch (e) {
                        alert("削除に失敗しました: " + e.message);
                    }
                });
            });
        } catch (e) {
            documentsArea.innerHTML = '<p class="error">取得に失敗しました: ' + e.message + "</p>";
        }
    };

    const escapeHtml = function (s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    };

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

    // ─── グループ単位の許可タグ一覧 (enum) の管理 ────────────────

    // allowedTagsDraft の内容をチップ表示に反映する.
    const renderAllowedTagsChips = function () {
        allowedTagsChips.innerHTML = "";
        allowedTagsDraft.forEach((tag) => {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.textContent = tag + " ";
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.textContent = "×";
            removeBtn.addEventListener("click", () => {
                allowedTagsDraft = allowedTagsDraft.filter((t) => t !== tag);
                renderAllowedTagsChips();
            });
            chip.appendChild(removeBtn);
            allowedTagsChips.appendChild(chip);
        });
    };

    // 選択中グループの許可タグ一覧をAPIから取得し、編集用ドラフトに反映する.
    const loadAllowedTags = async function (groupName) {
        allowedTagsDraft = [];
        allowedTagsStatus.textContent = "";
        renderAllowedTagsChips();
        if (!groupName) return;
        try {
            const res = await callApi(
                "GET",
                "/groups/" + encodeURIComponent(groupName) + "/tags",
            );
            allowedTagsDraft = Array.isArray(res.tags) ? res.tags.slice() : [];
            renderAllowedTagsChips();
        } catch (e) {
            // 未登録グループ等で.vssが無い場合は取得に失敗する (許可タグ無し=自由生成のまま扱う).
            console.error("[loadAllowedTags] 許可タグ一覧の取得に失敗:", e);
        }
    };

    // ジョブ完了をポーリングする.
    const waitForJob = async function (jobId) {
        for (let i = 0; i < 300; i++) {
            const job = await callApi("GET", "/jobs/" + jobId);
            if (job.status !== "pending") return job;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("ジョブの完了待ちがタイムアウトしました。");
    };

    // ─── イベント登録 ───────────────────────────────────

    refreshGroupsBtn.addEventListener("click", refreshGroups);

    groupSelect.addEventListener("change", () => {
        showGroupDocuments(groupSelect.value);
        loadAllowedTags(groupSelect.value);
    });

    createGroupBtn.addEventListener("click", async () => {
        const groupName = newGroupNameInput.value.trim();
        if (!groupName) {
            createGroupStatus.textContent = "グループ名を入力してください。";
            createGroupStatus.classList.add("error");
            return;
        }
        createGroupStatus.textContent = "作成中...";
        createGroupStatus.classList.remove("error");
        try {
            await callApi("POST", "/groups", { group: groupName });
            createGroupStatus.textContent = "作成しました。";
            newGroupNameInput.value = "";
            await refreshGroups();
            groupSelect.value = groupName;
            showGroupDocuments(groupName);
            loadAllowedTags(groupName);
        } catch (e) {
            createGroupStatus.textContent = "作成に失敗しました: " + e.message;
            createGroupStatus.classList.add("error");
        }
    });

    addAllowedTagBtn.addEventListener("click", () => {
        const tag = allowedTagInput.value.trim();
        if (!tag) return;
        if (!allowedTagsDraft.includes(tag)) {
            allowedTagsDraft.push(tag);
            renderAllowedTagsChips();
        }
        allowedTagInput.value = "";
    });

    saveAllowedTagsBtn.addEventListener("click", async () => {
        const groupName = groupSelect.value;
        if (!groupName) {
            allowedTagsStatus.textContent = "グループを選択してください。";
            allowedTagsStatus.classList.add("error");
            return;
        }
        allowedTagsStatus.textContent = "保存中...";
        allowedTagsStatus.classList.remove("error");
        try {
            await callApi(
                "PUT",
                "/groups/" + encodeURIComponent(groupName) + "/tags",
                { tags: allowedTagsDraft },
            );
            allowedTagsStatus.textContent = "保存しました。";
        } catch (e) {
            allowedTagsStatus.textContent = "保存に失敗しました: " + e.message;
            allowedTagsStatus.classList.add("error");
        }
    });

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
    });

    putDocumentForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        putStatus.textContent = "登録中...";
        putStatus.classList.remove("error");

        const groupName = document.getElementById("putGroupName").value.trim();
        const fileName = document.getElementById("putFileName").value.trim();
        const url = document.getElementById("putUrl").value.trim();
        const text = document.getElementById("putText").value;
        const pdfFile = document.getElementById("putPdfFile").files[0];

        try {
            const body = { fileName };
            if (url) body.url = url;

            if (pdfFile) {
                body.mimeType = "application/pdf";
                body.fileBase64 = await readFileAsBase64(pdfFile);
            } else {
                body.text = text;
            }

            const putRes = await callApi(
                "POST",
                "/groups/" + encodeURIComponent(groupName) + "/documents",
                body,
            );
            putStatus.textContent = "処理中 (jobId: " + putRes.jobId + ")...";
            const job = await waitForJob(putRes.jobId);
            if (job.status === "success") {
                putStatus.textContent = "登録完了しました。";
                await refreshGroups();
                showGroupDocuments(groupName);
            } else {
                putStatus.textContent = "登録失敗: " + job.error;
                putStatus.classList.add("error");
            }
        } catch (e) {
            putStatus.textContent = "エラー: " + e.message;
            putStatus.classList.add("error");
        }
    });

    searchForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        searchResult.textContent = "検索中...";

        const groupName = document.getElementById("searchGroupName").value.trim();
        const message = document.getElementById("searchMessage").value.trim();
        const tagsRaw = document.getElementById("searchTags").value.trim();
        const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

        try {
            const body = { message };
            if (tags && tags.length > 0) body.tags = tags;
            const res = await callApi(
                "POST",
                "/groups/" + encodeURIComponent(groupName) + "/search",
                body,
            );
            renderMarkdown(searchResult, buildSearchResultMarkdown(res));
        } catch (e) {
            searchResult.textContent = "エラー: " + e.message;
        }
    });

    // 初期表示.
    // リロード時、ブラウザが前回選択済みの値を <select> に復元する場合があるが、
    // これは change イベントを発火させないため、復元された値があれば明示的に
    // 文書一覧・許可タグ一覧の表示を行う (groupSelect.value を programmatic に
    // 上書きする _fillGroupOptions() 内の代入も同様に change を発火させない).
    refreshGroups().then(() => {
        if (groupSelect.value) {
            showGroupDocuments(groupSelect.value);
            loadAllowedTags(groupSelect.value);
        }
    });
})();
