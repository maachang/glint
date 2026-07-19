// public/js/documents.js
// 文書登録ページ (documents.mt.html) のロジック.
(function () {
    "use strict";

    const callApi = window.Glint.callApi;

    const putDocumentForm = document.getElementById("putDocumentForm");
    const putStatus = document.getElementById("putStatus");

    // 前回入力値の復元・自動保存 (PDFファイル欄は復元不可のため対象外).
    window.Glint.bindPersistentInputs(["putGroupName", "putFileName", "putUrl", "putText"]);

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

    // ジョブ完了をポーリングする.
    const waitForJob = async function (jobId) {
        for (let i = 0; i < 300; i++) {
            const job = await callApi("GET", "/jobs/" + jobId);
            if (job.status !== "pending") return job;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("ジョブの完了待ちがタイムアウトしました。");
    };

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
            } else {
                putStatus.textContent = "登録失敗: " + job.error;
                putStatus.classList.add("error");
            }
        } catch (e) {
            putStatus.textContent = "エラー: " + e.message;
            putStatus.classList.add("error");
        }
    });
})();
