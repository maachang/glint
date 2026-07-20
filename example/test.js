// test.
const fs = require("fs");
const vg = require("../src/vectorGroup.js");
const args = require("../src/args.js");

// ファイル取得.
const readFile = function (name) {
    return fs.readFileSync(name, "utf8");
};

const GROUP_NAME = "テストグループ";

// [VectorGroup]読み込み対象のファイル群.
// ここに実際のRAGに渡すファイルをセット.
const VG_FILE_LIST = [
    
];

// Ragファイル登録.
const regRagFileList = async function () {
    let tm = Date.now();
    // VectorGroupに登録.
    let cnt = 0;
    const vgLen = VG_FILE_LIST.length;
    console.log("Ragファイル登録(" + vgLen + "):");
    for (let i = 0; i < vgLen; i++) {
        const name = VG_FILE_LIST[i];
        try {
            console.log("変換対象(" + vgLen + "/" + (i + 1) + "): " + name);
            await vg.putTextFileToVectorGroup(
                GROUP_NAME,
                name,
                "http://127.0.0.1/" + name,
                readFile("../test/files/" + name),
            );
        } catch (e) {
            cnt++;
            if (cnt >= 3) {
                // リトライ上限.
                throw e;
            }
            // エラー通知.
            console.warn(e);
            // リトライ.
            i--;
            console.log("# リトライ: " + cnt);
        }
    }
    console.log(
        "Ragファイル登録完了(" + vgLen + "): " + (Date.now() - tm) + " msec",
    );
};

// 組み込み検索を実施.
const testSearchEmb = async function (message, noOut) {
    const vgObj = await vg.loadVectorGroup(GROUP_NAME);
    const res = await vg.searchEmbedding(vgObj, message);
    const len = res.length;
    if (noOut != true) {
        console.log("質問：" + message);
        console.log("検索結果候補: " + len);
        for (let i = 0; i < len; i++) {
            const em = res[i];
            console.log(
                "# (" + i + ")score: " + em.score + ": [" + em.docName + "]",
            );
        }
    }
    return res;
};

// RAG検索して結果を出力.
const testRagSearch = async function (message) {
    if (message == undefined || message == null) {
        console.log("質問が設定されていません");
        return;
    }
    const tm = Date.now();
    // ベクトル検索.
    const res = await testSearchEmb(message, false);
    const resRag = await vg.searchInference(res, message);

    console.log("回答内容(" + (Date.now() - tm) + " msec): \n" + JSON.stringify(resRag, null, "  "));
};

// RAGファイルを登録(かなり時間がかかる）).
regRagFileList();

// 組み込み検索.
const message = args.getParams(0);
//console.log("質問メッセージ: " + message);
//testSearchEmb(message);
//testRagSearch(message);
