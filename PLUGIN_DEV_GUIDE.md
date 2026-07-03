# CipherTalk 插件开发指南

CipherTalk 插件是纯前端应用（HTML/JS/CSS），运行在独立沙箱 iframe 中，
通过 SDK 调用宿主能力（数据查询、存储、剪贴板等）。任何框架都可以用
（React/Vue/Svelte/原生），构建产物是静态文件即可。

## 1. 五分钟上手

最小插件只要三个文件：

```
my-plugin/
  manifest.json
  index.html
  main.js              # 外部脚本（沙箱 CSP 禁止内联 <script>）
```

再把 [`plugin-sdk/ciphertalk-plugin-sdk.js`](plugin-sdk/ciphertalk-plugin-sdk.js)
复制进目录（TypeScript 项目可同时复制 `.d.ts` 获得完整类型提示）。

**manifest.json：**

```json
{
  "id": "com.example.my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话描述",
  "apiVersion": 1,
  "permissions": ["sessions:read", "messages:read"],
  "contributes": {
    "sidebarMenus": [
      { "id": "main", "label": "我的插件", "icon": "sparkles", "view": "index" }
    ],
    "views": {
      "index": { "entry": "index.html" }
    }
  }
}
```

**main.js：**

```js
import { connect } from './ciphertalk-plugin-sdk.js'

const api = await connect()
const { sessions } = await api.data.sessions.list({ limit: 50 })
document.body.textContent = `共 ${sessions.length} 个会话`
```

**加载调试：** 设置 → 插件 → 打开「插件开发者模式」→「加载本地插件目录」选中
`my-plugin/`，启用后侧边栏就会出现你的菜单入口。

## 2. manifest 字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，小写字母/数字/点/连字符（建议反域名式，如 `com.you.name`） |
| `apiVersion` | 当前为 `1`，宿主不兼容时拒绝加载 |
| `permissions` | 需要的权限，启用时用户确认授予（见 §4） |
| `contributes.sidebarMenus` | 侧边栏菜单入口，点击打开对应 `view`（主区域整页） |
| `contributes.settingsTabs` | 设置页新增 tab，内容为对应 `view` |
| `contributes.chatToolbarButtons` | 聊天界面右上角按钮，点击打开右侧抽屉承载 `view`，`api.context` 里带当前会话（`sessionId` / `sessionName`） |
| `contributes.views` | 视图表：`entry` 为插件目录内的 HTML 相对路径 |
| `devServer` | 开发用，如 `"http://localhost:5173"`，见 §6 |

图标（`icon`）从宿主内置图标集中选择：`bar-chart` `book-open` `calendar` `clock`
`database` `download` `file-text` `globe` `heart` `image` `message-square` `mic`
`puzzle` `search` `smile` `sparkles` `star` `tag` `users` `zap`，缺省为 `puzzle`。

## 3. SDK API（apiVersion 1）

