# 1A 合唱練習サイト

Cloudflare Workers + D1 + R2 で動く、クラス内向けの合唱練習サイトです。

## できること

- クラス共通パスワードでログイン
- 合唱曲名の変更
- 文字の伝言
- ブラウザから最大60秒の音声伝言を録音
- 音声ファイルをR2へ非公開保存
- 音声のメタデータをD1へ保存
- 伝言の再生・削除
- Workerから静的サイトも配信

音声ファイル本体はR2、曲名・伝言・音声メタデータはD1に保存します。D1に大きな音声バイナリを直接保存する構成にはしていません。

## Cloudflare側の初期設定

このリポジトリはCloudflareのアカウントへ自動接続する秘密情報を持たないため、最初のリソース作成だけ本人のCloudflareアカウントで行います。

### 1. ローカルへ取得

```bash
npm install
npx wrangler login
```

### 2. D1を作成

```bash
npx wrangler d1 create 1a-choir-db
```

表示された `database_id` を `wrangler.jsonc` の
`REPLACE_WITH_D1_DATABASE_ID` に入れます。

### 3. R2を作成

```bash
npx wrangler r2 bucket create 1a-choir-audio
```

### 4. パスワードとセッション秘密鍵を登録

```bash
npx wrangler secret put SITE_PASSWORD
npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` は十分長いランダム文字列にしてください。Node.jsが使えるなら次のように生成できます。

```bash
node -e "console.log(crypto.randomUUID()+crypto.randomUUID()+crypto.randomUUID())"
```

パスワードや秘密鍵をGitHubのソースコードには書かないでください。

### 5. D1のテーブルを作成

```bash
npm run d1:migrate
```

### 6. 動作確認

```bash
npm run dev
```

ローカル開発時は、Cloudflareの本番D1/R2とは分離されたローカル状態を使用します。

### 7. デプロイ

```bash
npm run deploy
```

デプロイ後に表示される `workers.dev` のURLへアクセスします。

## データ構成

### D1

- `settings`: サイト設定・現在の曲名
- `messages`: 文字伝言と音声伝言の一覧・メタデータ

### R2

- `voices/<uuid>.<extension>`: 音声ファイル本体

## セキュリティ

- パスワードはWorker Secretに保存
- ログイン成功後は署名付きHttpOnly Cookieを使用
- 音声取得APIもログイン必須
- R2バケットを公開バケットにする必要はありません
- ソースコードにパスワードを保存しません
- 音声は1ファイル10MBまで
- 録音UIは最大60秒

## 今後追加しやすいもの

- ソプラノ/アルトなどパート別の伝言
- 練習チェックリスト
- 楽譜の画像・PDF
- 重要なお知らせを上に固定
- 伝言の編集
- 管理者だけ削除可能にする権限分離
- 音声の自動文字起こし
- 練習日ごとの記録
