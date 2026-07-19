/**
 * metaStore.js
 *
 * SQLite (node:sqlite / bun:sqlite) を使った補助的なメタデータストア.
 * .vgs/.vss (ベクトル本体・サマリー) とは別に、以下を管理する.
 *
 *   - documents:   文書ごとの tag/category (グループ内タグ/カテゴリ集計を高速化するため)
 *   - chunk_fts:   チャンクテキストの全文検索インデックス (FTS5, ハイブリッド検索のBM25用)
 *   - search_log:  検索ログ (質問文・引用文書一覧等. conf.searchLogEnabled=true の場合のみ記録)
 *
 * AIメモ:
 * - node:sqlite は Node.js 22.5+ の実験的機能 (package.json の engines で必須バージョンを
 *   22.5.0以上に上げている). Bunコンパイル時は bun:sqlite の方が安定して使えるため、
 *   実行環境に応じてどちらかを動的に選択する (_getDatabaseSyncClass).
 *   両者は prepare().all()/get()/run() 、exec() のAPIがほぼ同一のため、この程度の
 *   薄い切り替えだけで両対応できる.
 * - DBファイルは vectorStorePath 配下に1つ (glint.sqlite) にまとめ、groupName列で
 *   各グループのデータを区別する (.vgs/.vss のようなグループ単位ファイル分割はしない).
 * - このモジュール導入前から存在するグループには documents/chunk_fts にデータが無いため、
 *   backfill_status テーブルで「バックフィル済みか」を管理し、初回アクセス時に
 *   .vss/.vgs から一括で取り込む (ensureDocumentsBackfilled/ensureChunkFtsBackfilled).
 *   これにより、利用者側で別途移行作業を行う必要がない.
 * - chunk_fts の tokenize は "trigram" を使用 (形態素解析器が無くても日本語の部分一致
 *   検索ができるため。単語分かち書きが無いCJK言語向けの現実的な選択).
 */
