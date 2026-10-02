# 1A 合唱練習サイト

**GitHub Pagesでフロントエンドを公開し、Cloudflare Worker + D1 + R2をバックエンドに使う構成**です。

## いま入っている機能

- GitHub Pages対応の静的Webサイト
- クラス共通パスワードでログイン
- 曲名の変更
- 文字の伝言
- ブラウザから最大60秒の音声伝言を録音
- 音声ファイルをCloudflare R2へ非公開保存
- 音声のメタデータをCloudflare D1へ保存
- 伝言の再生・削除
- GitHub ActionsでPagesへ自動デプロイ
- GitHub PagesとCloudflare Workerが別ドメインでも動く認証
- 音声再生時もBearer認証を付けて取得

## 構成

```
GitHub Pages
  └─ Web UI
       │
       │ HTTPS + Authorization
       ▼
Cloudflare Worker
  ├─ 認証
  ├─ API
  ├─ D1
  │   └─ 曲名・伝言・音声メタデータ
  └─ R2
      └─ 音声ファイル本体
```

音声バイナリをD1へ直接保存せず、R2へ保存します。

## GitHub Pages公開

このリポジトリには `.github/workflows/pages.yml` を入れてあります。

GitHubのリポジトリ設定で **Pages → Source → GitHub Actions** を選択してください。
その後、`main` にpushするとPagesへ自動デプロイされます。

このリポジトリの場合の公開先は通常、

`https://sakai-kon.github.io/1A-test/`

です。

## Cloudflare側

### 1. D1

```bash
npm install
npx wrangler login
npx wrangler d1 create 1a-choir-db
```

返ってきた `database_id` を `wrangler.jsonc` の
`REPLACE_WITH_D1_DATABASE_ID` に設定します。

### 2. R2

```bash
npx wrangler r2 bucket create 1a-choir-audio
```

### 3. Secret

```bash
npx wrangler secret put SITE_PASSWORD
npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` は十分長いランダム文字列にしてください。

パスワードや秘密鍵はGitHubへ書き込まないでください。

### 4. D1 Migration

```bash
npm run d1:migrate
```

### 5. Workerをデプロイ

```bash
npm run deploy
```

### 6. GitHub Pages側へWorker URLを設定

`public/config.js` の

```js
API_BASE: "https://YOUR-WORKER.workers.dev"
```

を、実際のWorker URLへ変更してmainへpushします。

Worker側の `WEB_ORIGIN` はすでに

`https://sakai-kon.github.io`

に設定してあります。

## ローカル確認

```bash
npm run dev
```

ローカルのブラウザから確認する場合は、Cloudflare Worker側のCORS設定にlocalhostも許可するコードを入れています。

## セキュリティ

- パスワードはWorker Secret
- セッションは署名付きトークン
- フロントエンドにはパスワードを保存しない
- トークンはsessionStorageに保存
- 音声取得も認証必須
- R2は公開バケットにしない
- 音声1ファイル10MBまで
- 録音は最大60秒

## 次に追加できる機能

- ソプラノ/アルトなどパート別伝言
- 練習チェックリスト
- 楽譜画像・PDF
- 重要なお知らせ固定
- 管理者だけ削除可能
- 練習日ごとの記録
- 音声の文字起こし