```ts
const api = await connect()

api.pluginId / api.viewId / api.context   // 视图上下文
api.capabilities()                        // 宿主支持的方法列表（探测降级）

// 数据（需对应权限）
api.data.sessions.list({ limit, offset })
api.data.contacts.list({ limit, offset })
api.data.contacts.get(username)
api.data.contacts.getAvatar(username)
api.data.contacts.getGroupMembers(chatroomId)
api.data.messages.query({ sessionId, startTime, endTime, keyword, senderId, limit, cursor })
api.data.messages.get(sessionId, localId)
api.data.messages.getDatesWithMessages(sessionId, year, month)

// UI（无需权限）
api.ui.toast('完成', { type: 'success' })   // 宿主右上角提示
api.ui.navigate('other-view')               // 跳到本插件的其它视图

// 插件私有存储（无需权限；单值 ≤256KB，总量 ≤5MB）
api.storage.get(key) / set(key, value) / delete(key)

// 剪贴板（需 clipboard:write）
api.clipboard.write(text)

// 媒体（需 media:read）——返回的 url 是宿主签发的短时效地址（5 分钟）
api.media.getImage({ sessionId, imageMd5, createTime, thumbnail })  // → { url, isThumb }
api.media.getVoice({ sessionId, localId, createTime })              // → { wavBase64 }
api.media.getEmoji({ sessionId, localId })                          // → { url }
api.media.getVideoInfo(videoMd5)                                    // → { exists, url, coverUrl }

// 语音转写（需 stt:use，复用宿主转写配置与缓存）
api.stt.transcribe({ sessionId, localId, createTime })              // → { text, fromCache }
api.stt.getCachedTranscript(sessionId, createTime)

// 全文搜索（需 search:use）
api.search.query({ sessionId, query, limit })                       // → { hits: [{ message, excerpt, score }] }

// 统计（需 stats:read；扫描上限 5 万条/8 秒，超限 truncated=true）
api.stats.messageCounts({ sessionId, groupBy: 'day' | 'month' | 'sender' })

// 导出（需 export:use；保存位置由用户在系统对话框确认）
api.export.exportSession({ sessionId, format: 'html' })             // → { taskId, outputPath }

// 系统通知（需 notify:send）
api.notify.send(title, body)

// 独立窗口（需 window:create）
api.window.open('some-view', { width: 900, height: 600 })

// 朋友圈（需 sns:read；媒体是微信 CDN 地址，加载图片本体需 network 权限）
api.sns.getTimeline({ limit: 20, keyword: '旅行' })          // → { posts, hasMore }

// AI（需 ai:use；走用户配置的模型与 key，key 对插件不可见；20 次/分钟预算）
api.ai.complete({ prompt: '总结这段话：…', system: '你是摘要助手' })  // → { text }
api.ai.embed(['文本一', '文本二'])                            // → { embeddings }

// 事件订阅
api.events.on('newMessages', ({ sessionId, count }) => {})   // 需 messages:read
api.events.on('exportProgress', (p) => {})                   // 仅发给发起导出的插件
api.events.on('exportDone', (p) => {})
```

**消息分页约定：**`query` 一次最多扫描 `limit`（上限 2000）条，带过滤条件时
返回行数可能少于 `limit`，只要结果里有 `nextCursor` 就应继续翻页：

```js
let cursor
do {
  const { rows, nextCursor } = await api.data.messages.query({ sessionId, keyword: '哈哈', cursor })
  handle(rows)
  cursor = nextCursor
} while (cursor)
```

## 4. 权限

manifest 里声明什么，启用时用户就确认什么；未声明的调用一律被拒。
当前可用权限：`sessions:read`、`contacts:read`、`messages:read`、`clipboard:write`、
`media:read`、`stt:use`、`search:use`、`stats:read`、`export:use`、`notify:send`、
`window:create`、`sns:read`、`ai:use`、`network`。

**网络默认被禁止**：没有 `network` 权限的插件，CSP 在响应头层面阻止一切外联请求
（`fetch`、`<img>` 外链等都发不出去）。声明 `network` 的插件在启用确认时会以
醒目警告展示（"数据可能被发送到外部"）——请只在真正需要时申请，无谓申请
会显著降低用户启用意愿。

## 5. 主题与统一 UI 组件

**不要自己画控件。** 宿主在连接时会向你的页面注入两样东西（SDK 自动应用，零配置）：

1. **主题变量**：全部宿主 CSS tokens，用户切换亮/暗色时实时更新；
2. **统一组件样式库**：一套 `.ct-*` 类，按钮/输入框/下拉框/开关等控件观感与宿主完全一致。

直接写语义化 HTML + `ct-*` 类即可：

```html
<h3 class="ct-title">标题</h3>
<p class="ct-hint">辅助说明文字</p>

<button class="ct-btn">普通按钮</button>
<button class="ct-btn ct-btn-primary">主按钮</button>
<button class="ct-btn ct-btn-ghost">幽灵按钮</button>
<button class="ct-btn ct-btn-danger">危险按钮</button>

<input class="ct-input" placeholder="输入框" />
<textarea class="ct-textarea"></textarea>

<select class="ct-select">
  <option>下拉框（SDK 自动接管：弹出层由宿主用应用内组件渲染，和设置页完全一致）</option>
</select>

<label class="ct-switch"><input type="checkbox" /><span></span> 开关</label>
<label class="ct-checkbox"><input type="checkbox" /> 复选框</label>

<div class="ct-card">卡片容器</div>
<span class="ct-chip">标签</span>
<hr class="ct-divider" />
<pre class="ct-code">代码/日志块</pre>
```

