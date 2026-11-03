# PaperPilot · 论文领读

> 一个 DeepSeek Harness 插件：把左侧栏的一个入口变成全屏沉浸式论文阅读器 —— 逐段翻译、划词追问、页面内悬浮对话。对话是浮在论文上的卡片，不占分屏、不挤压正文。

## 特性

- **沉浸阅读**：主面板整页阅读，衬线正文、可调字号（15–28px）与版心（紧凑/标准/宽松），阅读进度条，深色/浅色主题跟随宿主。
- **三种导入方式**
  - 粘贴文本（空行分段，自动识别标题行）
  - 打开本地文件：PDF / TXT / Markdown / LaTeX（PDF 文本在 Host 端本机提取）
  - 从链接导入：arXiv（自动优先抓取 `/html/` 全文版，失败回退摘要页）、OpenReview、ACL Anthology、期刊页、PDF 直链
- **逐段翻译**：段落右侧「译」按钮；「双语」开关对进入视野的段落自动翻译；「全文翻译」一次翻完整篇（4 路并发，边翻边显示）。译文内联在原文下方，保留术语与公式编号。
- **划词工具条**：选中文字后浮出「翻译 / 解释 / 追问」。
- **悬浮对话**：右下角气泡展开为可拖动的卡片，多轮上下文、流式回答，回答基于与问题最相关的论文片段检索；不进入会话日志，不污染当前 Session。
- **持久化**：论文、译文、对话、阅读偏好存在 localStorage，关掉面板再回来还在。

## 安装

这是一个 DSH bundle（`package.json` 里声明了 `dsh.bundle.patch` 与 `dsh.client`）。

```bash
git clone <repo-url> paperpilot
```

然后在 DSH 会话里让 agent 安装这个本地 bundle（等价于 `plugin_manager` 的 `install_bundle`，`target` 为克隆后的绝对目录路径）：

```
安装 /absolute/path/to/paperpilot 这个本地插件
```

安装后它会以 `@local/paperpilot` 出现在「设置 → 插件」里。**重启一次 DSH Desktop** 让 Host 侧代码加载，再刷新页面。

## 使用

1. 左侧栏点击「论文领读」图标（书本 + 对话气泡）。
2. 空状态里选一种导入方式，或把论文链接/文本贴进来。
3. 阅读中：选中文字 → 翻译 / 解释 / 追问；右下角气泡 → 和论文对话。
4. 顶部工具栏调字号、「双语」开关、「全文翻译」；「⋯」菜单里换版心或清除当前论文。

## 结构

```
paperpilot/
├─ package.json          # DSH bundle 清单（dsh.bundle.patch + dsh.client）
├─ cordis.patch.yml      # 插入 paperpilot 插件行
├─ index.js              # Host 半边：同源 HTTP API（翻译 / 对话 / 抓取 / PDF）
├─ client.js             # 浏览器半边：侧栏图标 + 主面板阅读器 + 悬浮对话
├─ lib/pdf.js            # 纯 Node PDF 文本提取（FlateDecode / ObjStm / ToUnicode）
├─ lib/html-text.js      # HTML 正文提取
├─ locale/en.json        # 插件显示名（英文）
├─ locale/zh.json        # 插件显示名（中文）
└─ icon.svg              # 插件图标
```

## 接口（Host，同源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/paperpilot/api/status` | 探测默认模型与能力 |
| POST | `/paperpilot/api/chat` | SSE 流式问答：`{question, history, paper}` |
| POST | `/paperpilot/api/translate` | SSE 流式翻译：`{items:[...], target:'zh'\|'en'}` |
| POST | `/paperpilot/api/fetch-url` | 抓取论文：`{url}` → `{title, paragraphs, kind, weak}` |
| POST | `/paperpilot/api/pdf` | 原始 PDF 字节 → `{title, paragraphs}` |

模型来自宿主的默认模型设置（`agentDefaultModel.currentSelection()`），通过 `ctx.llm.stream()` 直连调用，不写入任何会话；页面由 `sidebar.panellist` + `main` 两个 slot 承载。

## 已知限制

- 扫描版（图片型）PDF 没有 OCR，会明确报错；加密 PDF 不支持。
- PDF 解析实测（Node 22）：Attention 84ms/252 段、BERT 86ms/396 段、双栏 ResNet 也正常，坏字符 0。但仍有边界情况：VGG 一类「逐字形定位 + 重叠文本层」的老 PDF 会行内串字；三栏或复杂版式阅读顺序可能错乱；公式与图表坐标轴文字会以碎片段落出现；行尾连字符断词会去掉连字符（pre-training → pretraining）；不返回章节/表格结构。
- arXiv `/abs/` 摘要页正文很少，导入时会自动尝试 `/html/` 全文，仍不足时给出提示。
- 翻译与对话依赖宿主已配置默认模型（「设置 → 模型」里选）。
- 翻译按段调用模型：单段约数秒，全文翻译 4 路并发，百段级论文约 2–3 分钟。

## 开发

`.dev/REPORT-pdf.md` 是 PDF/HTML 提取模块的自测报告（样本、耗时、限制），不属于运行时文件。

## License

MIT
