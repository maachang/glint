# glint（localLLMを使ったRAGシステム）プロジェクト固有の情報

このファイルはClaude Codeがセッション開始時に自動的に読み込みます。 ここにはプロジェクト固有の事実を書く。 汎用的な開発知識（言語仕様・設計原則の教科書的説明など）は書かない。

# プロジェクト概要
glint（localLLMを使ったRAGシステム）をjavascripで実行できる環境を構築する。

# 作業領域（.claudeWork）

- プロジェクト直下の `.claudeWork/` はClaude Code専用の作業領域（Gitには一切コミットしない、.gitignore済み）
- セッションが落ちて再起動すると直前の会話内容は失われるため、途中の提案・調査結果・未確定の方針などで残しておきたいものは、このフォルダにファイルとして書いておくこと
- セッション開始時、作業に関連しそうであれば `.claudeWork/` の中身を確認すること
- プロジェクト固有の永続的な事実はここではなく本ファイル（CLAUDE.md）に書く。`.claudeWork`はあくまで一時的な作業メモ置き場

# コーディング規約

- 私の認識が常に正しいとは限らない。言っていることが本当に正しいか常に批判的に検証すること
- 実際の作業（コード生成など）に着手する前に、計画しているアプローチを報告すること
- 場当たり的、あるいは即興的で指示と関係ない狭い範囲を見ての対応を、許可無く行う事は絶対に禁止（必ず承認を得る）
- 実装を任された際「妥当」と思われる自身の判断に基づいて「詳細仕様」（データフィルタリング手法、抽出ロジック、初期値、制限値、除外基準など）を独断で決定・補完することは禁止
- 既存のコメントは、処理が変わって意味が通じなくなる場合以外は消さない
- ただし、一時的なログ出力などの実装については、役割が終わった場合は削除する
- コメントは日本語で書く
- ユーザーへの返答・要約・説明文は常に日本語で書く（英語での応答は禁止）
- バグ・エラーの原因調査を依頼された場合、原因が判明しても即座に修正しない。まず原因内容と修正方針を報告し、ユーザーの承認を得てから修正に着手すること（「原因確認」と「修正」は別の許可が必要な作業として扱う）

# プロジェクトの特性

