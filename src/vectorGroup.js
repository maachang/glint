/**
 * VectorGroup.js
 *
 * VectorStore の 2 種類のファイル (.vgs / .vss) に対する
 * 読み書き・管理処理をまとめたモジュール.
 *
 * 【ファイル種別】
 *   .vgs (VectorGroup file)
 *     テキストを一定サイズに分割した「チャンク」と、
 *     各チャンクの埋め込みベクトル (float32 配列) をまとめて格納するバイナリファイル.
 *     ファイル先頭は 4 バイトのシンボル "@vgs" で始まる.
 *
 *   .vss (VectorSummary file)
 *     各文書 (docName) に対応する「要約テキスト・URL・登録時刻」を格納するバイナリファイル.
 *     ファイル先頭は 4 バイトのシンボル "@vss" で始まる.
 *
 * 【クラス構成】
 *   VectorChunk  : 1 チャンク分のデータ (テキスト + 埋め込みベクトル) を保持する
 *   VectorGroup  : チャンク群 + サマリーをまとめて保持し、ベクトル検索機能を持つ
 *   VGFileInfo   : ファイル変更検出用のメタ情報 (グループ名・パス・更新時刻)
 *
 * 【公開関数一覧】
 *   loadVectorGroup                     パス+グループ名から VectorGroup をロード
 *   putTextFileToVectorGroup            VectorGroup へテキストを追加・更新 (async)
 *   removeTextFileFromVectorGroup       VectorGroup からテキストを削除
 *   searchEmbedding                     対象VectorGroupに対するベクトル座標検索.
 *   searchInference                     searchEmbedding 結果を用いて、RAG検索.
 *   searchVg                            searchEmbedding と searchInference を合わせた処理.
 *   updateVectorGroupFileNames          ディレクトリ内の変更グループを検出
 *
 * 【依存モジュール】
 *   binaryUtil.js    バイナリ読み書き
 *   vectorSummary.js サマリー管理
 *   llamaCpp.js      llama.cpp サーバーへの埋め込み・推論 API アクセス
 *   conv.js          テキスト前処理 (マークダウン除去・不要文字除去など)
 *   config.js        プロンプトフォーマットなどの設定管理
 *   util.js          ユーティリティ系
 *   sync.js          プロセス間ロック.
 *
 * 【使い方】
 *   const { loadVectorGroup, putTextFileToVectorGroup } = require('./VectorFile');
 *
 *   // テキストを VectorGroup に登録 (非同期)
 *   await putTextFileToVectorGroup(
 *     `groupName`, 'docs', 'https://example.com/docs', docText
 *   );
 */

