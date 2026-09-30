# GCal Panel Resizer

Google カレンダーの右サイドパネル（ToDo リスト、Keep、Maps など）の幅を、左端のドラッグで変更する Chrome 拡張機能です。変更した幅は保存され、再読み込みやパネルを開き直したときに復元されます。

## できること

- パネル左端をドラッグして横幅を変更する
- 幅を `chrome.storage.local` に保存し、次回以降に自動で戻す
- パネルの開閉や、ToDo / Keep などの切り替え後も動作する

幅の範囲は次のとおりです。

- 最小: 320px
- 最大: 760px、かつウィンドウ幅の 55% まで

## インストール

1. このリポジトリを手元に置く
2. Chrome で `chrome://extensions` を開く
3. デベロッパーモードをオンにする
4. 「パッケージ化されていない拡張機能を読み込む」からこのフォルダを選ぶ
5. [Google カレンダー](https://calendar.google.com/calendar/) を開き直す

## 使い方

1. カレンダー右端のアイコンから ToDo リストや Keep などを開く
2. パネル左端の境界にカーソルを合わせる（`ew-resize` になる）
3. ドラッグして幅を変える

離した時点の幅が保存されます。

対象ページは `https://calendar.google.com/calendar/*` です。

## ライセンス

[MIT License](LICENSE)
