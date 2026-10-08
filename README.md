# 1A 合唱伝言板

クラスで使う実用的な合唱用の伝言サイトです。

## できること

### みんな（クラス共通パスワードでログイン）

- 文字のコメントを投稿する（名前は任意。端末に覚えておくこともできます）
- 共有された曲をその場で再生する（音量・シーク・一時停止つき）
- 曲名・サイト名の表示
- ほかの人の投稿がリアルタイムに反映される（再読み込み不要）
- 通信が一時的に切れても、前回読み込んだ内容を表示し続ける

### 管理者

- 曲ファイルのアップロード（ドラッグ&ドロップ対応、アップロード前に試聴できます）
- 曲は1ファイル10MBまで／60秒より長いもの
- MP3 / WAV / M4A / AAC / OGG / WebM などの音声に対応
- サイト名・現在の曲名の変更
- コメントと曲の削除（「設定」タブの「投稿の管理」から行います）

音声は非公開のSupabase Storageへ保存し、再生するときだけ短時間の署名URLを発行します。

## 画面構成

| タブ | 内容 |
| --- | --- |
| コメント | 投稿フォームとコメント一覧 |
| 曲 | 曲の追加（管理者のみ）と曲一覧 |
| 設定 | サイト設定と投稿の管理（管理者のみ表示） |

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

## セットアップ

1. Supabaseプロジェクトを作り、`supabase/schema.sql` をSQL Editorで実行します。
2. Authentication > Users で、クラス共通ログイン用のユーザーを1つ作成します。
3. 管理者にしたいユーザーのUUIDを `insert into public.admins(user_id) values ('...');` で登録します。
4. `public/config.js` を自分のプロジェクトの値に書き換えます。
   - `SUPABASE_URL` … Project URL
   - `SUPABASE_PUBLISHABLE_KEY` … Publishable / anon Key
   - `AUTH_EMAIL` … 2.で作ったユーザーのメールアドレス
5. GitHub Pagesの公開元をGitHub Actionsにします（`.github/workflows/pages.yml` が `public/` を公開します）。

`public/config.js` が未設定（空、または `example.com` のまま）のときは、サイトはログインを止め、どの項目を設定すればよいかを画面に表示します。

## Supabase

ブラウザにはProject URLとPublishable Keyだけを使用します。
Service Role Key / Secret Keyは公開サイトに置きません。

リアルタイム更新を使うため、`supabase_realtime` パブリケーションに `messages` / `settings` / `admins` を追加します（schema.sqlに含まれています）。

## テスト

`public/app.js` の挙動（ログイン、タブ切り替え、投稿、曲の追加、削除、通信断、リアルタイム更新など）を jsdom で確認するテストがあります。

```bash
npm install
npm test
```

GitHub Actionsでも、pushのたびに同じテストを実行します。

## GitHub Pages

GitHub Actionsを公開元として利用する構成です。
また、Pagesがリポジトリ直下を公開する設定になっていた場合にも、ルートの index.html が古い説明ページを表示せず、現在のサイトへ移動します。