进阶组件（同样零依赖，全部宿主同款观感）：

```html
<!-- 弹窗：原生 dialog，JS 调 showModal()/close() -->
<dialog class="ct-dialog" id="dlg">
  <h4 class="ct-dialog-title">确认操作</h4>
  <p class="ct-hint">说明文字</p>
  <div class="ct-dialog-actions">
    <button class="ct-btn" onclick="dlg.close()">取消</button>
    <button class="ct-btn ct-btn-primary">确定</button>
  </div>
</dialog>

<!-- 下拉菜单：原生 details，无需 JS -->
<details class="ct-menu">
  <summary class="ct-btn">操作</summary>
  <div class="ct-menu-panel">
    <button class="ct-menu-item">菜单项一</button>
    <button class="ct-menu-item">菜单项二</button>
  </div>
</details>

<!-- Tabs：给当前项加 .active -->
<div class="ct-tabs">
  <button class="ct-tab active">全部</button>
  <button class="ct-tab">图片</button>
</div>

<progress class="ct-progress" value="40" max="100"></progress>
<span class="ct-spinner"></span>
<div class="ct-skeleton" style="height:20px;width:60%"></div>
<span class="ct-badge">3</span>
<span class="ct-dot ct-dot-success"></span>

<div class="ct-list">
  <div class="ct-list-item">列表项</div>
  <div class="ct-list-item">列表项</div>
</div>

<div class="ct-empty">暂无数据</div>
```

修饰类：`ct-btn-block`（按钮撑满一行）、`ct-chip-accent`（强调色标签）、
`ct-scroll`（统一滚动条）、`ct-label`（表单字段标签）。
右上角浮动提示不要自己做，用 `api.ui.toast()`——它显示在宿主层面，全局统一。

需要更细定制时才用主题变量（`--bg-primary` `--bg-secondary` `--text-primary`
`--text-secondary` `--border-color` `--accent` 等，HeroUI 全套 tokens 均可用）；
暗色模式下宿主会给 `<html>` 加 `dark` class，可写 `.dark .foo { ... }`。
组件库样式插在 `<head>` 最前，插件自己的样式可覆盖它。

## 6. 开发热更新（devServer）

用 Vite 等工具开发时，在 manifest 加：

```json
{ "devServer": "http://localhost:5173" }
```

开发者模式下宿主会直接从 dev server 加载视图（保存即热更新，不用反复构建）。
该字段仅对「加载本地插件目录」的插件生效，正式安装的插件会忽略。

## 7. 打包与分发（.ctplugin）

把插件目录压缩成 zip（`manifest.json` 在压缩包根部或唯一顶层目录内均可），
后缀改为 `.ctplugin` 即是安装包：

```bash
cd my-plugin && zip -r ../my-plugin-1.0.0.ctplugin . -x '*.map' -x 'node_modules/*'
```

用户在 设置 → 插件 →「安装插件」中选择该文件即可安装（校验 manifest 后解压到
插件目录）。注意：

- 同版本覆盖安装直接生效；**新版声明了新增权限时，插件会被自动禁用**，
  用户重新启用时确认新的权限清单
- manifest 校验不通过（未知权限、路径穿越、apiVersion 不符）会拒绝安装
- 分发渠道推荐 GitHub Release 附件；插件市场与签名校验在规划中

## 8. 安全模型（你需要知道的）

- 插件运行在独立 origin 的沙箱 iframe 中，没有 Node、没有文件系统，
  所有能力都经宿主 RPC 且受权限约束。
- 每个插件有独立的调用配额：50 次/秒、2 路并发、单次 10 秒超时。
  超限调用会收到错误，请合并批量请求而不是循环单条调。
- 解密密钥、账号凭据、AI API key 永远不会暴露给插件。

## 9. 示例

完整可运行示例见 [`examples/plugins/word-stats/`](examples/plugins/word-stats/)：
- `index.html` / `main.js` —— 侧边栏入口：会话选择 → 分页拉取消息 → 词频统计 → 点击复制 + toast
- `panel.html` / `panel.js` —— 聊天工具栏抽屉：读取会话上下文 → 批量转写语音 → 词频统计 → 导出 HTML

把该目录作为本地插件加载即可体验。