(function () {
    "use strict";

    const fs = require("fs");
    const { EncodeBinary, DecodeBinary } = require("./binaryUtil");
    const { VSummaryValue, VectorSummary } = require("./vectorSummary");
    const LlamaCpp = require("./llamaCpp");
    const Conv = require("./conv");
    const Config = require("./config");
    const Prompt = require("./prompt");
    const util = require("./util");
    const sync = require("./sync");

    // ═══════════════════════════════════════════════════════════════
    // 定数
    // ═══════════════════════════════════════════════════════════════

    /** .vgs ファイルの先頭に書き込むシンボル文字列 (4 バイト固定) */
    const VECTOR_GROUP_FILE_SYMBOL = "@vgs";

    /** VectorGroup ファイルの拡張子 */
    const VECTOR_GROUP_FILE_EXTENSION = ".vgs";

    /** .vss ファイルの先頭に書き込むシンボル文字列 (4 バイト固定) */
    const VECTOR_SUMMARY_FILE_SYMBOL = "@vss";

    /** VectorSummary ファイルの拡張子 */
    const VECTOR_SUMMARY_FILE_EXTENSION = ".vss";

    /** シンボル文字列のバイト数 (= 文字数, ASCII 前提) */
    const SYMBOL_SIZE = 4;

    /** 拡張子 (.vgs / .vss) のバイト数 (= 文字数) */
    const FILE_EXTENSION_SIZE = 4;

    // ═══════════════════════════════════════════════════════════════
    // VectorChunk
    //   テキストを分割した「1 チャンク」のデータを保持するクラス.
    //   1 つの .vgs ファイルには複数の VectorChunk が格納される.
    // ═══════════════════════════════════════════════════════════════
    class VectorChunk {
        /**
         * コンストラクタ.
         *
         * 引数なしで呼んだ場合は空のインスタンスを生成する.
         * (searchEmbedding 内でキャッシュオブジェクトとして再利用するため)
         *
         * @param {string}                [text]       チャンクのテキスト本文
         * @param {number}                [indexNo]    同一文書内でのチャンク番号 (0 始まり)
         * @param {number}                [allLength]  同一文書の総チャンク数
         * @param {string}                [docName]    文書名 (拡張子なし)
         * @param {Float32Array|number[]} [embedding]  埋め込みベクトル
         */
        constructor(text, indexNo, allLength, docName, embedding) {
            this.text = text !== undefined ? text : "";
            this.indexNo = indexNo !== undefined ? indexNo : 0;
            this.allLength = allLength !== undefined ? allLength : 0;
            this.docName = docName !== undefined ? docName : "";
            this.embedding =
                embedding instanceof Float32Array
                    ? embedding
                    : embedding
                      ? new Float32Array(embedding)
                      : new Float32Array(0);
            this.summary = null;
            /**
             * 検索スコア (コサイン類似度).
             * searchEmbedding() 実行時に計算・セットされる.
             * 未検索状態では -1.
             */
            this.score = -1;
        }

        /**
         * このチャンクの内容を別の VectorChunk にコピーする.
         *
         * searchEmbedding() でキャッシュオブジェクトへ内容を転写する際に使用する.
         * out が null/undefined の場合は新規インスタンスを生成して返す.
         *
         * @param  {VectorChunk|null} [out]  コピー先オブジェクト (省略時は新規生成)
         * @return {VectorChunk}
         */
        copy(out) {
            if (!out) out = new VectorChunk();
            out.text = this.text;
            out.embedding = this.embedding;
            out.docName = this.docName;
            out.indexNo = this.indexNo;
            out.allLength = this.allLength;
            out.score = this.score;
            out.summary = this.summary;
            return out;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // VectorGroup
    //   1 つの .vgs ファイルに対応するオブジェクト.
    //   VectorChunk の配列と、対応する VectorSummary を保持する.
    //   コサイン類似度によるベクトル検索機能も提供する.
    // ═══════════════════════════════════════════════════════════════
    class VectorGroup {
        /**
         * コンストラクタ.
         *
         * @param {string}        groupName  グループ名 (拡張子なし, 例: 'docs')
         * @param {string}        dirPath    ファイルが格納されているディレクトリパス
         * @param {string}        fileName   .vgs ファイル名 (例: 'docs.vgs')
         * @param {number}        fileTime   .vgs ファイルの最終更新時刻 (ミリ秒, mtimeMs)
         * @param {VectorChunk[]} chunks     ロード済みの VectorChunk 配列
         * @param {VectorSummary} summary    対応する VectorSummary オブジェクト
         * @param {VectorChunk[]} [cache]    VectorChunk オブジェクトの再利用プール (省略時は空配列).
         *                                   searchEmbedding() が内部で使い回すバッファとして機能する.
         */
        constructor(
            groupName,
            dirPath,
            fileName,
            fileTime,
            chunks,
            summary,
            cache,
        ) {
            this.groupName = groupName;
            this.dirPath = dirPath;
            this.fileName = fileName;
            this.fileTime = fileTime;
            this._chunks = chunks;
            this._summary = summary;
            // cache が渡されない場合は空配列で初期化する.
            // searchEmbedding() の呼び出しごとに使い終わったオブジェクトを
            // ここに戻し、次回呼び出しで再利用することで GC 負荷を軽減する.
            this._cache = Array.isArray(cache) ? cache : [];
        }

        /**
         * キャッシュプールから VectorChunk を取り出す内部メソッド.
         *
         * プールに空きオブジェクトがあればそれを返し、なければ新規生成する.
         *
         * @return {VectorChunk}
         */
        _getCache() {
            return this._cache.length > 0
                ? this._cache.pop()
                : new VectorChunk();
        }

        /**
         * グループ名を返す.
         *
         * @return {string}
         */
        getGroup() {
            return this.groupName;
        }

        /**
         * .vgs ファイル名を返す (拡張子込み, 例: 'docs.vgs').
         *
         * @return {string}
         */
        getFileName() {
            return this.fileName;
        }

        /**
         * .vgs ファイルの最終更新時刻 (ミリ秒) を返す.
         *
         * ロード時点のスナップショット値であり、isUpdateFile() との比較に使う.
         *
         * @return {number}
         */
        getFileTime() {
            return this.fileTime;
        }

        /**
         * 保持している VectorChunk の配列を返す.
         *
         * @return {VectorChunk[]}
         */
        getChunked() {
            return this._chunks;
        }

        /**
         * 対応する VectorSummary を返す.
         *
         * @return {VectorSummary}
         */
        getSummary() {
            return this._summary;
        }

        /**
         * このグループに登録されている文書名 (docName) の一覧を返す.
         *
         * 実体は VectorSummary.getDocuments() の委譲.
         * 文書単位の管理 (追加・削除対象の確認) に使用する.
         *
         * @return {string[]}
         */
        getDocuments() {
            return this._summary.getDocuments();
        }

        /**
         * ディスク上の .vgs ファイルがロード後に更新されたか確認する.
         *
         * ロード時に記録した fileTime と現在のファイル更新時刻を比較し、
         * 異なっていれば true を返す.
         * ポーリングによるホットリロード判定などに使用する.
         *
         * @return {boolean} true = ファイルが更新されている
         * @throws {Error}   ファイルが存在しないなど stat に失敗した場合
         */
        isUpdateFile() {
            const current = fs.statSync(
                this.dirPath + "/" + this.fileName,
            ).mtimeMs;
            return this.fileTime !== current;
        }

        /**
         * クエリ埋め込みベクトルに近い VectorChunk を検索し、
         * コサイン類似度の降順 (高い順 = より関連性が高い順) で out[] に書き込む.
         *
         * 【コサイン類似度のスコア計算式】
         *   score = (a・b) / (sqrt(na * nb) + 1e-10)
         *   分母に 1e-10 を加算することでゼロ除算を防いでいる.
         *
         * @param  {VectorChunk[]} out       結果を格納する配列. out.length が最大取得件数になる.
         * @param  {Float32Array}  queryEmb  クエリのベクトル (検索したいテキストの埋め込み).
         * @return {number}        out[] に実際に書き込んだ件数.
         */
        searchEmbedding(out, queryEmb) {
            const docs = this._chunks;
            const len = docs.length;
            if (len === 0) {
                return 0;
            }

            // ── スコア計算 ──
            // キャッシュから一時オブジェクトを取り出し、各チャンクのスコアを計算する.
            let i;
            const target = new Array(len);
            for (i = 0; i < len; i++) {
                let tmp = this._getCache(); // キャッシュから再利用オブジェクトを取得
                docs[i].copy(tmp);
                // コサイン類似度を計算してスコアとして保持
                tmp.score = _score(queryEmb, tmp.embedding);
                // サマリーをキャッシュのVectorChunkセット.
                tmp.summary = this._summary;
                target[i] = tmp;
            }

            // ── ソート ──
            // スコアの高い順 (降順) にソートする.
            target.sort(function (a, b) {
                return b.score - a.score;
            });

            // ── 結果を out[] に書き込む ──
            const outLen = out.length;
            let ret = 0;
            for (i = 0; i < outLen; i++) {
                if (i >= len) {
                    break;
                } // documents 側が out より少ない場合
                out[i] = target[i].copy(new VectorChunk());
                ret++;
            }

            // ── キャッシュへ返却 ──
            // 使い終わった一時オブジェクトをプールに戻して次回検索で再利用する.
            for (i = 0; i < len; i++) {
                this._cache.push(target[i]);
            }

            return ret;
        }
    }

    /**
     * 2 つの float32 配列のコサイン類似度スコアを計算する内部関数.
     *
     * 【計算式】
     *   score = (a・b) / (sqrt(na * nb) + 1e-10)
     *   分母に 1e-10 を加算することでゼロ除算 (および sqrt(0) による NaN) を防ぐ.
     *
     * @param  {Float32Array} a  ベクトル a (クエリ埋め込み)
     * @param  {Float32Array} b  ベクトル b (チャンク埋め込み)
     * @return {number}          類似度スコア (高いほど類似)
     */
    const _score = function (a, b) {
        let dot = 0.0,
            na = 0.0,
            nb = 0.0;
        let i, av, bv;
        let len = a.length;
        for (i = 0; i < len; i++) {
            av = a[i];
            bv = b[i];
            dot += av * bv; // 内積
            na += av * av; // a のノルム二乗
            nb += bv * bv; // b のノルム二乗
        }
        // ゼロ除算防止のために 1e-10 を加算.
        return dot / (Math.sqrt(na * nb) + 1.0e-10);
    };

    // ═══════════════════════════════════════════════════════════════
    // VGFileInfo
    //   ディレクトリ内の .vgs ファイルを監視するための軽量なメタ情報クラス.
    //   updateVectorGroupFileNames() が Map<groupName, VGFileInfo> を管理することで、
    //   ファイルの追加・更新・削除を検出できる.
    // ═══════════════════════════════════════════════════════════════
    class VGFileInfo {
        /**
         * @param {string} groupName  グループ名 (拡張子なし)
         * @param {string} filePath   ファイルが存在するディレクトリパス
         * @param {string} fileName   ファイル名 (例: 'docs.vgs')
         * @param {number} fileTime   ファイルの最終更新時刻 (ミリ秒, mtimeMs)
         */
        constructor(groupName, filePath, fileName, fileTime) {
            this.groupName = groupName;
            this.filePath = filePath;
            this.fileName = fileName;
            this.fileTime = fileTime;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 内部ユーティリティ関数
    //   モジュール外には公開しない (先頭が _ のものはプライベート扱い).
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private]ディレクトリパスの末尾スラッシュを除去し、
     * グループ名から既知の拡張子 (.vgs / .vss) を除去して返す.
     *
     * ユーザーが groupName に拡張子を含めて渡してきた場合でも
     * 正しく処理できるようにするための正規化処理.
     *
     * @param  {string} dirPath    ディレクトリパス (例: '/data/' → '/data')
     * @param  {string} groupName  グループ名 (例: 'docs.vgs' → 'docs')
     * @return {{ path: string, groupName: string }}
     */
    const _trimPathGroup = function (dirPath, groupName) {
        // 末尾スラッシュを除去
        if (dirPath.endsWith("/")) dirPath = dirPath.slice(0, -1);
        // グループ名から拡張子を除去
        if (
            groupName.endsWith(VECTOR_GROUP_FILE_EXTENSION) ||
            groupName.endsWith(VECTOR_SUMMARY_FILE_EXTENSION)
        ) {
            groupName = groupName.slice(0, -FILE_EXTENSION_SIZE);
        }
        return { path: dirPath, groupName: groupName };
    };

    /**
     * [private]ディレクトリパス・グループ名・拡張子を結合してフルファイルパスを返す.
     *
     * 例: ('/data', 'docs', '.vgs') → '/data/docs.vgs'
     *
     * @param  {string} dirPath    ディレクトリパス
     * @param  {string} groupName  グループ名 (拡張子なし)
     * @param  {string} extension  拡張子 (例: '.vgs')
     * @return {string}            フルファイルパス
     */
    const _buildFilePath = function (dirPath, groupName, extension) {
        const pg = _trimPathGroup(dirPath, groupName);
        return pg.path + "/" + pg.groupName + extension;
    };

    /**
     * [private]指定パスのファイルが存在するかを確認する.
     * stat に失敗した場合 (ファイルがない場合) は false を返す.
     *
     * @param  {string}  dirPath   ディレクトリパス
     * @param  {string}  fileName  ファイル名
     * @return {boolean}
     */
    const _isFile = function (dirPath, fileName) {
        try {
            return fs.statSync(dirPath + "/" + fileName).isFile();
        } catch (e) {
            return false;
        }
    };

    /**
     * [private]ファイルの最終更新時刻をミリ秒で返す.
     * ファイル変更検出 (updateVectorGroupFileNames) で使用する.
     *
     * @param  {string} filePath  フルファイルパス
     * @return {number}           mtimeMs (ミリ秒)
     */
    const _getFileTime = function (filePath) {
        return fs.statSync(filePath).mtimeMs;
    };

    /**
     * [private]指定ディレクトリ直下のファイル名一覧を返す.
     * サブディレクトリは除外する.
     *
     * @param  {string}   dirPath  ディレクトリパス
     * @return {string[]}          ファイル名の配列
     */
    const _getPathToFiles = function (dirPath) {
        return fs.readdirSync(dirPath).filter(function (name) {
            try {
                return fs.statSync(dirPath + "/" + name).isFile();
            } catch (e) {
                return false;
            }
        });
    };

    /**
     * [private]ファイルを削除する.
     * 削除に成功した場合は null、失敗した場合は Error オブジェクトを返す.
     * (throw せずに返すことで、呼び出し側が複数ファイル削除後にまとめてハンドリングできる)
     *
     * @param  {string}     dirPath   ディレクトリパス
     * @param  {string}     fileName  ファイル名
     * @return {Error|null}
     */
    const _removeFile = function (dirPath, fileName) {
        try {
            fs.unlinkSync(dirPath + "/" + fileName);
            return null;
        } catch (e) {
            return e;
        }
    };

    /**
     * [private]ファイル名から拡張子を除去して返す.
     * 拡張子がない場合はそのまま返す.
     *
     * 例: 'readme.txt' → 'readme'
     *     'readme'     → 'readme'
     *
     * @param  {string} fileName  ファイル名
     * @return {string}           拡張子なしのファイル名 (= 文書名 docName)
     */
    const _cutExtension = function (fileName) {
        const idx = fileName.lastIndexOf(".");
        return idx > 0 ? fileName.slice(0, idx) : fileName;
    };

    /**
     * [private]複数の Uint8Array / Buffer を1つの Buffer に結合する.
     *
     * シリアライズ時に各フィールドのバイト列をパーツとして parts[] に積んでおき、
     * 最後にこの関数で一括結合する運用にしている.
     * これにより、途中で Buffer サイズを事前計算する必要がなくなる.
     *
     * @param  {...Uint8Array|Buffer} (可変長引数)
     * @return {Buffer}  結合後のバイト列
     */
    const _concatBytes = function (args) {
        // 全パーツの合計バイト数を計算
        const total = args.reduce(function (s, a) {
            return s + a.length;
        }, 0);
        const out = Buffer.alloc(total);
        let offset = 0;
        // 各パーツを out の対応オフセットにコピー
        for (let i = 0; i < args.length; i++) {
            Buffer.from(args[i]).copy(out, offset);
            offset += args[i].length;
        }
        return out;
    };

    /**
     * [private]ディレクトリを作成(mkdir -p {name})します.
     * @param {string} dir  作成対象のディレクトリを設定します.
     * @return {boolean} true の場合、ディレクトリ生成に成功しました.
     */
    const _mkdirs = function (dir) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            return true;
        } catch (e) {
            return false;
        }
    };

    /**
     * [private]vectorStore用ディレクトリパスを取得.
     * @param {string} dirPath 対象のディレクトリパスを設定します.
     *                         null or undefined の場合はconfig定義の
     *                         VectorStoreディレクトリが生成されます.
     * @returns {string} ディレクトリパスが返却されます.
     */
    const _getVectorStoreDir = function (dirPath) {
        // コンフィグから設定する.
        const conf = Config.getInstance();
        // dirPathが指定されていない場合
        // conf.dirPath + conf.vectorStorePathが対象.
        dirPath = dirPath || util.joinPath(conf.dirPath, conf.vectorStorePath);
        if (dirPath.endsWith("/")) dirPath = dirPath.slice(0, -1);
        return dirPath;
    };

    /**
     * [private]vectorStore用ディレクトリを設定して、ディレクトリが存在しない場合は生成する.
     * @param {string} dirPath 対象のディレクトリパスを設定します.
     *                         null or undefined の場合はconfig定義の
     *                         VectorStoreディレクトリが生成されます.
     * @returns {string} ディレクトリパスが返却されます.
     */
    const _mkdirsToVectorStore = function (dirPath) {
        // コンフィグから設定する.
        const conf = Config.getInstance();
        // dirPathが指定されていない場合
        // conf.dirPath + conf.vectorStorePathが対象.
        dirPath = dirPath || util.joinPath(conf.dirPath, conf.vectorStorePath);
        if (dirPath.endsWith("/")) dirPath = dirPath.slice(0, -1);
        // ディレクトリ作成をトライ.
        _mkdirs(dirPath);
        // 対象ディレクトリ名を返却.
        return dirPath;
    };

    // ═══════════════════════════════════════════════════════════════
    // VectorGroup (.vgs) ファイル I/O
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private].vgs ファイルを読み込み、VectorChunk の配列を返す.
     *
     * ファイルを丸ごと readFileSync で読み込み、_loadGroupFromBinary() に渡す.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string}        groupName  グループ名
     * @param  {string}        dirPath    [*]ディレクトリパス
     * @return {VectorChunk[]} vectorGroupの中核VectorChunked群が返却されます.
     */
    const _loadGroup = function (groupName, dirPath) {
        // vectrStore用ディレクトリパスを取得.
        dirPath = _getVectorStoreDir(dirPath);
        const fileName = _buildFilePath(
            dirPath,
            groupName,
            VECTOR_GROUP_FILE_EXTENSION,
        );
        return _loadGroupFromBinary(fs.readFileSync(fileName));
    };

    /**
     * [private]バイナリ (Buffer) から VectorChunk の配列をデシリアライズする.
     *
     * 【バイナリフォーマット (.vgs)】
     *   [4 bytes] シンボル "@vgs" (UTF-8)
     *   [3 bytes] チャンク総数 (uint24)
     *   以下をチャンク数分繰り返す:
     *     [3 bytes] インデックス番号 (uint24)
     *     [2 bytes] 文書名のバイト長 (uint16)
     *     [N bytes] 文書名 (UTF-8)
     *     [3 bytes] テキストのバイト長 (uint24)
     *     [N bytes] テキスト (UTF-8)
     *     [3 bytes] 埋め込みベクトルの要素数 (uint24)
     *     [N×4 bytes] 埋め込みベクトル (float32 × N)
     *
     * @param  {Buffer}        binary  .vgs ファイルの生バイナリ
     * @return {VectorChunk[]} vectorGroupの中核VectorChunked群が返却されます.
     * @throws {Error}         シンボルが一致しない場合
     */
    const _loadGroupFromBinary = function (binary) {
        const bd = new DecodeBinary(binary);

        // ── シンボル確認 ──
        // ファイル先頭 4 バイトがシンボル文字列と一致するか確認する.
        // 不一致の場合は誤ったファイルを読み込んでいる可能性があるためエラーにする.
        if (bd.getString(SYMBOL_SIZE) !== VECTOR_GROUP_FILE_SYMBOL) {
            throw new Error("Not a VectorGroup file symbol");
        }

        // チャンク総数を読む (3 バイト符号なし整数)
        const allLen = bd.getUInt3();
        const ret = new Array(allLen);

        let indexNo, docName, text, embLen, embList, j;
        for (let i = 0; i < allLen; i++) {
            // インデックス番号 (同一文書内での順番)
            indexNo = bd.getUInt3();
            // 文書名 (先頭 2 バイトが文字列のバイト長)
            docName = bd.getString(bd.getUInt2());
            // チャンクテキスト (先頭 3 バイトが文字列のバイト長)
            text = bd.getString(bd.getUInt3());
            // 埋め込みベクトル (先頭 3 バイトが要素数、以降 float32 × 要素数)
            embLen = bd.getUInt3();
            embList = new Float32Array(embLen);
            for (j = 0; j < embLen; j++) {
                embList[j] = bd.getFloat();
            }
            // VectorChunk を生成して配列に格納
            ret[i] = new VectorChunk(text, indexNo, allLen, docName, embList);
        }
        return ret;
    };

    /**
     * [private]VectorChunk の配列を .vgs ファイルに保存する.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param {string}        groupName  グループ名
     * @param {VectorChunk[]} chunks     保存するチャンク配列
     * @param {string}        dirPath    [*]ディレクトリパス
     */
    const _saveGroup = function (groupName, chunks, dirPath) {
        // ディレクトリ作成を行い、正しいディレクトリパスを返却.
        dirPath = _mkdirsToVectorStore(dirPath);
        const fileName = _buildFilePath(
            dirPath,
            groupName,
            VECTOR_GROUP_FILE_EXTENSION,
        );
        fs.writeFileSync(fileName, _saveGroupToBinary(chunks));
        console.debug("_saveGroup-fileName: " + fileName);
    };

    /**
     * [private]VectorChunk の配列をバイナリ (Buffer) にシリアライズする.
     *
     * フォーマットは loadGroupFromBinary() の説明を参照.
     * 各フィールドを parts[] に積んでから _concatBytes() で一括結合する.
     *
     * @param  {VectorChunk[]} chunks  シリアライズするチャンク配列
     * @return {Buffer} バイナリ情報が返却されます.
     */
    const _saveGroupToBinary = function (chunks) {
        const allLen = chunks.length;
        const parts = [];

        // シンボル + チャンク総数
        parts.push(EncodeBinary.getString(VECTOR_GROUP_FILE_SYMBOL));
        parts.push(EncodeBinary.getInt3(allLen));

        for (let i = 0; i < allLen; i++) {
            const ck = chunks[i];
            const docBin = EncodeBinary.getString(ck.docName);
            const textBin = EncodeBinary.getString(ck.text);

            // インデックス番号 (3 バイト)
            parts.push(EncodeBinary.getInt3(ck.indexNo));
            // 文書名: バイト長 (2 バイト) + 本体
            parts.push(EncodeBinary.getInt2(docBin.length));
            parts.push(docBin);
            // テキスト: バイト長 (3 バイト) + 本体
            parts.push(EncodeBinary.getInt3(textBin.length));
            parts.push(textBin);
            // 埋め込みベクトル: 要素数 (3 バイト) + float32 × 要素数
            parts.push(EncodeBinary.getInt3(ck.embedding.length));
            for (let j = 0; j < ck.embedding.length; j++) {
                parts.push(EncodeBinary.getFloat(ck.embedding[j]));
            }
        }
        return _concatBytes(parts);
    };

    // ═══════════════════════════════════════════════════════════════
    // VectorSummary (.vss) ファイル I/O
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private].vss ファイルを読み込み、VectorSummary を返す.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string}        groupName  グループ名
     * @param  {string}        dirPath    [*]ディレクトリパス
     * @return {VectorSummary} サマリーオブジェクトが返却されます.
     */
    const _loadSummary = function (groupName, dirPath) {
        // vectrStore用ディレクトリパスを取得.
        dirPath = _getVectorStoreDir(dirPath);
        const fileName = _buildFilePath(
            dirPath,
            groupName,
            VECTOR_SUMMARY_FILE_EXTENSION,
        );
        return _loadSummaryFromBinary(fs.readFileSync(fileName));
    };

    /**
     * [private]バイナリ (Buffer) から VectorSummary をデシリアライズする.
     *
     * 【バイナリフォーマット (.vss)】
     *   [4 bytes] シンボル "@vss" (UTF-8)
     *   [3 bytes] エントリ総数 (uint24)
     *   以下をエントリ数分繰り返す:
     *     [2 bytes] 文書名のバイト長 (uint16)
     *     [N bytes] 文書名 (UTF-8)
     *     [3 bytes] 要約テキストのバイト長 (uint24)
     *     [N bytes] 要約テキスト (UTF-8)
     *     [3 bytes] URL のバイト長 (uint24)
     *     [N bytes] URL (UTF-8)
     *     [8 bytes] 登録時刻 (int64, Unix タイムスタンプ ms)
     *
     * @param  {Buffer}        binary  .vss ファイルの生バイナリ
     * @return {VectorSummary} サマリーオブジェクトが返却されます.
     * @throws {Error}         シンボルが一致しない場合
     */
    const _loadSummaryFromBinary = function (binary) {
        const bd = new DecodeBinary(binary);

        // シンボル確認
        if (bd.getString(SYMBOL_SIZE) !== VECTOR_SUMMARY_FILE_SYMBOL) {
            throw new Error("Not a VectorSummary file symbol");
        }

        const ret = new VectorSummary();
        const allLen = bd.getUInt3();

        for (let i = 0; i < allLen; i++) {
            // 文書名 (先頭 2 バイトがバイト長)
            const docName = bd.getString(bd.getUInt2());
            // 要約テキスト (先頭 3 バイトがバイト長)
            const text = bd.getString(bd.getUInt3());
            // URL (先頭 3 バイトがバイト長)
            const url = bd.getString(bd.getUInt3());
            // 登録時刻 (8 バイト, bigint で返る)
            const time = bd.getLong();
            ret.put(docName, new VSummaryValue(text, url, time));
        }
        return ret;
    };

    /**
     * [private]VectorSummary を .vss ファイルに保存する.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param {string}        groupName  グループ名
     * @param {VectorSummary} summary    保存するサマリーオブジェクト
     * @param {string}        dirPath    [*]ディレクトリパス
     */
    const _saveSummary = function (groupName, summary, dirPath) {
        // ディレクトリ作成を行い、正しいディレクトリパスを返却.
        dirPath = _mkdirsToVectorStore(dirPath);
        const fileName = _buildFilePath(
            dirPath,
            groupName,
            VECTOR_SUMMARY_FILE_EXTENSION,
        );
        fs.writeFileSync(fileName, _saveSummaryToBinary(summary));
        console.debug("_saveSummary-fileName: " + fileName);
    };

    /**
     * [private]VectorSummary をバイナリ (Buffer) にシリアライズする.
     *
     * フォーマットは _loadSummaryFromBinary() の説明を参照.
     *
     * @param  {VectorSummary} summary  シリアライズするサマリーオブジェクト
     * @return {Buffer}
     */
    const _saveSummaryToBinary = function (summary) {
        const names = summary.getDocuments();
        const parts = [];

        // シンボル + エントリ総数
        parts.push(EncodeBinary.getString(VECTOR_SUMMARY_FILE_SYMBOL));
        parts.push(EncodeBinary.getInt3(names.length));

        for (let i = 0; i < names.length; i++) {
            const docName = names[i];
            const vv = summary.get(docName);
            const docBin = EncodeBinary.getString(docName);
            const textBin = EncodeBinary.getString(vv.text);
            const urlBin = EncodeBinary.getString(vv.url);

            // 文書名: バイト長 (2 バイト) + 本体
            parts.push(EncodeBinary.getInt2(docBin.length));
            parts.push(docBin);
            // 要約テキスト: バイト長 (3 バイト) + 本体
            parts.push(EncodeBinary.getInt3(textBin.length));
            parts.push(textBin);
            // URL: バイト長 (3 バイト) + 本体
            parts.push(EncodeBinary.getInt3(urlBin.length));
            parts.push(urlBin);
            // 登録時刻 (8 バイト int64)
            parts.push(EncodeBinary.getLong(vv.time));
        }

        return _concatBytes(parts);
    };

    // ═══════════════════════════════════════════════════════════════
    // ロードヘルパー
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private]パスとグループ名を正規化して VectorSummary をロードする.
     *
     * 内部では _trimPathGroup() で正規化してから _loadSummary() を呼ぶだけだが、
     * 外部から利用しやすいようにラップしている.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string}        groupName  グループ名 (拡張子があっても可)
     * @param  {string}        dirPath    [*]ディレクトリパス
     * @return {VectorSummary}
     */
    const _loadVectorSummary = function (groupName, dirPath) {
        // vectrStore用ディレクトリパスを取得.
        dirPath = _getVectorStoreDir(dirPath);
        const pg = _trimPathGroup(dirPath, groupName);
        return _loadSummary(pg.groupName, pg.path);
    };

    /**
     * [private].vgs / .vss ファイルを両方ロードして VectorGroup オブジェクトを返す (ロック無し).
     *
     * 呼び出し元が既に sync.lock(groupName) を保持している場合はこちらを直接呼ぶこと.
     * (putTextFileToVectorGroup() / removeTextFileFromVectorGroup() が該当.
     *  自身でロックを保持したまま公開版の loadVectorGroup() を呼ぶと再入になり、
     *  sync.js 側で「同一グループ名への別の同時実行」と区別できなくなるため.)
     *
     * @param  {string}      groupName  正規化済みのグループ名 (拡張子なし)
     * @param  {string}      dirPath    正規化済みのディレクトリパス
     * @return {VectorGroup}
     */
    const _loadVectorGroupUnlocked = function (groupName, dirPath) {
        const vgFileName = groupName + VECTOR_GROUP_FILE_EXTENSION;
        // .vgs ファイルの更新時刻を取得 (変更検出のために保持する)
        const fileTime = _getFileTime(dirPath + "/" + vgFileName);
        const chunks = _loadGroup(groupName, dirPath);
        const summary = _loadVectorSummary(groupName, dirPath);
        // cache は省略 → VectorGroup コンストラクタ内で空配列として初期化される
        return new VectorGroup(
            groupName,
            dirPath,
            vgFileName,
            fileTime,
            chunks,
            summary,
        );
    };

    /**
     * .vgs / .vss ファイルを両方ロードして VectorGroup オブジェクトを返す.
     *
     * .vgs のファイル更新時刻も取得して VectorGroup に持たせることで、
     * updateVectorGroupFileNames() などでの変更検出に利用できる.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string}      groupName  グループ名 (拡張子があっても可)
     * @param  {string}      dirPath    [*]ディレクトリパス
     * @return {VectorGroup}
     */
    const loadVectorGroup = async function (groupName, dirPath) {
        // vectrStore用ディレクトリパスを取得.
        dirPath = _getVectorStoreDir(dirPath);
        const pg = _trimPathGroup(dirPath, groupName);
        groupName = pg.groupName;

        // VectorGroupファイル読み込み開始.
        const lockUk = await sync.lock(groupName);
        try {
            return _loadVectorGroupUnlocked(pg.groupName, pg.path);
        } finally {
            // VectorGroupファイル読み込み終了.
            sync.unlock(groupName, lockUk);
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // テキストチャンク分割
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private]長いテキストを chunkSize 文字以内の断片 (チャンク) に分割する.
     *
     * 【分割アルゴリズム】
     *   1. テキストを文末記号 (。!?！？ や改行) で文単位に分割する.
     *   2. 文を buf に追加していき、buf が chunkSize を超えたタイミングでチャンクを確定する.
     *   3. チャンク確定後、末尾 overlapSize 文字分を次のチャンクの先頭に引き継ぐ.
     *      (= オーバーラップ) これにより文脈の断絶を防ぐ.
     *
     * 【オーバーラップについて】
     *   チャンク境界での文脈の断絶を防ぐために、前のチャンクの末尾 N 文字を
     *   次のチャンクの先頭に重複させる手法. RAG では重要.
     *   例: chunkSize=100, overlapSize=20 の場合、
     *       チャンク1: 0〜100文字
     *       チャンク2: 80〜180文字 (80〜100が前チャンクと重複)
     *
     * @param  {string}   text        分割対象のテキスト
     * @param  {number}   chunkSize   1 チャンクの最大文字数
     * @param  {number}   overlapSize 次チャンクへ引き継ぐ末尾文字数
     * @return {string[]}             分割後のチャンク配列
     */
    const _stringToChunks = function (text, chunkSize, overlapSize) {
        // 文末記号の後ろで分割 (後読みの正規表現)
        const sentences = text.split(/(?<=[。!?！？\n])/);
        const result = [];
        let buf = ""; // 現在積み上げ中のバッファ

        for (let i = 0; i < sentences.length; i++) {
            const s = sentences[i];
            const bufLen = buf.length;

            if (bufLen > chunkSize) {
                // buf がすでに chunkSize を超えている場合:
                // chunkSize 分を切り出してチャンクとして確定し、
                // オーバーラップ分だけ次の buf に引き継ぐ
                result.push(buf.slice(0, chunkSize).trim());
                buf = buf.slice(chunkSize - overlapSize);
            } else if (bufLen + s.length > chunkSize && bufLen > 0) {
                // 今回の文を追加すると chunkSize を超える場合:
                // 現在の buf をチャンクとして確定する
                result.push(buf.trim());
                // オーバーラップ: bufLen が overlapSize より大きければ末尾 overlapSize 文字を引き継ぐ.
                // 小さければ buf 全体を引き継ぐ (文脈を可能な限り保持するため)
                buf =
                    (bufLen > overlapSize
                        ? buf.slice(bufLen - overlapSize)
                        : buf) + s;
            } else {
                // buf に余裕がある場合はそのまま文を追加
                buf += s;
            }
        }

        // ループ終了後に buf に残りがある場合は、chunkSize 以内になるまで繰り返し切り出す
        buf = buf.trim();
        while (buf.length > 0) {
            if (buf.length <= chunkSize) {
                result.push(buf.trim());
                break;
            }
            result.push(buf.slice(0, chunkSize).trim());
            buf = buf.slice(chunkSize - overlapSize);
        }

        return result;
    };

    // ═══════════════════════════════════════════════════════════════
    // VectorGroup へのテキスト追加・削除
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private]サマリー返却のJSON変換.
     * @param {string} sumTxt サマリー返却の文字列を設定します.
     * @returns {tag, category, summary} JSON解析結果が返却されます.
     */
    const _resultSummayToJson = function (sumTxt) {
        sumTxt = sumTxt.trim();

        let ep;
        // jsonのマークダウンで囲われている部分を取得.
        if (sumTxt.startsWith("~~~json")) {
            ep = sumTxt.indexOf("~~~", 7);
            if (ep == -1) {
                return null;
            }
        } else if (sumTxt.startsWith("```json")) {
            ep = sumTxt.indexOf("```", 7);
            if (ep == -1) {
                return null;
            }
        } else {
            return null;
        }
        try {
            // json文字列を取得 (tag, category, summary を含む).
            let jsonTxt = sumTxt.substring(7, ep).trim();

            // jsonパース.
            const jsonValue = Conv.parseJson(jsonTxt);
            // サマリー内容の整形.
            if (typeof jsonValue["summary"] === "string") {
                let summary = jsonValue["summary"];
                summary = Conv.stripMarkdown(summary); // マークダウン除去
                summary = Conv.exclusionText(summary); // 全角スペース・\r・\t 除去
                summary = Conv.trimEnterText(summary); // 余分な空行除去
                jsonValue["summary"] = summary;
            }
            return jsonValue;
        } catch (e) {
            console.warn("#jsonパースに失敗: " + sumTxt);
        }
        return null;
    };

    // [private]グループ名からvectorGroup,vectorSummary のファイル名を作成.
    const _getGroupNameToFileName = function (groupName) {
        return {
            vgFileName: groupName + VECTOR_GROUP_FILE_EXTENSION,
            vsFileName: groupName + VECTOR_SUMMARY_FILE_EXTENSION,
        };
    };

    /**
     * 指定グループにテキストファイルの内容を追加・更新する.
     *
     * 【処理の流れ】
     *   1. グループファイルが既に存在する場合はロードし、同名文書のチャンクを除外する.
     *   2. 生テキストをそのまま LlamaCpp.getInferenceMessage() に渡して要約を生成する.
     *      (前処理前の自然な文章を渡すことで要約精度を上げる)
     *   3. 要約テキストだけ Conv で前処理して VectorSummary に登録する.
     *   4. 本文テキストも Conv で前処理する.
     *   5. 要約テキストを本文先頭に付加する.
     *   6. _stringToChunks() でチャンクに分割し LlamaCpp.getEmbedding() でベクトル化する.
     *   7. 全チャンクを .vgs に、サマリーを .vss に保存する.
     *
     * @param {string} groupName      グループ名
     * @param {string} textFileName   追加するファイル名 (拡張子込み, 例: 'readme.txt')
     * @param {string} textUrl        元テキストの参照先 URL
     * @param {string} text           テキスト本文
     * @param {object} options        オプションパラメータを設定します.
     *   - {string} embBaseUrl        埋め込みモデルサーバーの URL (例: 'http://localhost:8080')
     *   - {string} ifBaseUrl         推論モデルサーバーの URL (例: 'http://localhost:8081')
     *   - {string} dirPath           ディレクトリパス
     *   - {number} chunkSize         1チャンクの最大文字数
     *   - {number} overlap           オーバーラップ文字数
     *   - {number} temperature       サマリー推論の正確性を示す値を設定.
     *   - {boolean} summaryReasoning サマリー推論モードの ON OFF を設定します.
     * @return {Promise<void>}
     * @throws {Error} .vss が存在しない場合、または llama.cpp サーバーエラーの場合
     */
    const putTextFileToVectorGroup = async function (
        groupName,
        textFileName,
        textUrl,
        text,
        options,
    ) {
        // options が設定せれていない場合.
        options = options || {};
        // コンフィグから設定する.
        const conf = Config.getInstance();
        // オプションパラメータを取得.
        let embBaseUrl = options.embBaseUrl || null;
        let ifBaseUrl = options.ifBaseUrl || null;
        let dirPath = options.dirPath || null;
        let chunkSize = options.chunkSize || conf.chunkSize;
        let overlap = options.overlap || conf.overlapSize;
        let temperature = options.temperature || conf.summaryTemperature;
        let summaryReasoning =
            options.summaryReasoning == true ||
            options.summaryReasoning == false
                ? options.summaryReasoning
                : conf.summaryReasoning;

        // ディレクトリ作成を行い、正しいディレクトリパスを返却.
        dirPath = _mkdirsToVectorStore(dirPath);

        // embBaseUrl が存在しない場合、config定義されている内容から割り当てる.
        let embObj = null;
        if (embBaseUrl === undefined || embBaseUrl === null) {
            embObj = conf.getEmbeddingURL();
            embBaseUrl = embObj.baseUrl;
        }
        // ifBaseUrl が存在しない場合、config定義されている内容から割り当てる.
        let ifObj = null;
        if (ifBaseUrl === undefined || ifBaseUrl === null) {
            ifObj = conf.getInferenceURL();
            ifBaseUrl = ifObj.baseUrl;
        }
        try {
            // 拡張子を除いた文書名 (例: 'readme.txt' → 'readme')
            const textDocName = _cutExtension(textFileName);

            // パス・グループ名を正規化
            const pg = _trimPathGroup(dirPath, groupName);
            dirPath = pg.path;
            groupName = pg.groupName;

            // ── 要約テキスト生成 (前処理前の生テキストで推論) ──
            // ここでは主に以下の内容を生成する
            // - tag: 対象文書のジャンル的内容
            // - category: 対象文書のカテゴリ的内容
            // - summary: 対象文書のサマリー的内容
            // これらを踏まえて、RAG検索に対して影響力強化を与える.

            let tm = Date.now();
            // debug.
            console.debug("start.getInferenceMessage(" + textFileName + ")");
            const sumPrompt = Prompt.getSummaryRequest(textDocName, text);
            let sumTxt = await LlamaCpp.getInferenceMessage(
                ifBaseUrl,
                sumPrompt.system,
                sumPrompt.user,
                temperature,
                null,
                summaryReasoning,
                ifObj && ifObj.model,
                ifObj && ifObj.apiKey,
            );
            // debug.
            console.debug(
                "end.getInferenceMessage: " + (Date.now() - tm) + " msec",
            );

            // 結果文字列の整形.
            sumTxt = sumTxt.trim();

            // AI回答の文字列に</think>が設定されている場合.
            // この文字以降のものだけを採用する.
            // ※このタグは推論中のゴミのようなもの.
            const p = sumTxt.indexOf("</think>");
            if (p != -1) {
                sumTxt = sumTxt.substring(p + 8).trim();
            }

            // json変換処理.
            let jsonValue = _resultSummayToJson(sumTxt);

            // topIndex(タグ、カテゴリなど)
            let topIndex = "";

            // jsonパースが成功している場合.
            if (jsonValue != null) {
                // ファイル名をタイトルとしてセット.
                topIndex += "title:'" + textDocName + "'";
                // topIndexを生成.
                for (let k in jsonValue) {
                    // サマリー以外を採用する.
                    if (k == "summary") {
                        continue;
                    }
                    if (topIndex.length > 0) {
                        topIndex += ",";
                    }
                    topIndex += k + ":'" + jsonValue[k] + "'";
                }
                topIndex = topIndex.trim();

                // JSON内容を文字列に置き換える.
                sumTxt =
                    "~~~json\n" +
                    JSON.stringify(jsonValue, null, " ") +
                    "\n~~~";

                // jsonValueクリア.
                jsonValue = null;
            }

            // debug.
            console.debug("サマリー結果: \n" + sumTxt);
            console.debug("topIndex: " + topIndex);
            console.debug("\n");

            // サマリーに文書を登録 (既存の場合は上書き)
            const summaryValue = new VSummaryValue(sumTxt, textUrl);

            // ── 本文テキストの前処理 ──
            // 要約生成後に本文を前処理する.
            text = Conv.stripMarkdown(text); // マークダウン除去
            text = Conv.exclusionText(text); // 全角スペース・\r・\t 除去
            text = Conv.trimEnterText(text); // 余分な空行除去

            // 要約テキストを本文先頭に付加する.
            // これにより各チャンクに文書全体のコンテキストが加わり、検索精度が向上する.
            text = "【サマリー】: \n" + sumTxt + "\n\n 【本文】: \n" + text;
            sumTxt = null;

            // ── チャンク分割 + 埋め込みベクトル化 ──
            // embBaseUrl で指定した埋め込みモデルサーバーを使用する.
            const chunkTextList = _stringToChunks(text, chunkSize, overlap);
            const chunkLen = chunkTextList.length;
            let i, chkTxt, emb, chunkAllLen;
            tm = Date.now();

            // topIndexが有効な場合は、対象のVectorChunkを作成.
            const chunkList = [];
            chunkAllLen = chunkLen;
            if (topIndex.length > 0) {
                // topIndexの長さがchunkLenを超える場合は、その長さに合わせる.
                if (topIndex.length > chunkLen) {
                    topIndex = topIndex.substring(0, chunkLen);
                }
                chunkAllLen++;
                emb = await LlamaCpp.getEmbedding(
                    embBaseUrl,
                    topIndex,
                    embObj && embObj.model,
                    embObj && embObj.apiKey,
                );
                chunkList.push(
                    new VectorChunk(
                        topIndex,
                        chunkList.length,
                        chunkAllLen,
                        textDocName,
                        emb,
                    ),
                );
            }

            // 組み込みインデックスでVectorChunkを作成.
            console.debug("start.getEmbedding(" + chunkLen + ")");
            for (i = 0; i < chunkLen; i++) {
                chkTxt = chunkTextList[i];
                emb = await LlamaCpp.getEmbedding(
                    embBaseUrl,
                    chkTxt,
                    embObj && embObj.model,
                    embObj && embObj.apiKey,
                );
                chunkList.push(
                    new VectorChunk(
                        chkTxt,
                        chunkList.length,
                        chunkAllLen,
                        textDocName,
                        emb,
                    ),
                );
                //console.debug("[" + i + "]");
            }
            console.debug(
                "end.getEmbedding(" +
                    chunkLen +
                    "): " +
                    (Date.now() - tm) +
                    " msec",
            );

            // VectorGroupファイル更新開始.
            const lockUk = await sync.lock(groupName);
            try {
                let list, summary, len;

                // グループ名から各種ファイル名を取得.
                const { vsFileName, vgFileName } =
                    _getGroupNameToFileName(groupName);

                // 既にファイルがvectorGroupファイルが存在するか確認し
                // ファイル構成に問題がないか確認する.
                let isFileFlag = false;
                if (_isFile(dirPath, vgFileName)) {
                    // .vgs が既に存在する場合 → ロードして同名文書のチャンクを除外
                    if (!_isFile(dirPath, vsFileName)) {
                        throw new Error(
                            "Target VectorSummary file does not exist: " +
                                vsFileName,
                        );
                    }
                    // ファイルは存在するので、アップデート追加する.
                    isFileFlag = true;
                }

                // 既にVectorGroupファイルが存在する場合.
                // ※ 既に sync.lock(groupName) を保持しているため、ロック無し版を使用する.
                if (isFileFlag) {
                    const vg = _loadVectorGroupUnlocked(groupName, dirPath);
                    list = vg.getChunked().filter(function (ck) {
                        return ck.docName !== textDocName;
                    });
                    summary = vg.getSummary();
                } else {
                    // ファイルが存在しない場合.
                    list = [];
                    summary = new VectorSummary();
                }

                // 今回更新するVectorChunkリストを追加.
                len = chunkList.length;
                for (let i = 0; i < len; i++) {
                    list.push(chunkList[i]);
                }

                // 今回更新するサマリーを定義.
                summary.put(textDocName, summaryValue);

                // 更新されたチャンク群とサマリーをそれぞれ保存
                _saveGroup(groupName, list, dirPath);
                _saveSummary(groupName, summary, dirPath);
                console.debug("ファイル出力完了");
            } finally {
                // VectorGroupファイル更新終了.
                sync.unlock(groupName, lockUk);
            }
            console.debug("ファイル出力完了[END]");
        } finally {
            // 利用終了.
            if (embObj != null) {
                embObj.endConnect();
            }
            if (ifObj != null) {
                ifObj.endConnect();
            }
        }
    };

    /**
     * 指定グループから特定のテキストファイルに対応するチャンクを削除する.
     *
     * 【処理の流れ】
     *   1. .vgs / .vss の両ファイルが存在するか確認する.
     *   2. 対象 docName のチャンクをフィルタリングで除外する.
     *   3. チャンクが 1 件も残らない場合は .vgs / .vss 両ファイルを削除する.
     *   4. チャンクが残る場合は更新して保存し、サマリーからも該当エントリを削除する.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string}  groupName       グループ名
     * @param  {string}  textFileName    削除するファイル名 (拡張子込み)
     * @param  {string}  [*]dirPath      ディレクトリパス
     * @return {boolean} true = 削除成功 / false = 削除対象が存在しなかった
     * @throws {Error}   片方のファイルしか存在しない場合 (データ不整合)
     */
    const removeTextFileFromVectorGroup = async function (
        groupName,
        textFileName,
        dirPath,
    ) {
        // ディレクトリ作成を行い、正しいディレクトリパスを返却.
        dirPath = _mkdirsToVectorStore(dirPath);
        const textDocName = _cutExtension(textFileName);
        const pg = _trimPathGroup(dirPath, groupName);
        dirPath = pg.path;
        groupName = pg.groupName;

        // VectorGroupファイル更新開始.
        const lockUk = await sync.lock(groupName);
        try {
            // グループ名から各種ファイル名を取得.
            const { vsFileName, vgFileName } =
                _getGroupNameToFileName(groupName);
            const vgFile = _isFile(dirPath, vgFileName);
            const vsFile = _isFile(dirPath, vsFileName);

            // ファイル存在チェック
            if (!vgFile || !vsFile) {
                if (!vgFile && !vsFile) {
                    // 両方ない → 既に削除済みなので正常扱い
                    return false;
                }
                // 片方だけある → データ不整合
                if (!vgFile)
                    throw new Error(
                        "VectorGroup file does not exist: " + groupName,
                    );
                throw new Error(
                    "VectorSummary file does not exist: " + groupName,
                );
            }

            // ※ 既に sync.lock(groupName) を保持しているため、ロック無し版を使用する.
            const vg = _loadVectorGroupUnlocked(groupName, dirPath);
            const summary = vg.getSummary();
            let removeFlag = false; // 実際に削除対象が見つかったかのフラグ

            // 対象 docName のチャンクを除外
            const list = vg.getChunked().filter(function (ck) {
                if (ck.docName === textDocName) {
                    removeFlag = true;
                    return false;
                }
                return true;
            });

            if (list.length === 0) {
                // チャンクが全て削除対象だった → ファイルごと削除
                const err1 = _removeFile(dirPath, vgFileName);
                const err2 = _removeFile(dirPath, vsFileName);
                // 削除失敗した場合はエラーをスロー (両方試してからチェックする)
                if (err1) throw err1;
                if (err2) throw err2;
                return true;
            }

            if (!removeFlag) {
                // 該当 docName のチャンクが1件も見つからなかった
                return false;
            }

            // 残ったチャンクで .vgs を更新し、サマリーからも該当エントリを削除して保存
            _saveGroup(groupName, list, dirPath);
            summary.getList().delete(textDocName);
            _saveSummary(groupName, summary, dirPath);
            return true;
        } finally {
            // VectorGroupファイル更新終了.
            sync.unlock(groupName, lockUk);
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // ベクトル検索 (RAG コア)
    // ═══════════════════════════════════════════════════════════════

    /**
     * [private]検索結果 (VectorChunk[]) を tag/category でフィルタリングする.
     *
     * 各チャンクの docName から保存済みサマリーテキストを再パースして tag/category
     * を取得し、tags/categories のいずれかに1つでも一致すれば残す (OR条件).
     * tags/categories どちらも未指定の場合は絞り込みを行わずそのまま返す.
     *
     * ※ ベクトル検索で既に上位 length 件に絞られた候補に対する事後フィルタである点に注意.
     *   (フィルタ対象のタグ/カテゴリを持つ文書が、そもそも上位候補に入っていなければ拾えない)
     *
     * @param  {VectorChunk[]} list        フィルタ対象の検索結果.
     * @param  {string[]}      [tags]       絞り込み対象の tag 一覧.
     * @param  {string[]}      [categories] 絞り込み対象の category 一覧.
     * @return {VectorChunk[]}
     */
    const _filterByTagCategory = function (list, tags, categories) {
        const tagSet = Array.isArray(tags) && tags.length > 0 ? new Set(tags) : null;
        const categorySet =
            Array.isArray(categories) && categories.length > 0
                ? new Set(categories)
                : null;
        if (tagSet == null && categorySet == null) {
            return list;
        }
        return list.filter(function (chunk) {
            const parsed = _resultSummayToJson(
                chunk.summary.getText(chunk.docName),
            );
            if (parsed == null) {
                return false;
            }
            if (tagSet != null && tagSet.has(parsed.tag)) {
                return true;
            }
            if (categorySet != null) {
                const cats = Array.isArray(parsed.category)
                    ? parsed.category
                    : parsed.category
                      ? [parsed.category]
                      : [];
                for (let i = 0; i < cats.length; i++) {
                    if (categorySet.has(cats[i])) {
                        return true;
                    }
                }
            }
            return false;
        });
    };

    /**
     * 自然言語クエリを受け取り、VectorGroup からスコア降順の VectorChunk[] を返す.
     *
     * 【処理の流れ】
     *   1. クエリ文字列を _stringToChunks() で分割する.
     *      (長い質問文もチャンク単位で検索することで検索漏れを防ぐ)
     *   2. 各クエリチャンクを LlamaCpp.getEmbedding() でベクトル化する.
     *   3. VectorGroup.searchEmbedding() でスコア上位 length 件を取得してリストに追加する.
     *   4. 全クエリチャンクの結果をまとめてスコア降順にソートする.
     *   5. tags/categories が指定されている場合、それらに一致する文書のみに絞り込む.
     *
     * 【使い方】
     *   const vg = await loadVectorGroup('docs', '/data');
     *   const results = await searchEmbedding(vg, 'RAGとは何ですか?',
     *       {length: 5, chunkSize: 500, overlapSize: 50, embBaseUrl: 'http://localhost:8080'});
     *     or
     *   const results = await searchEmbedding(vg, 'RAGとは何ですか?'); // 第３引数から省略可能.
     *   // results[0] が最もクエリに近いチャンク
     *
     * @param  {VectorGroup} vg             検索対象の VectorGroup
     * @param  {string}      message        自然言語のクエリ文字列
     * @param {object}       options        オプションパラメータを設定します.
     *   - {number}          length         1クエリチャンクあたりの最大取得件数(検索候補枠)
     *   - {number}          chunkSize      クエリ分割時の最大文字数
     *   - {number}          overlapSize    クエリ分割時のオーバーラップ文字数
     *   - {string}          embBaseUrl     埋め込みモデルサーバーの URL
     *   - {string[]}        tags           絞り込み対象の tag 一覧 (いずれか一致でOR).
     *   - {string[]}        categories     絞り込み対象の category 一覧 (いずれか一致でOR).
     * @return {Promise<VectorChunk[]>}     スコア降順にソートされた結果配列
     */
    const searchEmbedding = async function (vg, message, options) {
        // options が設定せれていない場合.
        options = options || {};
        // コンフィグから設定する.
        const conf = Config.getInstance();
        // オプションパラメータを取得.
        let length = options.length || conf.vectorSearchLength;
        let chunkSize = options.chunkSize || conf.chunkSize;
        let overlap = options.overlap || conf.overlapSize;
        let embBaseUrl = options.embBaseUrl || null;

        // embBaseUrl が存在しない場合、config定義されている内容から割り当てる.
        let embObj = null;
        if (embBaseUrl === undefined || embBaseUrl === null) {
            embObj = conf.getEmbeddingURL();
            embBaseUrl = embObj.baseUrl;
        }
        try {
            // クエリを文字数制限でチャンク分割する
            const chunks = _stringToChunks(message, chunkSize, overlap);
            const list = [];
            const ary = new Array(length);
            const len = chunks.length;

            let i, semb, resLen, j;
            for (i = 0; i < len; i++) {
                // クエリチャンクを埋め込みベクトルに変換
                semb = await LlamaCpp.getEmbedding(
                    embBaseUrl,
                    chunks[i],
                    embObj && embObj.model,
                    embObj && embObj.apiKey,
                );
                // VectorGroup からベクトルに近い上位 length 件を取得
                resLen = vg.searchEmbedding(ary, semb);
                resLen = resLen > length ? length : resLen;
                // 結果リストに追加
                for (j = 0; j < resLen; j++) {
                    list.push(ary[j]);
                }
            }

            // 全クエリチャンクの結果をまとめてスコア降順にソート
            // (降順取り出し相当)
            list.sort(function (a, b) {
                return b.score - a.score;
            });
            // tags/categories が指定されている場合はそれらに一致する文書のみに絞り込む.
            return _filterByTagCategory(list, options.tags, options.categories);
        } finally {
            // 利用終了.
            if (embObj != null) {
                embObj.endConnect();
            }
        }
    };

    /**
     * 複数の searchEmbedding結果を統合する.
     * @param {arguments} 複数の searchEmbedding結果(VectorChunk[])を設定します.
     * @returns {VectorChunk[]} 統合され得点の高い準にソートされた結果が返却されます.
     */
    const resultEmbeddingToTotalization = function () {
        let args = Array.prototype.slice.call(arguments);
        // １つの配列で設定.
        if (args.length == 1 && Array.isArray(args[0])) {
            args = args[0];
        }
        // すべての内容を統合する.
        const ret = {};
        const len = args.length;
        let i, j, lenJ, em;
        for (i = 0; i < len; i++) {
            em = args[i];
            lenJ = em.length;
            for (j = 0; j < lenJ; j++) {
                ret[ret.length] = em[j];
            }
        }
        // 全クエリチャンクの結果をまとめてスコア降順にソート
        // (降順取り出し相当)
        ret.sort(function (a, b) {
            return b.score - a.score;
        });
        return ret;
    };

    /**
     * [private]条件が一致する場合に参考文書を付与した形の返却をする.
     * @param {*} resTxt 元の検索結果文書.
     * @param {*} lastReferenceSmb 参考文書一覧列挙のタイトルシンボル名を設定します.
     * @param {*} targetList
     * @param {*} maxLen
     * @returns {string} 検索結果内容が返却されます.
     */
    const _setLastReferenceSymbol = function (
        resTxt,
        lastReferenceSmb,
        targetList,
        maxLen,
    ) {
        // lastReferenceSmb が文字列でない、０文字列の場合.
        if (typeof lastReferenceSmb != "string" || lastReferenceSmb <= 0) {
            // 設定対象が存在しないので付与しない.
            return resTxt;
        }
        // 最後から「lastReferenceSmb」の文字列を検索/
        const p = resTxt.lastIndexOf(lastReferenceSmb);
        // 見つかった場合、そして見つかった内容が 全体文字数の半分より後ろの場合.
        //if (p != -1 && p > resTxt.length >> 1) {
        // 見つかった場合.
        if (p != -1) {
            // 存在すると満たして、付与しない.
            return resTxt;
        }
        resTxt = resTxt + "\n\n---\n\n【" + lastReferenceSmb + "】\n";
        // 参考文書をセット.
        let vc, txt;
        txt = "";
        for (let i = 0; i < maxLen; i++) {
            vc = targetList[i][0];
            //  [{文書名}]({文書URL}) で記載.
            txt +=
                "" +
                (i + 1) +
                ". [" +
                vc.docName +
                "](" +
                vc.summary.getUrl(vc.docName) +
                ")\n";
        }
        txt +=
            " ※ 上の【" +
            lastReferenceSmb +
            "】内容は検索候補一覧で、検索結果に一致してない内容も含まれています.\n";
        return resTxt + txt;
    };

    /**
     * searchEmbedding での検索結果を設定して、Rag検索を実行.
     *
     * @param {VectorChunk[]} resSearchEmb [searchEmbedding] の処理結果を設定します.
     * @param {string} message 自然言語のクエリ文字列
     * @param {object} options オプションパラメータを設定します.
     *   - {number} topLength RAGプロンプトに含めるチャンク数を設定します.
     *   - {number} temperature RAG推論の正確性を示す値を設定します.
     *   - {string} ragRequestChunkFormat RAGプロンプト内の1チャンク分フォーマットを設定します.
     *   - {string} ifBaseUrl 推論モデルサーバーの URL (例: 'http://localhost:8081')を設定します.
     *   - {boolean} ragReasoning 推論モードのON OFF を設定します.
     *   - {string} lastReferenceSmb 対象内容の文字が設定された場合、デフォルト値だと
     *                                ・参照文書一覧
     *                               が「文書最後に参考文書一覧」として列挙されるがこれが行われて
     *                               いない場合に、検索候補の結果を代替えで表示する場合にセットする.
     * @return {Promise<string>} 回答内容が返却されます.
     */
    const searchInference = async function (resSearchEmb, message, options) {
        // options が設定せれていない場合.
        options = options || {};

        // コンフィグから設定する.
        const conf = Config.getInstance();
        let topLength = options.topLength || conf.ragRequestChunkLength;
        let temperature = options.temperature || conf.ragTemperature;
        let ragRequestChunkFormat = options.ragRequestChunkFormat || null;
        let ifBaseUrl = options.ifBaseUrl || null;
        let ragReasoning =
            options.ragReasoning == true || options.ragReasoning == false
                ? options.ragReasoning
                : conf.ragReasoning;
        let lastReferenceSmb =
            options.lastReferenceSmb || conf.lastReferenceSmb;

        // ifBaseUrl が存在しない場合、config定義されている内容から割り当てる.
        let ifObj = null;
        if (ifBaseUrl === undefined || ifBaseUrl === null) {
            ifObj = conf.getInferenceURL();
            ifBaseUrl = ifObj.baseUrl;
        }
        try {
            // 検索処理を実施.
            const resLen = resSearchEmb.length;

            // まず同一のDoc名の検索結果(resSearchEmb)をまとめる.
            // 内容としては点数順
            const targetList = [];
            const targetDocNameIndex = {};

            // 同一のDoc名で検索結果の内容をまとめる.
            let em, docName, embList;
            for (let i = 0; i < resLen; i++) {
                em = resSearchEmb[i];
                docName = em.docName;
                embList = targetDocNameIndex[docName];
                if (embList == undefined) {
                    embList = [];
                    // 検索順位のdocName単位で追加.
                    targetList[targetList.length] = embList;
                    targetDocNameIndex[docName] = embList;
                }
                // 取得リストに追加していく
                embList[embList.length] = em;
            }

            // 検索候数件数を取得.
            const targetLen = targetList.length;
            const maxLen = targetLen >= topLength ? topLength : targetLen;

            // RAG検索用のヒントとなるchunked文字を生成.
            let chunkString = "";
            let vc, j, lenJ, n, targetChunkeds;
            for (let i = 0; i < maxLen; i++) {
                // targetChunkeds を作成.
                em = targetList[i];
                lenJ = em.length;
                targetChunkeds = "";
                for (j = 0; j < lenJ; j++) {
                    n = em[j];
                    if (j != 0) {
                        targetChunkeds += "\n";
                    }
                    // 1つの要素(VectorChuk)の文章番号と文章内容を出力.
                    targetChunkeds +=
                        " - 【indexNo: " +
                        n.indexNo +
                        ", score: " +
                        n.score +
                        "】:" +
                        n.text;
                }
                targetChunkeds += "\n";
                // １つのdocNameに対するサマリーを生成.
                if (i != 0) {
                    chunkString += "\n";
                }
                // 先頭のVectorChunkをragRequestChunk対象とする.
                vc = em[0];
                chunkString += conf.getRagRequestChunk(
                    ragRequestChunkFormat,
                    i + 1,
                    vc.docName,
                    vc.summary.getUrl(vc.docName),
                    vc.score,
                    vc.summary.getText(vc.docName),
                    targetChunkeds,
                );
            }
            // RAG プロンプトの作成.
            const ragPrompt = Prompt.getRagRequest(chunkString, message);
            // Rag検索を実行.
            let ret = await LlamaCpp.getInferenceMessage(
                ifBaseUrl,
                ragPrompt.system,
                ragPrompt.user,
                temperature,
                null,
                ragReasoning,
                ifObj && ifObj.model,
                ifObj && ifObj.apiKey,
            );
            // AI回答の文字列に</think>が設定されている場合.
            // この文字以降のものだけを採用する.
            const p = ret.indexOf("</think>");
            if (p != -1) {
                ret = ret.substring(p + 8).trim();
            }
            // <answer>と</answer>が存在する場合は削除.
            ret = util.changeString(ret, "<answer>", "");
            ret = util.changeString(ret, "</answer>", "");

            // lastReferenceSmb が文字列で存在する場合、
            // 参考文書がRAG回答に存在しない場合に付与する.
            return _setLastReferenceSymbol(
                ret,
                lastReferenceSmb,
                targetList,
                maxLen,
            );
        } finally {
            // 利用終了.
            if (ifObj != null) {
                ifObj.endConnect();
            }
        }
    };

    /**
     * Rag検索を実行.
     *
     * @param {VectorGroup} vg 検索対象の VectorGroup を設定します.
     * @param {string} message 自然言語のクエリ文字列
     * @param {object} options オプションパラメータを設定します.
     *   - {number} length 1クエリチャンクあたりの最大取得件数(検索候補枠)
     *   - {number} chunkSize クエリ分割時の最大文字数
     *   - {number} overlapSize クエリ分割時のオーバーラップ文字数
     *   - {string} embBaseUrl 埋め込みモデルサーバーの URL
     *   - {number} topLength RAGプロンプトに含めるチャンク数を設定します.
     *   - {number} temperature RAG推論の正確性を示す値を設定します.
     *   - {string} ragRequestChunkFormat RAGプロンプト内の1チャンク分フォーマットを設定します.
     *   - {string} ifBaseUrl 推論モデルサーバーの URL (例: 'http://localhost:8081')を設定します.
     *   - {boolean} ragReasoning 推論モードのON OFF を設定します.
     *   - {string} lastReferenceSmb 対象内容の文字が設定された場合、デフォルト値だと
     *                                ・参照文書一覧
     *                               が「文書最後に参考文書一覧」として列挙されるがこれが行われて
     *                               いない場合に、検索候補の結果を代替えで表示する場合にセットする.
     * @return {Promise<string>} 回答内容が返却されます.
     */
    const search = async function (vg, message, options) {
        // 組み込み検索.
        const resSearchEmb = await searchEmbedding(vg, message, options);
        // rag検索.
        return await searchInference(resSearchEmb, message, options);
    };

    // ═══════════════════════════════════════════════════════════════
    // VectorGroupFile 変更検出
    // ═══════════════════════════════════════════════════════════════

    /**
     * 指定ディレクトリ内の .vgs ファイルを走査し、
     * 前回チェック時から追加・更新・削除されたグループ名の一覧を返す.
     *
     * 【使い方のイメージ】
     *   const gfileList = new Map(); // 呼び出し元で永続管理する Map
     *   setInterval(function() {
     *     const changed = updateVectorGroupFileNames(gfileList, '/data');
     *     // changed に含まれるグループを再ロードするなどの処理を行う
     *   }, 5000);
     *
     * 【変更検出の仕組み】
     *   - gfileList に存在しない .vgs ファイルが見つかった → 新規追加
     *   - gfileList に存在するが fileTime が変わった .vgs ファイルが見つかった → 更新
     *   - gfileList に存在するが今回の走査で見つからなかったグループ → 削除
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {Map<string, VGFileInfo>} gfileList
     *   管理中のグループファイルマップ (呼び出し元で永続保持すること).
     *   この関数の呼び出しごとに Map の内容が更新される.
     * @param  {string} [*]dirPath  走査するディレクトリパス
     * @return {string[]}  今回の走査で変更・削除が確認されたグループ名の配列.
     *                     変更がなければ空配列を返す.
     */
    const updateVectorGroupFileNames = function (gfileList, dirPath) {
        // ディレクトリ作成を行い、正しいディレクトリパスを返却.
        dirPath = _mkdirsToVectorStore(dirPath);
        const nowGroups = new Set(); // 今回の走査で見つかったグループ名セット
        const ret = []; // 変更されたグループ名リスト
        const files = _getPathToFiles(dirPath);

        for (let i = 0; i < files.length; i++) {
            const name = files[i];
            // .vgs 以外のファイルはスキップ
            if (!name.endsWith(VECTOR_GROUP_FILE_EXTENSION)) continue;

            // 拡張子を除いてグループ名を取得
            const group = name.slice(0, -FILE_EXTENSION_SIZE);
            nowGroups.add(group);

            const time = _getFileTime(dirPath + "/" + name);
            const src = gfileList.get(group);

            if (src === undefined || src.fileTime !== time) {
                // 新規 or ファイルタイムが変わった → 変更リストに追加してマップを更新
                gfileList.set(
                    group,
                    new VGFileInfo(group, dirPath, name, time),
                );
                ret.push(group);
            }
        }

        // 今回の走査で見つからなかったグループ = 削除されたグループ
        const removeGroups = [];
        gfileList.forEach(function (val, group) {
            if (!nowGroups.has(group)) {
                ret.push(group); // 変更リストに追加
                removeGroups.push(group); // マップから削除するために記録
            }
        });
        // forEach 中にマップを直接変更しないよう、別ループで削除する
        for (let i = 0; i < removeGroups.length; i++) {
            gfileList.delete(removeGroups[i]);
        }
        return ret;
    };

    /**
     * 指定ディレクトリ内に存在する VectorGroup (.vgsファイル) のグループ名一覧を返す.
     *
     * updateVectorGroupFileNames() と異なり、変更検出用の Map を必要とせず、
     * その時点で存在するグループ名を単純に列挙する (APIの一覧取得などに利用).
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string} [*]dirPath  走査するディレクトリパス
     * @return {string[]}  グループ名の配列.
     */
    const listGroups = function (dirPath) {
        dirPath = _mkdirsToVectorStore(dirPath);
        const files = _getPathToFiles(dirPath);
        const ret = [];
        for (let i = 0; i < files.length; i++) {
            const name = files[i];
            if (!name.endsWith(VECTOR_GROUP_FILE_EXTENSION)) continue;
            ret.push(name.slice(0, -FILE_EXTENSION_SIZE));
        }
        return ret;
    };

    /**
     * グループ内の全文書が持つ tag / category の集計情報を返す.
     *
     * 各文書のサマリー保存テキスト (putTextFileToVectorGroup() が
     * "~~~json {tag, category, summary} ~~~" 形式で保存したもの) を
     * _resultSummayToJson() で再パースして集計する.
     *
     * tag は1文書1値の想定なので単純カウント、category は1文書で複数の値を
     * 持てる想定なので、該当する category 全てにカウントする.
     *
     * [*] の条件は設定しない場合 Config定義の内容を対象とします.
     * @param  {string} groupName   グループ名
     * @param  {string} [*]dirPath  ディレクトリパス
     * @return {{
     *   totalDocuments: number,
     *   unparsedDocuments: number,
     *   tags: {name: string, count: number, ratio: number}[],
     *   categories: {name: string, count: number, ratio: number}[]
     * }}
     */
    const getGroupStats = async function (groupName, dirPath) {
        const vgObj = await loadVectorGroup(groupName, dirPath);
        const summary = vgObj.getSummary();
        const names = summary.getDocuments();
        const totalDocuments = names.length;

        const tagCounts = new Map();
        const categoryCounts = new Map();
        let unparsedDocuments = 0;

        for (let i = 0; i < names.length; i++) {
            const text = summary.getText(names[i]);
            const parsed = _resultSummayToJson(text);
            if (parsed == null) {
                unparsedDocuments++;
                continue;
            }
            // tag は1文書1値の想定 (String).
            if (typeof parsed.tag === "string" && parsed.tag.length > 0) {
                tagCounts.set(parsed.tag, (tagCounts.get(parsed.tag) || 0) + 1);
            }
            // category は複数値の想定 (Array). 単一値で返ってきた場合も配列扱いにする.
            const categories = Array.isArray(parsed.category)
                ? parsed.category
                : parsed.category
                  ? [parsed.category]
                  : [];
            for (let j = 0; j < categories.length; j++) {
                const c = categories[j];
                if (typeof c === "string" && c.length > 0) {
                    categoryCounts.set(c, (categoryCounts.get(c) || 0) + 1);
                }
            }
        }

        // Map を {name, count, ratio} 配列に変換し、件数の多い順に並べる.
        const toSortedArray = function (counts) {
            const ret = [];
            counts.forEach(function (count, name) {
                ret.push({
                    name,
                    count,
                    ratio: totalDocuments > 0 ? count / totalDocuments : 0,
                });
            });
            ret.sort((a, b) => b.count - a.count);
            return ret;
        };

        return {
            totalDocuments,
            unparsedDocuments,
            tags: toSortedArray(tagCounts),
            categories: toSortedArray(categoryCounts),
        };
    };

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    module.exports = {
        VectorChunk,
        VectorGroup,
        VGFileInfo,
        loadVectorGroup,
        putTextFileToVectorGroup,
        removeTextFileFromVectorGroup,
        searchEmbedding,
        resultEmbeddingToTotalization,
        searchInference,
        search,
        updateVectorGroupFileNames,
        listGroups,
        getGroupStats,
        // 保存済みサマリーテキストから {tag, category, summary} を再パースする.
        // (putTextFileToVectorGroup() が保存する "~~~json {...} ~~~" 形式が対象)
        parseSummaryJson: _resultSummayToJson,
    };
})();