(function () {
    "use strict";

    const fs = require("fs");
    const path = require("path");
    const util = require("./util");
    const Config = require("./config");

    // ═══════════════════════════════════════════════════════════════
    // DB接続管理
    // ═══════════════════════════════════════════════════════════════

    let _db = null;
    let _dbPath = null;

    // Bun実行時は bun:sqlite、それ以外は node:sqlite の DatabaseSync 相当クラスを返す.
    const _getDatabaseSyncClass = function () {
        if (typeof Bun !== "undefined") {
            return require("bun:sqlite").Database;
        }
        return require("node:sqlite").DatabaseSync;
    };

    // dirPath (vectorStore用ディレクトリ) から glint.sqlite の絶対パスを組み立てる.
    const _resolveDbPath = function (dirPath) {
        const conf = Config.getInstance();
        dirPath = dirPath || util.joinPath(conf.dirPath, conf.vectorStorePath);
        if (dirPath.endsWith("/")) dirPath = dirPath.slice(0, -1);
        fs.mkdirSync(dirPath, { recursive: true });
        return path.join(dirPath, "glint.sqlite");
    };

    // DB接続を取得する (未接続 or dirPathが変わった場合は開き直す).
    const _getDb = function (dirPath) {
        const dbPath = _resolveDbPath(dirPath);
        if (_db != null && _dbPath === dbPath) {
            return _db;
        }
        if (_db != null) {
            try {
                _db.close();
            } catch (e) {
                // close失敗は無視する (既に閉じている場合等).
            }
        }
        const DatabaseSyncClass = _getDatabaseSyncClass();
        _db = new DatabaseSyncClass(dbPath);
        _dbPath = dbPath;
        _db.exec("PRAGMA journal_mode = WAL;");
        _db.exec(
            "CREATE TABLE IF NOT EXISTS documents (" +
                "groupName TEXT NOT NULL, " +
                "docName TEXT NOT NULL, " +
                "tag TEXT, " +
                "category TEXT, " +
                "parsed INTEGER NOT NULL DEFAULT 1, " +
                "PRIMARY KEY (groupName, docName)" +
                ");",
        );
        _db.exec(
            "CREATE INDEX IF NOT EXISTS idx_documents_group_tag " +
                "ON documents(groupName, tag);",
        );
        _db.exec(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(" +
                'groupName, docName, indexNo UNINDEXED, text, tokenize="trigram"' +
                ");",
        );
        _db.exec(
            "CREATE TABLE IF NOT EXISTS backfill_status (" +
                "groupName TEXT PRIMARY KEY, " +
                "documentsDone INTEGER NOT NULL DEFAULT 0, " +
                "chunkFtsDone INTEGER NOT NULL DEFAULT 0" +
                ");",
        );
        // チャンク本体 (テキスト+embedding). 従来の.vgsファイルの実データ.
        _db.exec(
            "CREATE TABLE IF NOT EXISTS chunks (" +
                "groupName TEXT NOT NULL, " +
                "docName TEXT NOT NULL, " +
                "indexNo INTEGER NOT NULL, " +
                "allLength INTEGER NOT NULL, " +
                "text TEXT NOT NULL, " +
                "embedding BLOB NOT NULL, " +
                "PRIMARY KEY (groupName, docName, indexNo)" +
                ");",
        );
        _db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_group ON chunks(groupName);");
        // 文書サマリー本体 (要約テキスト・URL・登録時刻). 従来の.vssファイルの実データ
        // (allowedTagsは別途group_settingsテーブルで管理する).
        _db.exec(
            "CREATE TABLE IF NOT EXISTS summaries (" +
                "groupName TEXT NOT NULL, " +
                "docName TEXT NOT NULL, " +
                "text TEXT NOT NULL, " +
                "url TEXT, " +
                "time INTEGER NOT NULL, " +
                "PRIMARY KEY (groupName, docName)" +
                ");",
        );
        _db.exec(
            "CREATE TABLE IF NOT EXISTS search_log (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "groupName TEXT NOT NULL, " +
                "message TEXT NOT NULL, " +
                "tags TEXT, " +
                "categories TEXT, " +
                "resultList TEXT, " +
                "createdAt INTEGER NOT NULL" +
                ");",
        );
        _db.exec(
            "CREATE TABLE IF NOT EXISTS group_settings (" +
                "groupName TEXT PRIMARY KEY, " +
                "allowedTags TEXT" +
                ");",
        );
        _db.exec(
            "CREATE TABLE IF NOT EXISTS groups (" + "groupName TEXT PRIMARY KEY" + ");",
        );
        return _db;
    };

    // ═══════════════════════════════════════════════════════════════
    // documents (タグ/カテゴリ集計用)
    // ═══════════════════════════════════════════════════════════════

    /**
     * 文書のtag/category情報をUPSERTする (putTextFileToVectorGroup()から呼ぶ).
     * @param {string} groupName
     * @param {string} docName
     * @param {string|null} tag
     * @param {string[]} category
     * @param {boolean} parsed  サマリーのJSONパースに成功したかどうか.
     * @param {string} [dirPath]
     */
    const upsertDocumentMeta = function (groupName, docName, tag, category, parsed, dirPath) {
        const db = _getDb(dirPath);
        db.prepare(
            "INSERT INTO documents (groupName, docName, tag, category, parsed) VALUES (?, ?, ?, ?, ?) " +
                "ON CONFLICT(groupName, docName) DO UPDATE SET " +
                "tag = excluded.tag, category = excluded.category, parsed = excluded.parsed",
        ).run(
            groupName,
            docName,
            tag || null,
            Array.isArray(category) && category.length > 0 ? JSON.stringify(category) : null,
            parsed ? 1 : 0,
        );
        // documentsテーブルへの直接書き込みが行われた時点で、そのグループのdocuments
        // データは常に最新・正の状態になる. 以後ensureDocumentsBackfilled()による
        // legacy(.vss本文からの)再構築で上書き・消失させないよう、済み扱いにマークする.
        db.prepare(
            "INSERT INTO backfill_status (groupName, documentsDone) VALUES (?, 1) " +
                "ON CONFLICT(groupName) DO UPDATE SET documentsDone = 1",
        ).run(groupName);
    };

    /**
     * 文書のtag/category情報を削除する (removeTextFileFromVectorGroup()から呼ぶ).
     */
    const deleteDocumentMeta = function (groupName, docName, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM documents WHERE groupName = ? AND docName = ?").run(groupName, docName);
    };

    /**
     * このモジュール導入前から存在するグループのために、.vssの内容から
     * documentsテーブルを一括で構築する (未実施の場合のみ実行される).
     * @param {string} groupName
     * @param {VectorSummary} summary
     * @param {function} parseSummaryJson  サマリーテキストを{tag,category,summary}にパースする関数.
     * @param {string} [dirPath]
     */
    const ensureDocumentsBackfilled = function (groupName, summary, parseSummaryJson, dirPath) {
        const db = _getDb(dirPath);
        const row = db
            .prepare("SELECT documentsDone FROM backfill_status WHERE groupName = ?")
            .get(groupName);
        if (row && row.documentsDone) {
            return;
        }
        const names = summary.getDocuments();
        db.prepare("DELETE FROM documents WHERE groupName = ?").run(groupName);
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const parsed = parseSummaryJson(summary.getText(name));
            if (parsed == null) {
                upsertDocumentMeta(groupName, name, null, [], false, dirPath);
                continue;
            }
            const tag = typeof parsed.tag === "string" ? parsed.tag : null;
            const category = Array.isArray(parsed.category)
                ? parsed.category
                : parsed.category
                  ? [parsed.category]
                  : [];
            upsertDocumentMeta(groupName, name, tag, category, true, dirPath);
        }
        db.prepare(
            "INSERT INTO backfill_status (groupName, documentsDone) VALUES (?, 1) " +
                "ON CONFLICT(groupName) DO UPDATE SET documentsDone = 1",
        ).run(groupName);
    };

    /** グループの文書総数・パース失敗数を返す. */
    const getDocumentTotals = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        const row = db
            .prepare(
                "SELECT COUNT(*) as total, " +
                    "SUM(CASE WHEN parsed = 0 THEN 1 ELSE 0 END) as unparsed " +
                    "FROM documents WHERE groupName = ?",
            )
            .get(groupName);
        return {
            total: row && row.total ? row.total : 0,
            unparsed: row && row.unparsed ? row.unparsed : 0,
        };
    };

    /** グループ内のtagごとの件数一覧を返す ({name, count}[], 件数降順). */
    const getTagCounts = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        return db
            .prepare(
                "SELECT tag AS name, COUNT(*) AS count FROM documents " +
                    "WHERE groupName = ? AND tag IS NOT NULL AND tag != '' " +
                    "GROUP BY tag ORDER BY count DESC",
            )
            .all(groupName);
    };

    /** グループ内のcategoryごとの件数一覧を返す ({name, count}[], 件数降順). */
    const getCategoryCounts = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        return db
            .prepare(
                "SELECT je.value AS name, COUNT(*) AS count " +
                    "FROM documents d, json_each(d.category) je " +
                    "WHERE d.groupName = ? AND d.category IS NOT NULL " +
                    "GROUP BY je.value ORDER BY count DESC",
            )
            .all(groupName);
    };

    /**
     * グループ内の全文書のtag/categoryをまとめて取得する (文書一覧APIで
     * 1文書ごとに再パースする代わりに使う).
     * @param  {string} groupName
     * @param  {string} [dirPath]
     * @return {Map<string, {tag: string|null, category: string[]|null}>}  キー: docName.
     */
    const getAllDocumentMeta = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        const rows = db
            .prepare("SELECT docName, tag, category FROM documents WHERE groupName = ?")
            .all(groupName);
        const map = new Map();
        rows.forEach(function (r) {
            map.set(r.docName, {
                tag: r.tag || null,
                category: r.category ? JSON.parse(r.category) : null,
            });
        });
        return map;
    };

    // ═══════════════════════════════════════════════════════════════
    // group_settings (許可タグ一覧)
    // ═══════════════════════════════════════════════════════════════

    /**
     * グループの許可タグ一覧を取得する.
     * まだSQLite側に移行されていない場合 (このモジュール導入前からのグループ等) は
     * null を返す (呼び出し元で.vssからの移行処理を行う).
     * @param  {string} groupName
     * @param  {string} [dirPath]
     * @return {string[]|null}
     */
    const getAllowedTagsIfExists = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        const row = db
            .prepare("SELECT allowedTags FROM group_settings WHERE groupName = ?")
            .get(groupName);
        if (!row) {
            return null;
        }
        try {
            const parsed = JSON.parse(row.allowedTags);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    };

    /**
     * グループの許可タグ一覧を設定する (無ければ新規作成).
     * @param {string} groupName
     * @param {string[]} tags
     * @param {string} [dirPath]
     */
    const setAllowedTags = function (groupName, tags, dirPath) {
        const db = _getDb(dirPath);
        db.prepare(
            "INSERT INTO group_settings (groupName, allowedTags) VALUES (?, ?) " +
                "ON CONFLICT(groupName) DO UPDATE SET allowedTags = excluded.allowedTags",
        ).run(groupName, JSON.stringify(Array.isArray(tags) ? tags : []));
    };

    // ═══════════════════════════════════════════════════════════════
    // groups (グループ一覧キャッシュ. ディレクトリスキャンの代替)
    // ═══════════════════════════════════════════════════════════════

    /**
     * グループ一覧を返す (groupsテーブルそのもの. ディレクトリスキャンは行わない).
     * @param  {string} [dirPath]
     * @return {string[]}
     */
    const listGroups = function (dirPath) {
        const db = _getDb(dirPath);
        return db
            .prepare("SELECT groupName FROM groups ORDER BY groupName")
            .all()
            .map(function (r) {
                return r.groupName;
            });
    };

    /** グループ一覧キャッシュに1件追加する (既に存在する場合は何もしない). */
    const addGroup = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("INSERT OR IGNORE INTO groups (groupName) VALUES (?)").run(groupName);
    };

    /**
     * 指定グループがキャッシュ(groupsテーブル)に登録されているかを直接確認する.
     * getCachedGroups()と異なり、バックフィル未実施でも(その状態に関わらず)
     * このグループ単体の存在確認ができる.
     */
    const groupExists = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        const row = db.prepare("SELECT 1 FROM groups WHERE groupName = ?").get(groupName);
        return !!row;
    };

    // ═══════════════════════════════════════════════════════════════
    // chunk_fts (ハイブリッド検索のキーワードスコア用)
    // ═══════════════════════════════════════════════════════════════

    /**
     * 指定文書のチャンクをFTS5インデックスに登録する (既存分は一旦削除してから登録).
     * putTextFileToVectorGroup() から呼ぶ.
     * @param {string} groupName
     * @param {string} docName
     * @param {VectorChunk[]} chunks  この文書に対応するVectorChunkの配列.
     * @param {string} [dirPath]
     */
    const replaceDocumentChunkFts = function (groupName, docName, chunks, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM chunk_fts WHERE groupName = ? AND docName = ?").run(
            groupName,
            docName,
        );
        const insert = db.prepare(
            "INSERT INTO chunk_fts (groupName, docName, indexNo, text) VALUES (?, ?, ?, ?)",
        );
        for (let i = 0; i < chunks.length; i++) {
            insert.run(groupName, docName, chunks[i].indexNo, chunks[i].text);
        }
    };

    /** 指定文書のチャンクをFTS5インデックスから削除する (removeTextFileFromVectorGroup()から呼ぶ). */
    const deleteDocumentChunkFts = function (groupName, docName, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM chunk_fts WHERE groupName = ? AND docName = ?").run(
            groupName,
            docName,
        );
    };

    /**
     * このモジュール導入前から存在するグループのために、VectorGroupの全チャンクから
     * FTS5インデックスを一括で構築する (未実施の場合のみ実行される).
     * @param {string} groupName
     * @param {VectorGroup} vg
     * @param {string} [dirPath]
     */
    const ensureChunkFtsBackfilled = function (groupName, vg, dirPath) {
        const db = _getDb(dirPath);
        const row = db
            .prepare("SELECT chunkFtsDone FROM backfill_status WHERE groupName = ?")
            .get(groupName);
        if (row && row.chunkFtsDone) {
            return;
        }
        const chunks = vg.getChunked();
        db.prepare("DELETE FROM chunk_fts WHERE groupName = ?").run(groupName);
        const insert = db.prepare(
            "INSERT INTO chunk_fts (groupName, docName, indexNo, text) VALUES (?, ?, ?, ?)",
        );
        for (let i = 0; i < chunks.length; i++) {
            insert.run(groupName, chunks[i].docName, chunks[i].indexNo, chunks[i].text);
        }
        db.prepare(
            "INSERT INTO backfill_status (groupName, chunkFtsDone) VALUES (?, 1) " +
                "ON CONFLICT(groupName) DO UPDATE SET chunkFtsDone = 1",
        ).run(groupName);
    };

    /**
     * 文字列を文字トライグラム(3-gram)の集合に変換する内部ヘルパー.
     * @param  {string} text
     * @return {Set<string>}
     */
    const _toTrigrams = function (text) {
        const set = new Set();
        const len = text.length;
        for (let i = 0; i <= len - 3; i++) {
            set.add(text.substring(i, i + 3));
        }
        return set;
    };

    /**
     * クエリ文字列に対するチャンク単位のキーワードスコア (0〜1に正規化したBM25) を返す.
     *
     * クエリ全体を1つのフレーズとしてMATCHすると、FTS5は「クエリ全体のトライグラム
     * 列がドキュメント中に連続して出現すること」を要求するため、クエリより短い
     * 部分一致 (例:長い質問文の中の一部だけが文書に含まれる場合) を拾えない。
     * そのため、クエリを自前でトライグラムに分解し、それらを OR で結合したクエリに
     * することで「いずれかのトライグラムが含まれていれば候補になる」形にし、
     * 実際の一致度・ランキングはFTS5のbm25()に委ねる.
     *
     * FTS5のbm25()は値が小さい(負)ほど良い一致を示すため、符号反転した上で
     * 「今回の検索結果内での最大値」を基準に0〜1へ正規化する (相対スコアのため、
     * 別クエリ間でのスコアの絶対比較はできない点に注意).
     *
     * @param  {string} groupName
     * @param  {string} queryText  クエリチャンクの文字列.
     * @param  {string} [dirPath]
     * @return {Map<string, number>}  キー: "docName:indexNo", 値: 0〜1のスコア.
     */
    const getKeywordScoreMap = function (groupName, queryText, dirPath) {
        const map = new Map();
        if (typeof queryText !== "string") {
            return map;
        }
        const trigrams = Array.from(_toTrigrams(queryText));
        // trigramトークナイザは3文字未満のクエリを扱えないため、その場合は
        // キーワードスコア無し (ベクトルスコアのみ) にフォールバックする.
        if (trigrams.length === 0) {
            return map;
        }
        const db = _getDb(dirPath);
        const ftsQuery = trigrams
            .map(function (t) {
                return '"' + t.replace(/"/g, '""') + '"';
            })
            .join(" OR ");
        let rows;
        try {
            rows = db
                .prepare(
                    "SELECT docName, indexNo, bm25(chunk_fts) as score FROM chunk_fts " +
                        "WHERE groupName = ? AND chunk_fts MATCH ?",
                )
                .all(groupName, ftsQuery);
        } catch (e) {
            // MATCH構文エラー等が発生した場合はキーワードスコアを諦め、
            // ベクトルスコアのみにフォールバックする (検索自体は継続させる).
            console.warn("#chunk_fts検索に失敗: " + e.message);
            return map;
        }
        if (rows.length === 0) {
            return map;
        }
        let maxRaw = 0;
        const raws = rows.map(function (r) {
            const raw = -r.score; // bm25は小さい(負)ほど良いため反転する.
            if (raw > maxRaw) maxRaw = raw;
            return { key: r.docName + ":" + r.indexNo, raw };
        });
        raws.forEach(function (r) {
            map.set(r.key, maxRaw > 0 ? r.raw / maxRaw : 0);
        });
        return map;
    };

    // ═══════════════════════════════════════════════════════════════
    // グループ削除時のクリーンアップ
    // ═══════════════════════════════════════════════════════════════

    /** グループに紐づく全SQLデータ (documents/chunk_fts/backfill_status) を削除する. */
    const deleteGroup = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM documents WHERE groupName = ?").run(groupName);
        db.prepare("DELETE FROM chunk_fts WHERE groupName = ?").run(groupName);
        db.prepare("DELETE FROM backfill_status WHERE groupName = ?").run(groupName);
        db.prepare("DELETE FROM group_settings WHERE groupName = ?").run(groupName);
        db.prepare("DELETE FROM groups WHERE groupName = ?").run(groupName);
        db.prepare("DELETE FROM chunks WHERE groupName = ?").run(groupName);
        db.prepare("DELETE FROM summaries WHERE groupName = ?").run(groupName);
    };

    // ═══════════════════════════════════════════════════════════════
    // chunks (チャンク本体. 従来の.vgsファイルの実データ)
    // ═══════════════════════════════════════════════════════════════

    /** Float32ArrayをBLOB保存用のBufferに変換する内部ヘルパー. */
    const _embeddingToBlob = function (embedding) {
        return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    };

    /** BLOB(Buffer/Uint8Array)をFloat32Arrayに復元する内部ヘルパー. */
    const _blobToEmbedding = function (blob) {
        const buf = Buffer.from(blob);
        // .slice()で元バッファから切り離した独立コピーを返す (安全のため).
        return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
    };

    /**
     * バックアップ復元(importGroupFiles)で解析したチャンク配列を一括インポートする.
     * @param {string} groupName
     * @param {Array<{docName,indexNo,allLength,text,embedding}>} chunks
     * @param {string} [dirPath]
     */
    const importChunks = function (groupName, chunks, dirPath) {
        const db = _getDb(dirPath);
        const insert = db.prepare(
            "INSERT INTO chunks (groupName, docName, indexNo, allLength, text, embedding) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            insert.run(groupName, c.docName, c.indexNo, c.allLength, c.text, _embeddingToBlob(c.embedding));
        }
    };

    /**
     * グループの全チャンクを返す (検索・バックアップ用).
     * @param  {string} groupName
     * @param  {string} [dirPath]
     * @return {Array<{docName,indexNo,allLength,text,embedding:Float32Array}>}
     */
    const getChunks = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        const rows = db
            .prepare(
                "SELECT docName, indexNo, allLength, text, embedding FROM chunks " +
                    "WHERE groupName = ? ORDER BY docName, indexNo",
            )
            .all(groupName);
        return rows.map(function (r) {
            return {
                docName: r.docName,
                indexNo: r.indexNo,
                allLength: r.allLength,
                text: r.text,
                embedding: _blobToEmbedding(r.embedding),
            };
        });
    };

    /**
     * 指定文書のチャンクを置き換える (既存分は削除してから挿入).
     * putTextFileToVectorGroup()から呼ぶ. 他の文書のデータには一切触れない.
     * @param {string} groupName
     * @param {string} docName
     * @param {Array<{docName,indexNo,allLength,text,embedding}>} chunks
     * @param {string} [dirPath]
     */
    const replaceDocumentChunks = function (groupName, docName, chunks, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM chunks WHERE groupName = ? AND docName = ?").run(groupName, docName);
        const insert = db.prepare(
            "INSERT INTO chunks (groupName, docName, indexNo, allLength, text, embedding) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            insert.run(groupName, docName, c.indexNo, c.allLength, c.text, _embeddingToBlob(c.embedding));
        }
    };

    /** 指定文書のチャンクを削除する. removeTextFileFromVectorGroup()から呼ぶ. */
    const deleteDocumentChunks = function (groupName, docName, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM chunks WHERE groupName = ? AND docName = ?").run(groupName, docName);
    };

    // ═══════════════════════════════════════════════════════════════
    // summaries (サマリー本体. 従来の.vssファイルの実データ)
    // ═══════════════════════════════════════════════════════════════

    /**
     * バックアップ復元(importGroupFiles)で解析したサマリーエントリを一括インポートする.
     * @param {string} groupName
     * @param {Array<{docName,text,url,time}>} entries
     * @param {string} [dirPath]
     */
    const importSummaryEntries = function (groupName, entries, dirPath) {
        const db = _getDb(dirPath);
        const insert = db.prepare(
            "INSERT INTO summaries (groupName, docName, text, url, time) VALUES (?, ?, ?, ?, ?)",
        );
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            insert.run(groupName, e.docName, e.text, e.url, Number(e.time));
        }
    };

    /**
     * グループの全サマリーエントリを返す.
     * @param  {string} groupName
     * @param  {string} [dirPath]
     * @return {Array<{docName,text,url,time}>}
     */
    const getSummaryEntries = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        return db
            .prepare("SELECT docName, text, url, time FROM summaries WHERE groupName = ?")
            .all(groupName);
    };

    /** グループの文書数 (サマリー登録件数) を返す. */
    const getSummaryCount = function (groupName, dirPath) {
        const db = _getDb(dirPath);
        const row = db.prepare("SELECT COUNT(*) as c FROM summaries WHERE groupName = ?").get(groupName);
        return row ? row.c : 0;
    };

    /**
     * 指定文書のサマリーエントリをUPSERTする.
     * @param {string} groupName
     * @param {string} docName
     * @param {string} text
     * @param {string} url
     * @param {number|bigint} time
     * @param {string} [dirPath]
     */
    const putSummaryEntry = function (groupName, docName, text, url, time, dirPath) {
        const db = _getDb(dirPath);
        db.prepare(
            "INSERT INTO summaries (groupName, docName, text, url, time) VALUES (?, ?, ?, ?, ?) " +
                "ON CONFLICT(groupName, docName) DO UPDATE SET " +
                "text = excluded.text, url = excluded.url, time = excluded.time",
        ).run(groupName, docName, text, url, Number(time));
    };

    /** 指定文書のサマリーエントリを削除する. */
    const deleteSummaryEntry = function (groupName, docName, dirPath) {
        const db = _getDb(dirPath);
        db.prepare("DELETE FROM summaries WHERE groupName = ? AND docName = ?").run(groupName, docName);
    };

    // ═══════════════════════════════════════════════════════════════
    // search_log (検索ログ. conf.searchLogEnabled=true の場合のみ呼ばれる想定)
    // ═══════════════════════════════════════════════════════════════

    /**
     * 検索ログを1件記録する.
     * @param {string} groupName
     * @param {string} message      質問文.
     * @param {string[]} [tags]
     * @param {string[]} [categories]
     * @param {Array<{name:string,url:string}>} [list]  引用された参考文書一覧.
     * @param {string} [dirPath]
     */
    const logSearch = function (groupName, message, tags, categories, list, dirPath) {
        const db = _getDb(dirPath);
        db.prepare(
            "INSERT INTO search_log (groupName, message, tags, categories, resultList, createdAt) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
            groupName,
            message,
            Array.isArray(tags) && tags.length > 0 ? JSON.stringify(tags) : null,
            Array.isArray(categories) && categories.length > 0 ? JSON.stringify(categories) : null,
            Array.isArray(list) ? JSON.stringify(list) : null,
            Date.now(),
        );
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = {
        upsertDocumentMeta,
        deleteDocumentMeta,
        ensureDocumentsBackfilled,
        getDocumentTotals,
        getTagCounts,
        getCategoryCounts,
        getAllDocumentMeta,
        getAllowedTagsIfExists,
        setAllowedTags,
        listGroups,
        addGroup,
        groupExists,
        replaceDocumentChunkFts,
        deleteDocumentChunkFts,
        ensureChunkFtsBackfilled,
        getKeywordScoreMap,
        deleteGroup,
        logSearch,
        importChunks,
        getChunks,
        replaceDocumentChunks,
        deleteDocumentChunks,
        importSummaryEntries,
        getSummaryEntries,
        getSummaryCount,
        putSummaryEntry,
        deleteSummaryEntry,
    };
})();
