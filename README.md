# 1A 合唱伝言板

クラスで使う実用的な合唱用の伝言サイトです。

## 今の機能

- クラス共通パスワードでログイン
- 文字の伝言を投稿
- 音声ファイルをアップロードして共有
- 音声ファイルは1ファイル10MBまで
- MP3 / WAV / M4A / AAC / OGG / WebM などの音声に対応
- 音声は非公開のSupabase Storageへ保存
- 再生時だけ短時間の署名URLを発行
- 合唱曲名の共有・変更
- 最新の伝言を表示
- 一部の設定・伝言一覧をブラウザ側にキャッシュして無駄な再読み込みを減らす
- 伝言の削除ボタンはサイト画面に表示しない

## 構成

GitHub Pagesの公開元がリポジトリ直下の場合でも、ルートの index.html から現在の public/ の実用サイトへ移動するようにしています。

```text
GitHub Pages
└─ 1A 合唱伝言板
   └─ public/
      └─ Web UI
         └─ Supabase
            ├─ Auth
            ├─ Postgres
            └─ Storage
```

## Supabase

ブラウザにはProject URLとPublishable Keyだけを使用します。
Service Role Key / Secret Keyは公開サイトに置きません。

## GitHub Pages

GitHub Actionsを公開元として利用する構成です。
また、Pagesがリポジトリ直下を公開する設定になっていた場合にも、ルートの index.html が古い説明ページを表示せず、現在のサイトへ移動します。
