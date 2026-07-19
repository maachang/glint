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
- 文書登録時にサマリーと合わせて「タグ・カテゴリ」もLLMに生成させて保存しており、グループ内のタグ/カテゴリ集計（件数・比率）取得や、RAG検索結果へのタグ/カテゴリでの絞り込み（事後フィルタ）に利用している
- llama.cppサーバへの実際の推論プロンプトは英語化している（`src/prompt.js` の `*_EN`）。トークン処理効率を上げて応答速度を高速化する狙いで、日本語版（`*_JA`）は保守・内容確認用としてのみ残している
- `src/apiServer.js`（HTTP部分はNode標準httpのみ）でHTTP API化しており、文書登録・RAG検索・グループ一覧/文書一覧/タグカテゴリ集計などをAPI経由で利用できる
- llama.cppサーバへの接続は `src/connectMan.js` が管理する。サーバごとの同時接続数上限（`glint.json`の`maxConnectCount`）と定期ヘルスチェックに基づき、利用可能なサーバを選択する。利用可能なサーバが無い場合は例外を返す（待機・リトライはしない）
- `package.json` が存在し、`pdf-parse`（本プロジェクト唯一の外部npm依存）を使用する。`POST /groups/:group/documents` で `mimeType: "application/pdf"` + `fileBase64` を指定すると、`src/pdfExtract.js` でテキストレイヤー付きPDFからテキストを抽出して登録できる（スキャン画像PDFのOCRは未対応）
- 文書登録時に `url` を指定しない場合、アップロードした元データ（テキスト or PDFバイナリそのもの）を `conf.srcDocumentPath` 配下に保存し、`GET /groups/:group/documents/:fileName/raw` で読み出せるURLを自動発行して文書の参照URLとする。このURLのベースは `glint.json` の `publicBaseUrl`（リバースプロキシ配下等を想定した明示的な外部到達可能アドレス）が優先され、未設定時はリクエストの `Host` ヘッダーから組み立てる
- ログ出力は `src/localLog.js` が `console.*` を差し替えて日次ローテートのファイルにも記録する。ファイル出力・ターミナル出力ともに `glint.json` の `logLevel` で一括制御する（旧 `util.debugMode`/`debugOut` は `logLevel` と役割が重複するため廃止済み。詳細トレースは `vectorGroup.js` 内で直接 `console.debug` を呼ぶ形に統一）
- `scripts/build-bun.sh` で [Bun](https://bun.sh/) 向けの単一実行バイナリにコンパイル可能。`pdf-parse` が内部で動的require（`` require(`./pdf.js/${options.version}/build/pdf.js`) ``）を使っているため、Bunの静的バンドラでは素のままコンパイルできない（実行時に`Cannot find module`エラーになる）。このスクリプトはビルド直前に該当箇所を固定バージョンの静的requireへsedパッチし、コンパイル完了後に`node_modules`を元の動的require版へ復元する。`pdf-parse`のバージョンを更新した場合はスクリプト内の`PDF_JS_VERSION`も追従が必要。ビルド後、`src/public/` を出力バイナリと同じディレクトリの `public/` に自動コピーする（後述のBun対応と合わせて必要）
- llama.cpp専用ではなく、OpenAI本家・OpenAI互換ルーター（LiteLLM等）にも対応。`glint.json`の`embeddingList`/`inferenceList`各エントリ（またはグローバル既定）に `model`・`apiKey`・`apiType`(`"llamacpp"`既定 or `"openai"`) を指定可能。`apiKey`指定時は`Authorization: Bearer`ヘッダーを付与、`model`指定時はリクエストボディに含める。`apiType: "openai"` はヘルスチェック用の`/health`エンドポイントを持たない前提のため、`connectMan.js`はヘルスチェックを行わず常に healthy 扱いにする
- グループ単位のバックアップ/レストアに対応。`GET /groups/:group/backup` が `.vgs`/`.vss`・元データ(`srcDocumentPath`配下)・`glint.json`設定スナップショット(`apiKey`はマスク)を1つのJSON(base64埋め込み、tar/zip等の外部依存なし)にまとめて返し、`POST /groups/:group/restore` で復元する（既存グループがある場合は`overwrite:true`必須、設定スナップショットはグローバル設定には反映しない）
- ブラウザで使えるWeb管理画面を`src/public/`配下に用意（`index.mt.html`+`js/app.js`+`css/style.css`）。`apiServer.js`は既存APIルートに一致しないGETリクエストのフォールバックとして`src/public/`を静的配信し、`.mt.html`は`src/jhtml.js`（JSPライクなテンプレートエンジン）でサーバサイドレンダリングする。テンプレート内では`$request`/`$response`/`$out`/`$loadLib`(src/配下のモジュールを名前で動的requireする関数)が使える
  - **Bun対応の重要な注意点**: `new Function()`経由で実行されるコード内から**相対パス**でrequireすると、Bunで`--compile`したバイナリでは解決に失敗する(`Cannot find module './x' from '/$bunfs/root/...'`)。`$loadLib`は必ず`LIBRARY_PATH`(`__dirname`)基準の**絶対パス**に変換してからrequireすることで回避している。同様に、`PUBLIC_DIR`（`public/`の場所）も、Bunコンパイル済みバイナリ実行時は`__dirname`がコンパイル時の開発機パスに固定されてしまうため使えず、`process.execPath`（実行中バイナリの実際の場所）基準で解決するようにしている（`process.argv[1]`が`/$bunfs/`で始まるかで判定）

# ディレクトリ構成 

| ディレクトリ | 役割 |
|-------------|------|
| README.md | ドキュメントトップ(md) |
| .gitignore | githubリポジトリで利用するファイル(閲覧不要) |
| .claudeWork/ | Claude Code専用の作業領域（Gitにコミットしない）。詳細は作業領域（.claudeWork）節を参照 |
| test | (claudeはこの内容を見る必要がない)テスト実行を行うための、ベクトル情報や検索ソース情報が格納されている |
| test.js | (claudeはこの内容を見る必要がない)テスト実行用のプログラム|
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
| src/public/ | Web管理画面(index.mt.html + js/app.js + css/style.css). apiServer.jsが配信する. | 
| tests/ | ダミーllama.cpp接続(モック)を用いた自動テスト格納先 | 
| docs/ | セットアップマニュアル(setup.md)・apiServer.js詳細リファレンス(apiServer.md)等 | 
| scripts/build-bun.sh | Bunで単一実行バイナリにコンパイルするためのビルドスクリプト(pdf-parseの動的requireパッチを含む). | 

# 設計原則

- コンポーネントの再利用性を高める: 同じ実装、似たような実装は、共通化を図る
- シンプル化を意識したコーディング: スパゲティコーディングをしない
- 各ソースコードに「AIメモ」を作成: 過去のミスや問題が起きてしまう事を繰り返さない対策を行う
  - AIメモは必要なソースコードに対して、先頭部分に記載されているので、そこに追加・新たに必要な場合は新規でセットする

# あえてやってないこと

# 未対応・残課題(随時更新)
- `src/apiServer.js` は単一Node.jsプロセス前提の設計。複数プロセス/クラスタ化する場合は `connectMan.js` の接続数管理（現状プロセス内メモリのみ）をプロセス間で共有する仕組み（`sync.js`のファイルロックを応用する想定）への拡張が必要
- `connectMan.js` は定期ヘルスチェックのみで、リクエスト単位の即時エラー検知によるサーキットブレーカー（`reportError`/`reportSuccess`的な仕組み）は未実装
- RAG検索のタグ/カテゴリ絞り込み（`searchEmbedding`の`options.tags`/`options.categories`）は、ベクトル検索で既に絞られた上位候補に対する事後フィルタのため、対象タグ/カテゴリの文書が上位候補に入っていない場合は拾えない制約がある
- PDF登録（`src/pdfExtract.js`）はテキストレイヤー付きPDFのみ対応。スキャン画像PDFのOCR対応は未実装（マルチモーダルモデルでの対応も検討課題として残っている）