- RAGを作る仮定で、これら「ベクトルDBは用いず、自前でベクトル検索」をしているため正確だが、件数上限がある（ベクトル検索インデックス的なものが使えないため）
- 一方で 通常のRAGと違って、文書単位でローカルLLMに「サマリー文書」を作成し、これらを含めてベクトルDBで検索された区切られたワードと合わせてAIに文書をまとめてもらうので、検索効率をあげている
- 文書登録時にサマリーと合わせて「タグ・カテゴリ」もLLMに生成させて保存しており、グループ内のタグ/カテゴリ集計（件数・比率）取得や、RAG検索時のタグ/カテゴリでの絞り込み（ベクトル検索のスコアリング前に候補チャンクを絞り込む事前フィルタ）に利用している。タグはグループ単位で「許可タグ一覧」（`GET`/`PUT /api/groups/:group/tags`）を設定でき、設定時はLLMがその一覧内から選択（該当なしは「その他」）、未設定時は自由生成のまま
- llama.cppサーバへの実際の推論プロンプトは英語化している（`src/prompt.js` の `*_EN`）。トークン処理効率を上げて応答速度を高速化する狙いで、日本語版（`*_JA`）は保守・内容確認用としてのみ残している
- `src/apiServer.js`（HTTP部分はNode標準httpのみ）でHTTP API化しており、文書登録・RAG検索・グループ一覧/文書一覧/タグカテゴリ集計などをAPI経由で利用できる
- llama.cppサーバへの接続は `src/connectMan.js` が管理する。サーバごとの同時接続数上限（`glint.json`の`maxConnectCount`）と定期ヘルスチェックに基づき、利用可能なサーバを選択する。利用可能なサーバが無い場合は例外を返す（待機・リトライはしない）
- `package.json` が存在し、`pdf-parse`（本プロジェクト唯一の外部npm依存）を使用する。`POST /api/groups/:group/documents` で `mimeType: "application/pdf"` + `fileBase64` を指定すると、`src/pdfExtract.js` でテキストレイヤー付きPDFからテキストを抽出して登録できる（スキャン画像PDFのOCRは未対応）
- 文書登録時に `url` を指定しない場合、アップロードした元データ（テキスト or PDFバイナリそのもの）を `conf.srcDocumentPath` 配下に保存し、`GET /api/groups/:group/documents/:fileName/raw` で読み出せるURLを自動発行して文書の参照URLとする。このURLのベースは `glint.json` の `publicBaseUrl`（リバースプロキシ配下等を想定した明示的な外部到達可能アドレス）が優先され、未設定時はリクエストの `Host` ヘッダーから組み立てる
- ログ出力は `src/localLog.js` が `console.*` を差し替えて日次ローテートのファイルにも記録する。ファイル出力・ターミナル出力ともに `glint.json` の `logLevel` で一括制御する（旧 `util.debugMode`/`debugOut` は `logLevel` と役割が重複するため廃止済み。詳細トレースは `vectorGroup.js` 内で直接 `console.debug` を呼ぶ形に統一）
- `scripts/build-bun.sh` で [Bun](https://bun.sh/) 向けの単一実行バイナリにコンパイル可能。`pdf-parse` が内部で動的require（`` require(`./pdf.js/${options.version}/build/pdf.js`) ``）を使っているため、Bunの静的バンドラでは素のままコンパイルできない（実行時に`Cannot find module`エラーになる）。このスクリプトはビルド直前に該当箇所を固定バージョンの静的requireへsedパッチし、コンパイル完了後に`node_modules`を元の動的require版へ復元する。`pdf-parse`のバージョンを更新した場合はスクリプト内の`PDF_JS_VERSION`も追従が必要。ビルド後、`src/public/` を出力バイナリと同じディレクトリの `public/` に自動コピーする（後述のBun対応と合わせて必要）
- llama.cpp専用ではなく、OpenAI本家・OpenAI互換ルーター（LiteLLM等）にも対応。`glint.json`の`embeddingList`/`inferenceList`各エントリ（またはグローバル既定）に `model`・`apiKey`・`apiType`(`"llamacpp"`既定 or `"openai"`) を指定可能。`apiKey`指定時は`Authorization: Bearer`ヘッダーを付与、`model`指定時はリクエストボディに含める。`apiType: "openai"` はヘルスチェック用の`/health`エンドポイント(llama.cpp独自)を持たない前提のため、`connectMan.js`はヘルスチェックを行わず常に healthy 扱いにする
- グループ単位のバックアップ/レストアに対応。`GET /api/groups/:group/backup` が `.vgs`/`.vss`・元データ(`srcDocumentPath`配下)・`glint.json`設定スナップショット(`apiKey`はマスク)を1つのJSON(base64埋め込み、tar/zip等の外部依存なし)にまとめて返し、`POST /api/groups/:group/restore` で復元する（既存グループがある場合は`overwrite:true`必須、設定スナップショットはグローバル設定には反映しない）
- 全JSON APIは`/api`配下に統一（`/api/groups`等）。`public/`配下の画面と名前空間を分離するための対応で、`/api`で始まらないGETリクエストのみ`src/public/`の静的配信・jhtml動的レンダリングのフォールバック対象になる（`/api`配下で該当ルートが無い場合は404、静的配信へはフォールバックしない）
- 文書一覧API(`GET /api/groups/:group/documents`)はクエリパラメータ`page`/`pageSize`/`tag`/`search`のいずれかを指定すると、`metaStore.js`（SQLite）で`summaries`/`documents`テーブルをJOIN・LIKE検索（ファイル名部分一致）・タグ完全一致・LIMIT/OFFSETするページング結果（`{total, page, pageSize, documents}`）を返す。何も指定しない場合は従来通り全件（`{count, documents}`）を返す後方互換設計。`pageSize`省略時は`glint.json`の`documentsPageSize`（デフォルト50）を使う。`vectorGroup.js`の`getGroupDocuments`は、documentsテーブルへのバックフィルが未実施の場合のみサマリー全件をロードする(`_ensureDocumentsBackfilledLazy`)ことで、ページング時に文書数が多いグループでも毎回全件をメモリにロードしない設計。Web UI(`groups.mt.html`+`js/groups.js`)では、ファイル名検索(デバウンス付き)・タグ絞り込み(集計タグ一覧からselectBoxで単一選択)・ページ送りボタンを実装
- 登録済み文書のtag/category修正に対応（`PUT /api/groups/:group/documents/:fileName/tags`、`vectorGroup.js`の`updateDocumentTagCategory`）。`metaStore.js`の`documents`テーブルのみを直接更新し、登録時に生成済みの要約本文(`summaries.text`)・埋め込みチャンク(topIndex含む)は一切再生成しない、という限定的な対応（意図的な仕様。要約本文・埋め込みへの反映が必要な場合は文書の再登録が必要）。`tag`はグループに許可タグ一覧が設定されている場合のみ、その一覧内または`"その他"`に制限される（`category`は常に自由入力）。Web UI(`groups.mt.html`+`js/groups.js`)では、許可タグ一覧が設定されているグループはタグ列をselectBox化（変更時に即時PUT保存）、未設定グループは自由入力のテキストフィールドのまま
  - この対応の過程で`metaStore.js`の既存バグを発見・修正済み：`upsertDocumentMeta`（`putTextFileToVectorGroup`が文書登録時に呼ぶ）は`backfill_status.documentsDone`フラグを立てていなかったため、文書登録後に一度も`getGroupDocuments`/`getGroupStats`を呼んでいないグループで最初にこれらAPIを呼ぶと、`ensureDocumentsBackfilled`が「未バックフィルの旧グループ」と誤判定し、`summaries`本文（登録時点のオリジナルのtag/category）から`documents`テーブルを丸ごと再構築してしまい、手動修正した内容が消失していた。`upsertDocumentMeta`実行時に`documentsDone`も同時に1にマークすることで解消（直接書き込みが行われた時点でそのグループのdocumentsデータは常に最新・正であるため）
- ブラウザで使えるWeb管理画面を`src/public/`配下に用意。機能別に3ページ構成（RAG検索=`index.mt.html`+`js/search.js`、文書登録=`documents.mt.html`+`js/documents.js`、グループ管理=`groups.mt.html`+`js/groups.js`）で、各ページ上部の共通メニュー(`js/menu.js`、`<nav id="appMenu">`にJSでリンクを描画)で切り替える。API呼び出しの共通処理(`callApi`/`escapeHtml`)は`js/common.js`に`window.Glint`名前空間で切り出し、他のページ用スクリプトより先に読み込む必要がある。jhtmlにHTML部分のinclude機構が無いため、共通メニューはHTML複製ではなくJS側で生成する方式にしている。`.mt.html`は`src/jhtml.js`（JSPライクなテンプレートエンジン）でサーバサイドレンダリングする。テンプレート内では`$request`/`$response`/`$out`/`$loadLib`(src/配下のモジュールを名前で動的requireする関数)が使える
- RAG検索の回答(`vg.search()`/`vg.searchInference()`の戻り値、および`POST /api/groups/:group/search`のレスポンス)は`{message: 回答本文(string, Markdown可), list: 引用した参考文書一覧(Array<{name,url}>)}`のJSON形式。LLMには`src/prompt.js`の`RAG_REQUEST_SYSTEM_PROMPT_EN`でこのJSON形式での出力を指示している(参照文書のMarkdownリンクをLLMに直接書かせず、`list`をクライアント側(`public/js/search.js`)で組み立てる方式。文書名/URLに括弧等が含まれる場合のMarkdownリンク記法崩れを回避するため)
- RAG検索には「ハイブリッド検索」（`glint.json`の`hybridSearch`/`hybridKeywordWeight`、デフォルトON）と「リランキング」（`ragRerank`/`rerankCandidateLength`、デフォルトON）が実装されている。ハイブリッド検索はベクトルのコサイン類似度に、`src/metaStore.js`（SQLite）のFTS5（`trigram`トークナイザ + BM25）によるキーワードスコアを合成し、固有名詞等の完全一致検索の弱さを補う（旧実装は文字2-gramの自前オーバーラップ計算だったが、FTS5/BM25に置き換え済み）。リランキングは、ベクトル検索で絞られた候補文書(`targetList`)をRAGプロンプトに含める前にLLMで質問との関連度順に並び替える(`_rerankTargetList`)。いずれもJSONパース失敗等の場合は元の順序にフォールバックする安全設計
- `src/metaStore.js` は `node:sqlite`（Node.js 22.5+の実験的機能。これに伴い必須Nodeバージョンを22.5以上に上げた）または`bun:sqlite`（Bun実行時）を使い、`vectorStorePath`配下の`glint.sqlite`（`.gitignore`済み）でデータを管理する。
- **チャンク本体・文書サマリーの本体データ自体もSQLite管理に全面移行済み**（`chunks`/`summaries`テーブル）。旧`.vgs`/`.vss`という独自バイナリファイルは廃止し、1文書の追加・削除は対象文書の行だけをINSERT/DELETEするだけで済むようになった（旧実装は1文書の追加・削除でもグループ全体をロード→フィルタ→丸ごと再書き込みしていたため非効率だった）。**旧`.vgs`/`.vss`ファイルからの読み込み・自動移行機能は一切存在しない**（後方互換は切り捨て済み。ディスク上に残っていても一切読み込まれない）。SQLiteが常に唯一の正の情報源であり、`VectorGroup`/`vectorGroup.js`側は自前でファイルの存在・mtime等を管理しない（`VGFileInfo`/`updateVectorGroupFileNames`/`isUpdateFile`/`getFileName`/`getFileTime`/`isUpdateFile`等の旧ファイル変更検出機能は削除済み）。バックアップ/レストア(`exportGroupFiles`/`importGroupFiles`)は、SQLiteデータをその場で従来の`.vgs`/`.vss`互換のバイト列にシリアライズ/デシリアライズすることで、バックアップのJSON形式自体は変更していない(ディスク上の`.vgs`/`.vss`ファイル自体は読み書きしない)。`getGroupStats`/`getGroupDocuments`/`getAllowedTags`はembedding(チャンク本体)を一切ロードしない軽量パス(`_loadSummaryOnly`)を使う。
- `summaries`テーブルの`url`カラムはNOT NULL制約を付けていない（nullを許容）。`vectorGroup.js`の`putTextFileToVectorGroup`自体はURLの自動発行機能を持たない低レベルAPIで、渡された`textUrl`をそのまま保存するだけ（nullならnullを保存）。URL未指定時の自動発行（元データを`conf.srcDocumentPath`配下に保存しURLを組み立てる処理）は`apiServer.js`側だけの機能（`req.headers.host`が必要なためHTTPリクエストの文脈が要る）で、`POST /api/groups/:group/documents`経由の場合のみ`vg.putTextFileToVectorGroup`呼び出し前にURLを確定させて渡している。`test.js`のようにHTTP層を経由せず直接呼ぶ場合はこの自動発行を受けないため、urlをnullで渡してもエラーにならない仕様
- `src/metaStore.js`のその他の用途: (1) 文書のtag/category集計（`documents`テーブル、`getGroupStats`をSQL化して高速化）, (2) チャンクの全文検索インデックス（`chunk_fts`, FTS5, ハイブリッド検索用）, (3) 検索ログ（`search_log`, `searchLogEnabled`設定でデフォルトOFFのopt-in、質問文・引用文書一覧を記録）, (4) 文書一覧API(`GET /api/groups/:group/documents`)のtag/category（`documents`テーブルを再利用し、1文書ごとのサマリー再パースを不要にする）, (5) グループの許可タグ一覧（`group_settings`テーブル）と、グループ一覧（`groups`テーブル。従来は`fs.readdirSync`+全ファイル`fs.statSync`のディレクトリスキャンだったが、SQLの`groups`テーブルへの単純なSELECT/INSERTに置き換えた。ディレクトリスキャンやキャッシュのマージ処理は無く、`listGroups`/`addGroup`/`groupExists`はいずれも素直なSQL操作のみ）。
- 検索精度を定量的に評価するCLIスクリプト`scripts/evalSearch.js`がある。質問と正解文書のペア(評価データセット, 形式は`tests/eval/example.json`参照)に対してRecall@Kを計測できる。embeddingモデルの選定やハイブリッド検索/リランキングのON/OFFなど、変更の効果を数値で確認する用途
  - **Bun対応の重要な注意点**: `new Function()`経由で実行されるコード内から**相対パス**でrequireすると、Bunで`--compile`したバイナリでは解決に失敗する(`Cannot find module './x' from '/$bunfs/root/...'`)。`$loadLib`は必ず`LIBRARY_PATH`(`__dirname`)基準の**絶対パス**に変換してからrequireすることで回避している。同様に、`PUBLIC_DIR`（`public/`の場所）も、Bunコンパイル済みバイナリ実行時は`__dirname`がコンパイル時の開発機パスに固定されてしまうため使えず、`process.execPath`（実行中バイナリの実際の場所）基準で解決するようにしている（`process.argv[1]`が`/$bunfs/`で始まるかで判定）

# ディレクトリ構成 

| ディレクトリ | 役割 |
|-------------|------|
| README.md | ドキュメントトップ(md) |
| .gitignore | githubリポジトリで利用するファイル(閲覧不要) |
| .claudeWork/ | Claude Code専用の作業領域（Gitにコミットしない）。詳細は作業領域（.claudeWork）節を参照 |
| test | (claudeはこの内容を見る必要がない)テスト実行を行うための、ベクトル情報や検索ソース情報が格納されている |
| test.js | (claudeはこの内容を見る必要がない)テスト実行用のプログラム(vectorGroup.jsを直接require)。個人の実データ用のため`.gitignore`済み(ルートの`/test.js`指定) |
| test2.js | (claudeはこの内容を見る必要がない)テスト実行用のプログラム(client/glintClient.js経由でapiServer.jsをHTTP APIから操作。test.jsのHTTP API版)。同上の理由で`.gitignore`済み |
| example/ | test.js/test2.js/glint.jsonのテンプレート(Git管理下、`VG_FILE_LIST`空・パスは`example/`基準)。ドキュメント等で使用例を示す際はここを参照する。ユーザーはこれをコピーしてルートに配置し内容を埋めて使う想定 |
| package.json | 依存パッケージ管理(唯一の外部依存: `pdf-parse`). | 
| src/config.js | 各定義条件＝glint.jsonで定義されたものを管理する. | 
| src/connectMan.js | llama.cpp接続先の選択・ヘルスチェック・同時接続数上限管理を行うもの. | 
| src/conv.js | 各種変換処理. | 
| src/llamaCpp.js | llamaCpp / OpenAI / OpenAI互換APIにアクセスするための実装(model/apiKey対応). | 
| src/localLog.js | `console.*` の出力をログファイルにも記録する仕組み(グローバルconsoleを差し替える). | 
| src/jhtml.js | jhtml(JSPライクなテンプレート)を実行可能なJSに変換するテンプレートエンジン. | 
| src/pdfExtract.js | PDF(テキストレイヤー付き)からのテキスト抽出(`pdf-parse`使用). | 
| src/prompt.js | システムプロンプト・ユーザプロンプトの定義(実際の推論には英語版`*_EN`を使用、日本語版`*_JA`は保守・確認用) | 
| src/sync.js | 複数のLocalLLM(llamaCpp)に接続管理を行うために必要な同期処理を行うもの | 
| src/util.js | ユーティリティ. | 
| src/vectorGroup.js | RAGの文書情報をベクトルDBに保存・管理するためのもの(タグ/カテゴリ集計・検索フィルタ含む)| 
| src/vectorSummary.js | RAGの文書をサマリー化して管理するためのもの | 
| src/xor128.js | 乱数発生装置 | 
| src/apiServer.js | 文書登録・RAG検索・グループ管理・バックアップ/レストア・Web画面配信を提供するHTTP APIサーバー | 
| src/public/ | Web管理画面(index/documents/groups.mt.html + js/common・menu・search・documents・groups.js + css/style.css). 機能別3ページ構成. apiServer.jsが配信する. | 
| tests/ | ダミーllama.cpp接続(モック)を用いた自動テスト格納先 | 
| docs/ | セットアップマニュアル(setup.md)・apiServer.js詳細リファレンス(apiServer.md)等 | 
| scripts/build-bun.sh | Bunで単一実行バイナリにコンパイルするためのビルドスクリプト(pdf-parseの動的requireパッチを含む). | 
| client/ | apiServer.jsのHTTP APIに接続するクライアントライブラリ。JS版`glintClient.js`とPython版`python/glint_client.py`(標準ライブラリのみ、外部依存無し)。src/配下は直接requireせずHTTP経由のみで操作する薄いラッパー。詳細は`client/README.md`/`client/python/README.md`参照 | 

# 設計原則

- コンポーネントの再利用性を高める: 同じ実装、似たような実装は、共通化を図る
- シンプル化を意識したコーディング: スパゲティコーディングをしない
- 各ソースコードに「AIメモ」を作成: 過去のミスや問題が起きてしまう事を繰り返さない対策を行う
  - AIメモは必要なソースコードに対して、先頭部分に記載されているので、そこに追加・新たに必要な場合は新規でセットする

# あえてやってないこと

# 未対応・残課題(随時更新)
- `src/apiServer.js` は単一Node.jsプロセス前提の設計。複数プロセス/クラスタ化する場合は `connectMan.js` の接続数管理（現状プロセス内メモリのみ）をプロセス間で共有する仕組み（`sync.js`のファイルロックを応用する想定）への拡張が必要
- `connectMan.js` は定期ヘルスチェックのみで、リクエスト単位の即時エラー検知によるサーキットブレーカー（`reportError`/`reportSuccess`的な仕組み）は未実装
- PDF登録（`src/pdfExtract.js`）はテキストレイヤー付きPDFのみ対応。スキャン画像PDFのOCR対応は未実装（マルチモーダルモデルでの対応も検討課題として残っている）
- リランキング（`ragRerank`）は候補文書のうち`rerankCandidateLength`件までしか対象にならず、それを超える候補は元のベクトルスコア順のまま並び替えられない
- ハイブリッド検索（`hybridSearch`）のキーワードスコアはFTS5(`trigram`トークナイザ)+BM25によるあくまで文字列一致であり、同義語や意味的な類似（例:「訴訟」と「裁判」）は考慮されない
