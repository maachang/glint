// test2.
// test.js と同じ内容を、glintClient.js (apiServer.js へのHTTP APIクライアント) 経由で行う版.
//
// test.js は src/vectorGroup.js を直接requireして低レベルAPIを呼んでいたが、
// こちらは実際に起動している apiServer.js に対してHTTP経由でアクセスする
// (事前に `node src/apiServer.js` 等でサーバーを起動しておくこと).
//
// AIメモ:
// - apiServer.js の POST /api/groups/:group/search は「ベクトル検索 + RAG推論」を
//   1回のAPI呼び出しで行う仕様のため、test.js のように「ベクトル検索のみ」を
//   個別に呼び出す(testSearchEmb相当)手段は無い。そのため本ファイルでは
//   client.search() の結果(message + list)のみを出力する.
const fs = require("fs");
const GlintClient = require("../client/glintClient.js");
const args = require("../src/args.js");

// apiServer.js の待受先. 環境変数 GLINT_BASE_URL で上書き可能.
const BASE_URL = process.env.GLINT_BASE_URL || "http://127.0.0.1:3000";
const client = new GlintClient(BASE_URL);

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
            // url は指定しない (apiServer.js側で自動発行される).
            // 長文書はサマリー生成・埋め込みに時間がかかるため、タイムアウトを延長する.
            await client.registerTextDocumentAndWait(
                GROUP_NAME,
                name,
                readFile("../test/files/" + name),
                { timeoutMs: 1800000 },
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

// RAG検索して結果を出力.
const testRagSearch = async function (message) {
    if (message == undefined || message == null) {
        console.log("質問が設定されていません");
        return;
    }
    const tm = Date.now();
    const resRag = await client.search(GROUP_NAME, message);
    console.log("回答内容(" + (Date.now() - tm) + " msec): \n" + JSON.stringify(resRag, null, "  "));
};

// RAGファイルを登録(かなり時間がかかる）).
regRagFileList();

// 組み込み検索.
const message = args.getParams(0);
//console.log("質問メッセージ: " + message);
//testRagSearch(message);
