// evalSearch.js
//
// RAG検索(ベクトル検索)の精度を定量的に評価するためのCLIスクリプト.
//
// 【目的】
//   embeddingモデルの変更・チャンク分割の変更・リランキング/ハイブリッド検索の
//   導入などを行った際に、「実際に検索精度が改善したか」を数値(Recall@K)で
//   判断できるようにする. これが無いと、変更の効果が主観的な感覚での判断に
//   なってしまうため、各種改善の前提として用意する.
//
// 【評価データセットの形式】(例: tests/eval/サンプルグループ.json)
//   [
//     {
//       "query": "原告が主張する損害の根拠は？",
//       "expectedDocs": ["原告準備書面１", "原告準備書面４"],
//       "tags": ["法律"],       // 省略可 (事前フィルタの効果検証用)
//       "categories": ["訴訟"]  // 省略可
//     },
//     ...
//   ]
//   expectedDocs は拡張子なしの docName (vg.searchEmbedding() が返す docName と同一表記).
//
// 【指標】
//   Recall@K = (質問ごとに、expectedDocsのうち上位K件のユニーク文書に含まれた件数) / expectedDocsの総数
//   を全質問で平均した値. K は複数指定可能 (デフォルト: 5, 10).
//
//   検索結果 (VectorChunk[]) は同一docNameのチャンクが複数含まれ得るため、
//   スコア降順のまま docName の初出順で重複除去してランキングを作る.
//
// 【実行方法】
//   node scripts/evalSearch.js <groupName> <evalFilePath> [-k 5,10] [-o out.json]
//
//   例: node scripts/evalSearch.js "サンプルグループ" tests/eval/サンプルグループ.json
//       node scripts/evalSearch.js "サンプルグループ" tests/eval/サンプルグループ.json -k 3,5,10 -o result.json

const fs = require("fs");
const path = require("path");
const args = require("../src/args.js");
const vg = require("../src/vectorGroup.js");

// 検索結果 (VectorChunk[], スコア降順) から、docName単位で重複除去したランキングを作る.
const _toDocRanking = function (chunks) {
    const seen = new Set();
    const ranking = [];
    for (let i = 0; i < chunks.length; i++) {
        const docName = chunks[i].docName;
        if (!seen.has(docName)) {
            seen.add(docName);
            ranking.push(docName);
        }
    }
    return ranking;
};

// 1件の評価データに対して、K値ごとのRecallを計算する.
const _evalOne = async function (groupName, item, kList) {
    const vgObj = await vg.loadVectorGroup(groupName);
    const options = {};
    if (Array.isArray(item.tags) && item.tags.length > 0) {
        options.tags = item.tags;
    }
    if (Array.isArray(item.categories) && item.categories.length > 0) {
        options.categories = item.categories;
    }
    const chunks = await vg.searchEmbedding(vgObj, item.query, options);
    const ranking = _toDocRanking(chunks);

    const expected = Array.isArray(item.expectedDocs) ? item.expectedDocs : [];
    const recallByK = {};
    const hitDocsByK = {};
    for (let i = 0; i < kList.length; i++) {
        const k = kList[i];
        const topK = new Set(ranking.slice(0, k));
        const hitDocs = expected.filter((d) => topK.has(d));
        hitDocsByK[k] = hitDocs;
        recallByK[k] = expected.length === 0 ? null : hitDocs.length / expected.length;
    }

    return {
        query: item.query,
        expectedDocs: expected,
        ranking,
        recallByK,
        hitDocsByK,
    };
};

const main = async function () {
    const groupName = args.getParams(0);
    const evalFilePath = args.getParams(1);
    if (!groupName || !evalFilePath) {
        console.log(
            "使い方: node scripts/evalSearch.js <groupName> <evalFilePath> [-k 5,10] [-o out.json]",
        );
        process.exit(1);
    }

    const kOpt = args.get("-k", "--k");
    const kList = kOpt
        ? kOpt.split(",").map((s) => parseInt(s.trim(), 10))
        : [5, 10];

    const outPath = args.get("-o", "--out");

    const dataset = JSON.parse(fs.readFileSync(path.resolve(evalFilePath), "utf8"));

    console.log(
        "評価開始: group=" + groupName + ", 質問数=" + dataset.length + ", K=" + kList.join(","),
    );

    const results = [];
    for (let i = 0; i < dataset.length; i++) {
        const item = dataset[i];
        const r = await _evalOne(groupName, item, kList);
        results.push(r);

        console.log("");
        console.log("[" + (i + 1) + "/" + dataset.length + "] 質問: " + r.query);
        console.log("  正解文書: " + JSON.stringify(r.expectedDocs));
        for (let j = 0; j < kList.length; j++) {
            const k = kList[j];
            const recall = r.recallByK[k];
            console.log(
                "  Recall@" + k + ": " +
                    (recall === null ? "N/A (正解文書未指定)" : recall.toFixed(3)) +
                    " (ヒット: " + JSON.stringify(r.hitDocsByK[k]) + ")",
            );
        }
    }

    // K値ごとの平均Recallを算出 (正解文書が無い質問はN/Aとして平均対象から除外).
    console.log("");
    console.log("=== 全体結果 (質問数: " + results.length + ") ===");
    const summary = {};
    for (let j = 0; j < kList.length; j++) {
        const k = kList[j];
        const valid = results.filter((r) => r.recallByK[k] !== null);
        const avg =
            valid.length === 0
                ? null
                : valid.reduce((sum, r) => sum + r.recallByK[k], 0) / valid.length;
        summary[k] = avg;
        console.log(
            "平均Recall@" + k + ": " + (avg === null ? "N/A" : avg.toFixed(3)) +
                " (対象質問数: " + valid.length + ")",
        );
    }

    if (outPath) {
        fs.writeFileSync(
            path.resolve(outPath),
            JSON.stringify({ groupName, kList, summary, results }, null, "  "),
        );
        console.log("");
        console.log("結果をファイル出力しました: " + outPath);
    }
};

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
