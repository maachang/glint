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
            searchResult.textContent = res.answer;
        } catch (e) {
            searchResult.textContent = "エラー: " + e.message;
        }
    });

    // 初期表示.
    refreshGroups();
})();
