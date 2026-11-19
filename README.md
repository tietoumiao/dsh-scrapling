# dsh-scrapling

把 [Scrapling](https://github.com/D4Vinci/Scrapling) 的抓取能力接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的插件：四个面向模型的工具，一个 Python 桥接进程。

| 工具 | 用途 |
|---|---|
| `scrape_fetch` | 一个 URL → markdown / 纯文本 / 原始 HTML，附状态码、跳转后 URL、标题、字符数、截断标记；支持 GET / POST |
| `scrape_extract` | 一个 URL → 具名字段（CSS/XPath + 属性 + 正则），或 `rows` 行提取（列表/表格 → 一组对象） |
| `scrape_batch` | 最多 50 个 URL 并发抓取，单 URL 失败不影响整体，可选对每个 URL 做提取 |
| `scrape_site` | ContentSpider 爬站，一页一条 markdown，受 `max_pages` 与总字符预算约束 |

两档引擎：

- `http`（默认）— 伪装 HTTP 客户端（curl_cffi 指纹），不启浏览器，约 2~3.5 秒
- `stealth` — 真浏览器（StealthyFetcher），能跑 JS、带反检测、可过 Cloudflare Turnstile，冷启动约 5~10 秒

## 能力对照

| Scrapling 能力 | 本插件暴露方式 |
|---|---|
| `Fetcher` / `StealthyFetcher` | `mode: http \| stealth` |
| GET / POST | `method` / `body` / `json_body`（仅 http 模式） |
| `GetRequestParams` 旋钮 | `options`：impersonate / http3 / retries / verify / cert / auth / params / proxies … |
| `StealthSession` 旋钮 | `options`：solve_cloudflare / real_chrome / locale / useragent / user_data_dir / blocked_domains / hide_canvas / block_webrtc / dns_over_https … |
| cookies 会话 | `session: "name"` → `<root>/.sessions/<name>.json`，跨重定向跳转的 Set-Cookie 也会收 |
| CSS / XPath / `::text` | `selectors` |
| 属性 / 正则提取 | 字段级 `{attribute}` / `{regex}` |
| adaptive 选择器 | `adaptive: true` |
| 并发多 URL | `scrape_batch` + `concurrency` |
| 爬虫框架 | `scrape_site` |

**故意不接的**：`page_action`、`page_setup`（Python 可调用对象）、`proxy_rotator`（活对象）、`selector_config`、`additional_args`——这些过不了 JSON 边界。传了会明确报 `unsupported ... option(s)` 并列出支持项，不会静默忽略。

## 设计

```
lib/index.js          cordis 插件：注册 4 个工具，spawn 桥接进程，超时/取消杀进程树
bridge/scrape.py      stdin 一个 JSON → stdout 一个 JSON；ops: fetch / extract / batch / site
cordis.patch.yml      一行 insert，config 里是 python / root / 超时 / 截断上限
test/smoke.mjs        离线冒烟：伪造 ctx 挂载插件，真跑 4 个工具
test/schema-audit.mjs 轻量 schema 审计
```

几个刻意的选择：

- **不 import 任何 `@deepseek-ai/*`**：`ctx.tools.register()` 接受纯对象定义，没有 peer 依赖就没有版本硬拦；代价是参数校验自己写。
- **一次调用一个 Python 进程**：插件侧零状态；代价是解释器启动约 1 秒、stealth 每次冷启浏览器。跨调用要保留的东西只有 cookie，所以会话落成磁盘 jar。
- **输出 schema 必须是单类型**：宿主只接受 `type: "string"` 这种单类型，没有 nullable；所有空值用「省略整个键」表达。
- **TEMP 重定向**：在 Windows 上 `%LOCALAPPDATA%\Temp` 对 node 派生的子进程可能 EPERM，所以 `TEMP/TMP/TMPDIR` 指向 `<root>/.tmp`、`PLAYWRIGHT_BROWSERS_PATH` 指向 `<root>/browsers`、cookie jar 写 `<root>/.sessions`。

## 用法

```js
// 抓一页正文
await scrape_fetch({ url: "https://example.com", format: "markdown" })

// 列表 → 一组对象
await scrape_extract({
  url: "https://news.ycombinator.com",
  rows: { container: ".athing", limit: 30, fields: {
    title: { selector: ".titleline a" },
    href:  { selector: ".titleline a", attribute: "href" },
    rank:  { selector: ".rank", regex: "(\\d+)" }
  }}
})

// 过 Cloudflare
await scrape_fetch({ url: "...", mode: "stealth", options: { solve_cloudflare: true } })
```

## 安装

需要 DSH 宿主（cordis 插件机制）、Python 3.10+ 与已安装 Scrapling：

```bash
pip install "scrapling[fetchers]"
```

把本仓库放进 DSH 可加载的插件目录，并在 profile 的 `dsh.profile.bundles` 里登记插件 id。配置示例：

```yaml
- insert:
    - id: dsh-scrapling
      name: dsh-scrapling
      config:
        python: '/path/to/python'          # 已装 scrapling 的解释器
        root: '/path/to/scrapling-root'    # 存放 .sessions / .tmp / browsers
        callTimeoutMs: 120000
        maxChars: 20000
```

## 自检

```bash
node test/schema-audit.mjs
node test/smoke.mjs
node test/smoke.mjs --stealth
```

## 已知限制

- 每字段默认最多 20 个匹配、行提取默认 20 行；上限 200 / 500。
- `scrape_batch` 最多 50 个 URL；stealth 模式并发强制为 1。
- `scrape_site` 没有「深度」参数，靠 `max_pages` + `allowed_domains` + 字符预算控制。
- 不做 `find_by_text` / `find_similar` / `Response.save()` / `follow()`。
- **不内置验证码求解**：只通过 Scrapling 的 `solve_cloudflare` 处理 Cloudflare Turnstile；Yandex SmartCaptcha 这类交互式验证码不处理。

## 许可证与致谢

本插件以 MIT 许可发布，见 [LICENSE](LICENSE)。

它依赖 [Scrapling](https://github.com/D4Vinci/Scrapling)（BSD 3-Clause，Copyright © 2024 Karim Shoair）。本仓库不包含 Scrapling 源码，仅通过子进程调用；安装 Scrapling 与分发时应保留其版权与许可声明，详见 [NOTICE](NOTICE)。
