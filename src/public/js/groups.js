// public/js/groups.js
// グループ管理ページ (groups.mt.html) のロジック.
// グループ一覧・新規作成・許可タグ一覧編集・文書一覧/タグカテゴリ集計を扱う.
(function () {
    "use strict";

    const callApi = window.Glint.callApi;
    const escapeHtml = window.Glint.escapeHtml;

    const groupSelect = document.getElementById("groupSelect");
    const refreshGroupsBtn = document.getElementById("refreshGroupsBtn");
    const documentsArea = document.getElementById("documentsArea");
    const allowedTagsChips = document.getElementById("allowedTagsChips");
    const allowedTagInput = document.getElementById("allowedTagInput");
    const addAllowedTagBtn = document.getElementById("addAllowedTagBtn");
    const saveAllowedTagsBtn = document.getElementById("saveAllowedTagsBtn");
    const allowedTagsStatus = document.getElementById("allowedTagsStatus");
    const newGroupNameInput = document.getElementById("newGroupName");
    const createGroupBtn = document.getElementById("createGroupBtn");
    const createGroupStatus = document.getElementById("createGroupStatus");
    const docSearchInput = document.getElementById("docSearchInput");
    const docTagFilterSelect = document.getElementById("docTagFilterSelect");
    const documentsPagerTop = document.getElementById("documentsPagerTop");
    const documentsPagerBottom = document.getElementById("documentsPagerBottom");

    // 編集中の許可タグ一覧 (保存ボタン押下時にPUTする).
    let allowedTagsDraft = [];

    // 文書一覧の現在のページ・検索条件 (グループ切り替え時にリセットする).
    let docListState = { page: 1, search: "", tag: "" };

    // ファイル名検索の入力デバウンス用タイマー.
    let docSearchDebounceTimer = null;

    // 前回入力値の復元・自動保存.
    // groupSelectの復元はrefreshGroups()より前に行う (refreshGroups内の
    // _fillGroupOptions()が現在の選択値を維持する仕組みを利用するため).
    window.Glint.bindPersistentInputs(["groupSelect", "newGroupName"]);

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

    // グループ一覧を再読み込みして <select> に反映する.
    const refreshGroups = async function () {
        try {
            const { groups } = await callApi("GET", "/groups");
            _fillGroupOptions(groupSelect, groups);
        } catch (e) {
            documentsArea.innerHTML =
                '<p class="error">グループ一覧の取得に失敗しました: ' + e.message + "</p>";
        }
    };

    // タグ絞り込み用<select>の内容を、現在の選択値を維持しつつ集計タグ一覧で置き換える.
    const _fillTagFilterOptions = function (tags) {
        const current = docTagFilterSelect.value;
        docTagFilterSelect.innerHTML = '<option value="">-- すべて --</option>';
        tags.forEach((t) => {
            const opt = document.createElement("option");
            opt.value = t.name;
            opt.textContent = t.name + " (" + t.count + ")";
            docTagFilterSelect.appendChild(opt);
        });
        if (tags.some((t) => t.name === current)) {
            docTagFilterSelect.value = current;
        }
    };

    // ページ送りボタンを1箇所 (top/bottom共通) 描画する.
    const _renderPagerInto = function (container, idPrefix, groupName, page, totalPages, total) {
        container.innerHTML =
            '<button type="button" id="' + idPrefix + 'PrevBtn"' + (page <= 1 ? " disabled" : "") + ">← 前へ</button>" +
            ' <span class="hint">' + page + " / " + totalPages + " ページ (全" + total + "件)</span> " +
            '<button type="button" id="' + idPrefix + 'NextBtn"' + (page >= totalPages ? " disabled" : "") + ">次へ →</button>";
        document.getElementById(idPrefix + "PrevBtn").addEventListener("click", () => {
            if (docListState.page > 1) {
                docListState.page--;
                showGroupDocuments(groupName);
            }
        });
        document.getElementById(idPrefix + "NextBtn").addEventListener("click", () => {
            if (docListState.page < totalPages) {
                docListState.page++;
                showGroupDocuments(groupName);
            }
        });
    };

    // ページ送りボタンを上下両方に描画する.
    const _renderDocumentsPager = function (groupName, page, pageSize, total) {
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        _renderPagerInto(documentsPagerTop, "docPagerTop", groupName, page, totalPages, total);
        _renderPagerInto(documentsPagerBottom, "docPagerBottom", groupName, page, totalPages, total);
    };

    // 指定グループの文書一覧・タグ/カテゴリ集計を表示する.
    // docListState (page/search/tag) の内容でページング・絞り込みを行う.
    const showGroupDocuments = async function (groupName) {
        if (!groupName) {
            documentsArea.innerHTML = '<p class="hint">グループを選択してください。</p>';
            documentsPagerTop.innerHTML = "";
            documentsPagerBottom.innerHTML = "";
            return;
        }
        documentsArea.innerHTML = '<p class="hint">読み込み中...</p>';
        try {
            const [docs, stats, tagsRes] = await Promise.all([
                callApi(
                    "GET",
                    "/groups/" + encodeURIComponent(groupName) + "/documents" +
                        "?page=" + docListState.page +
                        (docListState.search ? "&search=" + encodeURIComponent(docListState.search) : "") +
                        (docListState.tag ? "&tag=" + encodeURIComponent(docListState.tag) : ""),
                ),
                callApi("GET", "/groups/" + encodeURIComponent(groupName) + "/stats"),
                callApi("GET", "/groups/" + encodeURIComponent(groupName) + "/tags"),
            ]);

            _fillTagFilterOptions(stats.tags);

            let html = "<p>文書数: " + docs.total + " (絞り込み前の全体: " + stats.totalDocuments + ")</p>";

            if (stats.tags.length > 0) {
                html += "<p>タグ: ";
                stats.tags.forEach((t) => {
                    html +=
                        '<span class="tag-chip">' + escapeHtml(t.name) + " (" + t.count + ")</span>";
                });
                html += "</p>";
            }

            // 許可タグ一覧が設定されているグループのみ、タグ列をselectBox化する.
            // 未設定 (自由生成のまま) の場合は自由入力のテキストフィールドとする.
            const allowedTags = Array.isArray(tagsRes.tags) ? tagsRes.tags : [];
            const useSelect = allowedTags.length > 0;

            html += "<table><thead><tr><th>文書名</th><th>タグ</th><th>カテゴリ</th><th>URL</th><th></th></tr></thead><tbody>";
            docs.documents.forEach((d) => {
                const currentTag = d.tag || "";
                let tagCell;
                if (useSelect) {
                    // 許可タグ一覧・"その他"に加え、現在のタグがどちらにも
                    // 含まれない場合(許可タグ変更前に登録された等)も選択肢に残す.
                    const options = allowedTags.slice();
                    if (options.indexOf("その他") === -1) options.push("その他");
                    if (currentTag && options.indexOf(currentTag) === -1) {
                        options.unshift(currentTag);
                    }
                    tagCell =
                        '<select class="docTagSelect" data-doc="' + escapeHtml(d.name) + '">' +
                        '<option value=""' + (currentTag === "" ? " selected" : "") + "></option>" +
                        options
                            .map(
                                (t) =>
                                    '<option value="' + escapeHtml(t) + '"' +
                                    (t === currentTag ? " selected" : "") + ">" +
                                    escapeHtml(t) + "</option>",
                            )
                            .join("") +
                        "</select>";
                } else {
                    tagCell =
                        '<input type="text" class="docTagInput" data-doc="' + escapeHtml(d.name) + '" ' +
                        'value="' + escapeHtml(currentTag) + '">';
                }
                html +=
                    "<tr>" +
                    "<td>" + escapeHtml(d.name) + "</td>" +
                    "<td>" + tagCell + "</td>" +
                    "<td>" + escapeHtml((d.category || []).join(", ")) + "</td>" +
                    '<td><a href="' + escapeHtml(d.url) + '" target="_blank">link</a></td>' +
                    '<td><button data-doc="' + escapeHtml(d.name) + '" class="deleteDocBtn">削除</button></td>' +
                    "</tr>";
            });
            html += "</tbody></table>";

            documentsArea.innerHTML = html;

            // タグ修正 (selectBox変更時 / テキスト入力確定時に即時保存する).
            const saveDocTag = async function (docName, tag, category) {
                try {
                    await callApi(
                        "PUT",
                        "/groups/" + encodeURIComponent(groupName) + "/documents/" +
                            encodeURIComponent(docName) + "/tags",
                        { tag: tag || null, category: category },
                    );
                } catch (e) {
                    alert("タグの更新に失敗しました: " + e.message);
                    showGroupDocuments(groupName);
                }
            };
            documentsArea.querySelectorAll(".docTagSelect").forEach((sel) => {
                sel.addEventListener("change", () => {
                    const docName = sel.getAttribute("data-doc");
                    const doc = docs.documents.find((d) => d.name === docName);
                    saveDocTag(docName, sel.value, (doc && doc.category) || []);
                });
            });
            documentsArea.querySelectorAll(".docTagInput").forEach((inp) => {
                inp.addEventListener("change", () => {
                    const docName = inp.getAttribute("data-doc");
                    const doc = docs.documents.find((d) => d.name === docName);
                    saveDocTag(docName, inp.value.trim(), (doc && doc.category) || []);
                });
            });

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

            _renderDocumentsPager(groupName, docs.page, docs.pageSize, docs.total);
        } catch (e) {
            documentsArea.innerHTML = '<p class="error">取得に失敗しました: ' + e.message + "</p>";
            documentsPagerTop.innerHTML = "";
            documentsPagerBottom.innerHTML = "";
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

    // ─── イベント登録 ───────────────────────────────────

    refreshGroupsBtn.addEventListener("click", refreshGroups);

    // グループ切り替え時は検索条件・ページを初期化する.
    const _resetDocListState = function () {
        docListState = { page: 1, search: "", tag: "" };
        docSearchInput.value = "";
        docTagFilterSelect.value = "";
    };

    groupSelect.addEventListener("change", () => {
        _resetDocListState();
        showGroupDocuments(groupSelect.value);
        loadAllowedTags(groupSelect.value);
    });

    docSearchInput.addEventListener("input", () => {
        clearTimeout(docSearchDebounceTimer);
        docSearchDebounceTimer = setTimeout(() => {
            docListState.search = docSearchInput.value.trim();
            docListState.page = 1;
            showGroupDocuments(groupSelect.value);
        }, 400);
    });

    docTagFilterSelect.addEventListener("change", () => {
        docListState.tag = docTagFilterSelect.value;
        docListState.page = 1;
        showGroupDocuments(groupSelect.value);
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
            _resetDocListState();
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
