# 1A 合唱練習サイト

GitHub Pages + Supabaseで動く合唱練習サイトです。

## 構成

```
GitHub Pages
  └─ Web UI
       │
       ▼
Supabase
  ├─ Auth
  │   └─ クラス用ログイン
  ├─ Postgres
  │   ├─ 曲名
  │   ├─ 文字の伝言
  │   └─ 音声メタデータ
  └─ Storage
      └─ 非公開の音声ファイル
```

## 機能

- GitHub Pagesで公開
- Supabase Authによるパスワードログイン
- 曲名の共有
- 文字の伝言
- ブラウザ録音
- 最大60秒・1ファイル10MBの音声伝言
- 音声は非公開Storageへ保存
- 音声再生時は短時間の署名URLを使用
- 伝言・音声の削除
- RLSによる認証済みユーザー限定アクセス

10MBの音声アップロードはSupabase StorageのResumable Upload（TUS）を使います。Supabase公式も6MBを超えるファイルではResumable Uploadを推奨しています。

## Supabaseセットアップ

### 1. Supabaseプロジェクトを作る

Supabaseで新しいプロジェクトを作成します。

### 2. Auth用アカウントを作る

このサイトではクラスで1つのAuthアカウントを共有する方式にしています。

例:

- Email: 自分で決めたクラス用メールアドレス
- Password: クラスで決めたパスワード

このメールアドレスはサイトの画面には表示しません。

### 3. SQLを実行

Supabase DashboardのSQL Editorで、

`supabase/schema.sql`

の内容をそのまま実行してください。

これで以下が作られます。

- `settings`
- `messages`
- `choir-audio` private bucket
- 必要なRLSポリシー

### 4. public/config.jsを設定

Supabase DashboardのProject Settings → APIから、

- Project URL
- Publishable Key

を取得して設定します。

```js
window.CHOIR_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR-PUBLISHABLE-KEY",
  AUTH_EMAIL: "YOUR-CLASS-LOGIN-EMAIL"
};
```

**secret key / service role keyは絶対にGitHub Pagesへ置かないでください。**

### 5. GitHub Pages

GitHubのSettings → PagesでSourceをGitHub Actionsにします。

mainへpushすると、

`https://sakai-kon.github.io/1A-test/`

で公開されます。

## 音声について

サイト自身が録音した音声だけを保存する設計です。

10MBを超えた音声はアップロードできません。

合唱曲そのものの音源ファイルを無断でアップロードするための機能にはしていません。

## セキュリティ

- Supabase Authでログイン
- Postgres RLSを有効化
- Storage bucketはprivate
- 音声ファイルへのアクセスは認証済みユーザーのみ
- 再生用URLは5分の署名URL
- Publishable Keyのみブラウザへ公開
- Supabase secret keyはブラウザへ公開しない
