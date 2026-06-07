# FourMeme BSC Ticker Database

FourMeme BSC 历史 ticker 数据库及自动更新服务。

## 公开内容

- `data/fourmeme-tickers.json`：去重后的历史 ticker 数据库。
- `tools/update-fourmeme-tickers-rpc.mjs`：从公共 BSC RPC 增量同步。
- `tools/build-remote-database-release.mjs`：生成远程数据库及 SHA-256 清单。
- `.github/workflows/update-fourmeme-database.yml`：每日自动同步和 Pages 发布。

Chrome 插件源码不保存在本公开仓库。

## 在线数据

- 更新清单：
  `https://tt-gulu.github.io/fourmeme-ticker-database/fourmeme-update.json`
- 数据库：
  `https://tt-gulu.github.io/fourmeme-ticker-database/fourmeme-tickers.json`

GitHub Actions 每天北京时间约 08:30 自动增量更新，也支持手动运行。

## 数据安全

远程清单包含数据库的 SHA-256、同步区块高度和 ticker 数量。客户端只有在
HTTPS 同源、哈希、数量及区块高度校验通过后才应接受新数据库。
