# 山GPS Android アプリ版

`../mountain-gps`（Web版）をそのまま同梱した Android アプリです（[Capacitor](https://capacitorjs.com/)）。
画面や機能は Web版と共通で、アプリ版だけ次の点が違います。

| | Web版 | アプリ版 |
| --- | --- | --- |
| 画面OFF・他アプリ使用中の記録 | 止まる | **続く**（通知欄に「山GPS 記録中」を表示） |
| ルート外れの知らせ | 画面表示中のみ振動 | 裏にあっても**通知＋振動** |
| GPX保存 | ダウンロード | 共有メニュー（Googleドライブ・LINE等に保存） |
| 戻るボタン | — | パネル→編集→ホームへ（記録は止まらない） |

アプリ版でだけ動くコードは `../mountain-gps/native.js` にあります（ブラウザでは何もしません）。

## ビルド

必要なもの：Node.js、JDK 21、Android SDK（platform 36 / build-tools 36）

```sh
cd android-app
npm ci
npm run sync                     # Web版を www/ にコピーして Android プロジェクトへ反映
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## 使っているプラグイン

- `@capacitor-community/background-geolocation` … 裏での位置取得（前景サービス）
- `@capacitor/local-notifications` … ルート外れの通知、通知の許可
- `@capacitor/haptics` … 振動
- `@capacitor/filesystem` / `@capacitor/share` … GPX の保存・共有
- `@capacitor/app` … 戻るボタン

## 署名について

いまはテスト用のデバッグ署名です。仲間に配る前に、正式な署名鍵を作って非公開で保管する必要があります
（同じ鍵で署名しないと上書きアップデートができません）。
