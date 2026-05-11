/**
 * BinaryUtil.js
 *
 * バイナリデータのエンコード・デコードを行うユーティリティモジュール.
 *
 * 【バイト順 (エンディアン) について】
 *   全てのメソッドはリトルエンディアン形式を使用する.
 *   リトルエンディアンとは、多バイト数値の「下位バイトを先頭 (低アドレス)」に
 *   格納する方式のこと.
 *   例: 0x1234 を 2 バイトで書くと → [0x34, 0x12]
 *
 * 【モジュール構成】
 *   - EncodeBinary : 数値・文字列 → Uint8Array/Buffer へ変換するメソッド群 (静的オブジェクト)
 *   - DecodeBinary : Buffer/Uint8Array を順番に読み進めるリーダークラス
 *
 * 【使い方】
 *   const { EncodeBinary, DecodeBinary } = require('./BinaryUtil');
 *
 *   // エンコード例
 *   const bytes = EncodeBinary.getInt(12345);   // → 4バイトの Buffer
 *
 *   // デコード例
 *   const bd = new DecodeBinary(buffer);
 *   const n  = bd.getInt();                     // 4バイト読んで number を返す
 */
(function (global) {
    "use strict";

    // ═══════════════════════════════════════════════════════════════
    // EncodeBinary
    //   数値・文字列を指定バイト数のバイナリ (Uint8Array / Buffer) に変換する.
    //   全メソッドは静的 (インスタンス不要) で、戻り値は常に新しいバイト列.
    // ═══════════════════════════════════════════════════════════════
    const EncodeBinary = {
        /**
         * 符号付き 1 バイト整数 (int8) をバイト列に変換する.
         *
         * 格納できる範囲: -128 ～ 127
         *
         * @param  {number} src  変換元の整数値
         * @return {Uint8Array}  1 バイトのバイト列
         */
        getInt1(src) {
            const buf = new ArrayBuffer(1);
            new DataView(buf).setInt8(0, src);
            return new Uint8Array(buf);
        },

        /**
         * 符号付き 2 バイト整数 (int16, リトルエンディアン) をバイト列に変換する.
         *
         * 格納できる範囲: -32768 ～ 32767
         * 例: 0x0102 → [0x02, 0x01]
         *
         * @param  {number} src  変換元の整数値
         * @return {Uint8Array}  2 バイトのバイト列
         */
        getInt2(src) {
            const buf = new ArrayBuffer(2);
            new DataView(buf).setInt16(0, src, true); // true = リトルエンディアン
            return new Uint8Array(buf);
        },

        /**
         * 符号付き 3 バイト整数 (int24, リトルエンディアン) をバイト列に変換する.
         *
         * DataView に 3 バイト専用メソッドがないため、ビット演算で手動分割する.
         * 格納できる範囲: -8388608 ～ 8388607
         * 例: 0x010203 → [0x03, 0x02, 0x01]
         *
         * @param  {number} src  変換元の整数値
         * @return {Uint8Array}  3 バイトのバイト列
         */
        getInt3(src) {
            return new Uint8Array([
                src & 0xff, // 下位 8 ビット (バイト0)
                (src >> 8) & 0xff, // 中位 8 ビット (バイト1)
                (src >> 16) & 0xff, // 上位 8 ビット (バイト2)
            ]);
        },

        /**
         * 符号付き 4 バイト整数 (int32, リトルエンディアン) をバイト列に変換する.
         *
         * 格納できる範囲: -2147483648 ～ 2147483647
         * 例: 0x01020304 → [0x04, 0x03, 0x02, 0x01]
         *
         * @param  {number} src  変換元の整数値
         * @return {Uint8Array}  4 バイトのバイト列
         */
        getInt(src) {
            const buf = new ArrayBuffer(4);
            new DataView(buf).setInt32(0, src, true); // true = リトルエンディアン
            return new Uint8Array(buf);
        },

        /**
         * 単精度浮動小数点数 (float32, IEEE 754, リトルエンディアン) をバイト列に変換する.
         *
         * 埋め込みベクトルの各要素など、float で十分な精度でよい値に使用する.
         *
         * @param  {number} src  変換元の浮動小数点数
         * @return {Uint8Array}  4 バイトのバイト列
         */
        getFloat(src) {
            const buf = new ArrayBuffer(4);
            new DataView(buf).setFloat32(0, src, true);
            return new Uint8Array(buf);
        },

        /**
         * 符号付き 8 バイト整数 (int64, リトルエンディアン) をバイト列に変換する.
         *
         * JavaScript の number は 53 ビット整数までしか正確に扱えないため、
         * 引数は BigInt または number どちらでも受け付けるが、内部で BigInt に変換する.
         * 主に Unix タイムスタンプ (ミリ秒) の保存に使用する.
         *
         * @param  {bigint|number} src  変換元の整数値
         * @return {Uint8Array}         8 バイトのバイト列
         */
        getLong(src) {
            const buf = new ArrayBuffer(8);
            new DataView(buf).setBigInt64(0, BigInt(src), true);
            return new Uint8Array(buf);
        },

        /**
         * 倍精度浮動小数点数 (float64, IEEE 754, リトルエンディアン) をバイト列に変換する.
         *
         * @param  {number} src  変換元の浮動小数点数
         * @return {Uint8Array}  8 バイトのバイト列
         */
        getDouble(src) {
            const buf = new ArrayBuffer(8);
            new DataView(buf).setFloat64(0, src, true);
            return new Uint8Array(buf);
        },

        /**
         * 文字列を UTF-8 バイト列 (Buffer) に変換する.
         *
         * 文字列を保存する際はこのメソッドでバイト列化し、
         * 先頭にそのバイト数を getInt2 / getInt3 で書いてから本体を書く運用にする.
         * (文字列長はバイト数であり、文字数ではない点に注意)
         *
         * @param  {string} src  変換元の文字列
         * @return {Buffer}      UTF-8 エンコードされたバイト列
         */
        getString(src) {
            return Buffer.from(src, "utf8");
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // DecodeBinary
    //   Buffer / Uint8Array / ArrayBuffer を先頭から順番に読み進める
    //   ストリーム型リーダークラス.
    //
    //   内部で「現在読み取り位置 (_pos)」を管理しており、
    //   各 get〇〇() を呼ぶたびに _pos が自動的に進む.
    //   EncodeBinary で書いた順番と同じ順番で読むこと.
    // ═══════════════════════════════════════════════════════════════
    class DecodeBinary {
        /**
         * コンストラクタ.
         *
         * Buffer・Uint8Array・ArrayBuffer のどれでも受け付ける.
         * 内部では DataView を使って任意バイト位置の値を読み取る.
         *
         * @param {Buffer|Uint8Array|ArrayBuffer} binary  読み取り対象のバイナリ
         */
        constructor(binary) {
            if (binary instanceof ArrayBuffer) {
                // ArrayBuffer はそのまま DataView でラップ
                this._view = new DataView(binary);
            } else {
                // Buffer や Uint8Array は .buffer (元の ArrayBuffer) + オフセット + 長さ を指定して
                // DataView を作る (スライス済みの Buffer でも正しく動作させるため)
                this._view = new DataView(
                    binary.buffer,
                    binary.byteOffset,
                    binary.byteLength,
                );
            }
            // 現在の読み取り位置 (バイト単位, 0 始まり)
            this._pos = 0;
        }

        /**
         * 符号付き 1 バイト整数 (int8) を読み取る.
         * 読み取り後、内部ポジションを 1 進める.
         *
         * 戻り値の範囲: -128 ～ 127
         *
         * @return {number}
         */
        getInt1() {
            return this._view.getInt8(this._pos++);
        }

        /**
         * 符号なし 1 バイト整数 (uint8) を読み取る.
         * 読み取り後、内部ポジションを 1 進める.
         *
         * 戻り値の範囲: 0 ～ 255
         *
         * @return {number}
         */
        getUInt1() {
            return this._view.getUint8(this._pos++);
        }

        /**
         * 符号付き 2 バイト整数 (int16, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 2 進める.
         *
         * 戻り値の範囲: -32768 ～ 32767
         *
         * @return {number}
         */
        getInt2() {
            const v = this._view.getInt16(this._pos, true); // true = リトルエンディアン
            this._pos += 2;
            return v;
        }

        /**
         * 符号なし 2 バイト整数 (uint16, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 2 進める.
         *
         * 文書名バイト長など、最大 65535 バイトまでの長さ値を読む際に使用する.
         * 戻り値の範囲: 0 ～ 65535
         *
         * @return {number}
         */
        getUInt2() {
            const v = this._view.getUint16(this._pos, true);
            this._pos += 2;
            return v;
        }

        /**
         * 符号付き 3 バイト整数 (int24, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 3 進める.
         *
         * DataView に 3 バイト専用メソッドがないため、3 バイトを個別に読んで合成し、
         * 最上位ビット (0x800000) が立っていれば符号拡張する.
         *
         * @return {number}
         */
        getInt3() {
            // 3 バイトを個別に読み、ビット OR で合成 (リトルエンディアン)
            const n =
                this._view.getUint8(this._pos) |
                (this._view.getUint8(this._pos + 1) << 8) |
                (this._view.getUint8(this._pos + 2) << 16);
            this._pos += 3;
            // 符号拡張: ビット23 が 1 なら上位バイトを 0xFF で埋めて負値にする
            return (n & 0x800000) !== 0 ? n | 0xff000000 : n;
        }

        /**
         * 符号なし 3 バイト整数 (uint24, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 3 進める.
         *
         * VectorChunk 数やテキストのバイト長など、最大 16MB 程度の長さ値を
         * 読む際に使用する.
         * 戻り値の範囲: 0 ～ 16777215 (0xFFFFFF)
         *
         * @return {number}
         */
        getUInt3() {
            const n =
                this._view.getUint8(this._pos) |
                (this._view.getUint8(this._pos + 1) << 8) |
                (this._view.getUint8(this._pos + 2) << 16);
            this._pos += 3;
            return n & 0xffffff; // 上位ビットをマスクして符号なしにする
        }

        /**
         * 符号付き 4 バイト整数 (int32, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 4 進める.
         *
         * @return {number}
         */
        getInt() {
            const v = this._view.getInt32(this._pos, true);
            this._pos += 4;
            return v;
        }

        /**
         * 単精度浮動小数点数 (float32, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 4 進める.
         *
         * 埋め込みベクトルの各要素を読む際に使用する.
         *
         * @return {number}
         */
        getFloat() {
            const v = this._view.getFloat32(this._pos, true);
            this._pos += 4;
            return v;
        }

        /**
         * 符号付き 8 バイト整数 (int64, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 8 進める.
         *
         * JavaScript の number では 53 ビット以上の整数を正確に扱えないため、
         * 戻り値は BigInt になる.
         * 主に Unix タイムスタンプ (ミリ秒) の読み取りに使用する.
         *
         * @return {bigint}
         */
        getLong() {
            const v = this._view.getBigInt64(this._pos, true);
            this._pos += 8;
            return v;
        }

        /**
         * 倍精度浮動小数点数 (float64, リトルエンディアン) を読み取る.
         * 読み取り後、内部ポジションを 8 進める.
         *
         * @return {number}
         */
        getDouble() {
            const v = this._view.getFloat64(this._pos, true);
            this._pos += 8;
            return v;
        }

        /**
         * 指定バイト数分を UTF-8 文字列として読み取る.
         * 読み取り後、内部ポジションを len 分進める.
         *
         * 文字列の読み取りは「先にバイト数を読む → 次にその長さ分の文字列を読む」
         * という 2 ステップで行うのが基本パターン.
         * 例:
         *   const len = bd.getUInt2();     // 文字列のバイト数を先読み
         *   const str = bd.getString(len); // そのバイト数分を文字列として読む
         *
         * @param  {number} len  読み取るバイト数 (文字数ではなく UTF-8 バイト数)
         * @return {string}      デコードされた文字列
         */
        getString(len) {
            // DataView の背後にある ArrayBuffer の該当範囲を Buffer として取り出す
            const slice = Buffer.from(
                this._view.buffer,
                this._view.byteOffset + this._pos,
                len,
            );
            this._pos += len;
            return slice.toString("utf8");
        }

        /**
         * 現在の読み取り位置 (バイト単位) を返す.
         *
         * デバッグや部分読み取りの確認に使用する.
         *
         * @return {number}
         */
        getPosition() {
            return this._pos;
        }

        /**
         * バイナリ全体の長さ (バイト単位) を返す.
         *
         * @return {number}
         */
        getLength() {
            return this._view.byteLength;
        }

        /**
         * 現在位置から末尾までの残りバイト数を返す.
         *
         * 全データを読み切ったかどうかの確認に使用する.
         * 戻り値が 0 であれば末尾まで読み終えた状態.
         *
         * @return {number}
         */
        getRemaining() {
            return this._view.byteLength - this._pos;
        }
    }

    // ========================================================
    // モジュールエクスポート
    // ========================================================
    // Node.js(CommonJS)環境とブラウザ環境の両方に対応
    if (typeof exports !== "undefined") {
        module.exports = { EncodeBinary, DecodeBinary };
    } else {
        global.BinaryUtil = { EncodeBinary, DecodeBinary };
    }
})(typeof window !== "undefined" ? window : globalThis || this);
