# REPORT-pdf — PDF / HTML 文本提取模块自测报告

任务：task-1（PDF/HTML 文本提取模块）
产物：
- `dsh-paper-reader/lib/pdf.js` — 纯 ESM、零第三方依赖（仅 `node:zlib`），1832 行
- `dsh-paper-reader/lib/html-text.js` — 纯 ESM，130 行

环境：Windows + Git Bash，Node **v22.19.0**，DSH Host 路由（Lead 端到端验证通过：`POST /dsh-paper-reader/api/pdf`，HTTP 200 / 0.11s）。

---

## 1. 接口

```js
// lib/pdf.js
export async function extractPdfText(bytes: Uint8Array | Buffer)
  : Promise<{ title?: string, paragraphs: string[] }>

// lib/html-text.js
export function extractHtmlText(html: string)
  : { title?: string, paragraphs: string[] }
export default extractHtmlText;
```

- 返回值只有 `title`（检测不到时省略该字段）与 `paragraphs`（已去噪的段落字符串数组）；**不含页码、不含页面分隔、不含结构化章节/表格信息**。
- 失败抛 `Error`，message 带阶段前缀，便于定位：`[pdf:header] / [pdf:xref] / [pdf:parse] / [pdf:object] / [pdf:pages] / [pdf:stream] / [pdf:content] / [pdf:extract]`；HTML 侧为 `[html:input]` / `TypeError`。
- 无空数组静默返回：无文本时抛 `[pdf:extract] no text found ... scanned/image-only PDF ...`。

## 2. 实现结构（pdf.js，parse → pages → content tokens → layout）

| 阶段 | 实现要点 |
|---|---|
| 词法/对象 | 字节级 tokenizer（数字/名字 `#xx`/字面量字符串转义/hex/数组/字典/`n g R` 引用），不依赖第三方 |
| xref | `startxref` → 经典 xref 表 / XRef stream（`/W`、`/Index`、PNG/TIFF predictor）；支持 `/Prev` 增量链、`/XRefStm` 混合引用；**损坏时回退全文件暴力扫描 `N G obj`**；无 Root 时扫描 `/Type /Catalog` |
| 对象 | 惰性 `getObject`（xref 条目失败再按扫描表回退）；ObjStm 对象流（`/N`、`/First`，整表解析并缓存） |
| 流 | FlateDecode（含截断流 Z_SYNC_FLUSH 容错）、ASCIIHex、ASCII85、RunLength、predictor；未知过滤器抛 `[pdf:stream]` |
| 页面树 | `/Pages` 递归遍历 + Resources/MediaBox 继承 + 环检测；页面树损坏时扫描 `/Type /Page` 兜底 |
| 内容流 | 完整操作符支持 `BT/ET/Tf/Td/TD/Tm/T*/Tj/TJ/'/"`、`q/Q/cm`、`Do`（递归 Form XObject，含 Matrix/Resources）、内联图像 `BI…EI` 跳过；文本矩阵 + CTM 计算坐标、字号 |
| 字体 | Type1/TrueType/Type3 简单字体（`/Widths`+`/FirstChar`、`/Encoding`+`/Differences` 字形名→Unicode）；Type0/CID（Identity-H 双字节、`/W`/`/DW`）；几乎完整的 ToUnicode CMap（codespace、**bfchar**、**bfrange** 含双字节/数组目标、UTF-16BE 代理对），内置 WinAnsi/Standard 编码表与约 300 个 TeX/Adobe 字形名（希腊字母、数学符号、连字、引号、重音等） |
| 版式 | 按基线聚类成行（合并同基线段）→ 投影法检测双栏 gutter（2 栏阅读顺序：全宽行分段 + 左栏→右栏）→ 页眉/页脚/页码/arXiv 边章去噪 → 标题（首页最大字号连续行，缺失回退 Info /Title）→ 段落合并（行距 gap、段首缩进、字号/编号标题、项目符号、连字符断词跨行/跨栏/跨页拼接） |
| 容错 | 单页内容解析失败不拖垮全篇；全部失败时在错误信息中带首个错误原因 |

html-text.js：去注释与 `script/style/nav/header/footer/aside/svg/form/iframe/...`；按 `h1-6/p/li/blockquote/dt/dd/figcaption/caption` 分块；命名+数字实体解码（含重音字母/数学符号）；空白压缩；`<2` 字符块过滤；`title` 优先 `<title>`，其次第一个 `<h1>`；HTML 损坏时回退按块级标签/换行切分。

## 3. 自测方式（脚本在系统临时目录，未提交到插件目录）

目录：`%TEMP%\pdf-test`（Git Bash `/tmp/pdf-test`，不进入插件目录），主脚本 `test-final.mjs`，通过绝对路径 `import('file:///…/dsh-paper-reader/lib/pdf.js')` 调用真实模块。

样本（全部真实下载，node fetch/https）：

| # | 样本 | 来源 | 特征 |
|---|---|---|---|
| 1 | Attention Is All You Need | https://arxiv.org/pdf/1706.03762 | 2.2MB，pdfTeX，xref stream + ObjStm + Type1 ToUnicode，单栏 |
| 2 | BERT | https://arxiv.org/pdf/1810.04805 | 775KB，Type0/CIDFontType2 + ToUnicode（Identity-H 双字节） |
| 3 | Deep Residual Learning | https://arxiv.org/pdf/1512.03385 | 819KB，**双栏**，图表/公式多 |
| 4 | AlexNet (NIPS 2012) | https://papers.nips.cc/paper_files/paper/2012/file/c399862d3b9d6b76c8436e924a68c45b-Paper.pdf | **经典 xref（无对象流）**，老式 PDF |
| 5 | VGG | https://arxiv.org/pdf/1409.1556 | 200KB，逐字符定位 + 小型大写标题（压力测试） |
| HTML | https://arxiv.org/abs/1706.03762 | 43KB | 真实 HTML 页面 |

自测脚本核心逻辑（节选）：

```js
const { extractPdfText } = await import(pathToFileURL(LIB_PDF).href);   // 真实模块
const t0 = performance.now();
const { title, paragraphs } = await extractPdfText(fs.readFileSync('attention.pdf'));
const text = paragraphs.join('\n\n');
// 指标：字符数、词数、ASCII 词占比、坏字符数(0xFFFD/控制符/私用区)、空格占比
```

另有边界用例：手工构造最小 PDF（经典 xref）、`startxref` 指向错误偏移的损坏 PDF（验证暴力扫描回退）、带 `/Encrypt` 的 PDF、非 PDF 字节、错误入参类型、无文本内容流（模拟扫描件）。

运行命令：

```bash
cd /tmp/pdf-test
node test-final.mjs            # 输出 results.json（本报告数据来源）
```

## 4. 结果（最终一轮，2026-11-03，Node v22.19.0）

| 样本 | 大小 | 耗时 | 标题 | 段落 | 字符 | 词数 | ASCII 词占比 | 坏字符 | 空格/字符 | 关键词 |
|---|---|---|---|---|---|---|---|---|---|---|
| attention.pdf | 2,215,244 B | 74.7 ms | ✅ Attention Is All You Need | 252 | 38,051 | ~5,750 | 0.814 | 0 | 0.144 | attention/transformer/model/training 4/4 |
| bert.pdf | 775,166 B | 79.0 ms | ✅ BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding | 396 | 63,789 | ~9,880 | 0.817 | 0 | 0.149 | bert/language/model/training 4/4 |
| resnet.pdf | 819,383 B | 52.7 ms | ✅ Deep Residual Learning for Image Recognition | 354 | 58,506 | ~9,100 | 0.749 | 0 | 0.15 | residual/image/network/depth 4/4 |
| alexnet.pdf | 1,418,820 B | 16.0 ms | ✅ ImageNet Classification with Deep Convolutional Neural Networks | 178 | 35,325 | ~5,600 | 0.856 | 0 | 0.153 | imagenet/convolutional/network/gpu 4/4 |
| vgg.pdf | 200,010 B | 65.8 ms | ⚠️ 未识别（正文可见，见限制） | 245 | 53,852 | ~8,200 | 0.762 | 0 | 0.148 | convolutional/network/depth/accuracy 4/4 |
| abs.html | 43,071 B | 1.1 ms | "[1706.03762] Attention Is All You Need"（`<title>` 原文） | 32 | 2,227 | — | — | — | — | 摘要含 transformer/attention ✅ |

补充说明：
- **乱码检查**：5 个 PDF 的 U+FFFD、控制字符、私用区字符计数均为 **0**；无 `&entity;`/标签泄漏（HTML 侧）。
- **空格占比 0.14–0.15**，符合正常英文（说明没有大段词粘连）。
- **耗时**：2.2MB/15 页 Attention **~75 ms**，其余 16–79 ms；HTML ~1 ms（均为同步 CPU 时间，`extractPdfText` 为 async 签名但内部同步执行）。
- Lead 独立集成测试：HTTP 200、0.11 s、247 段 / 37,668 字符，标题正确，Abstract 单独成段，参考文献保留。
- 提取文本人工抽查：Attention/BERT/ResNet/AlexNet 正文语义连贯，标题、Abstract、章节标题、列表项、参考文献均可读；页眉页脚/页码/arXiv 边章已去除。

### 前 500 字样例

Attention（1706.03762）：

```
Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or

scholarly works.

Ashish Vaswani∗ Noam Shazeer∗ Niki Parmar∗ Jakob Uszkoreit∗ Google Brain Google Brain Google Research Google Research avaswani@google.com noam@google.com nikip@google.com usz@google.com

Llion Jones∗ Aidan N. Gomez∗ † Łukasz Kaiser∗ Google Research University of Toronto Google Brain llion@google.com aidan@cs.toronto.edu lu
```

BERT（1810.04805）：

```
Jacob Devlin Ming-Wei Chang Kenton Lee Kristina Toutanova Google AI Language

fjacobdevlin,mingweichang,kentonl,kristoutg@google.com

Abstract

We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. Unlike recent language representation models (Peters et al., 2018a; Radford et al., 2018), BERT is designed to pretrain deep bidirectional representations from unlabeled text by jointly conditioning on both left and righ
```

ResNet（1512.03385，双栏）：

```
Kaiming He Xiangyu Zhang

Shaoqing Ren Jian Sun

Microsoft Research

fkahe, v-xiangz, v-shren, jiansung@microsoft.com

Abstract

Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions with reference to the layer inputs, instead of learning unreferenced functions. We provide comprehensive empirical evid
```

HTML（arXiv abs 页）：首段为导航残留（"Press Enter to search · Advanced search"），随后为分类、Title、Abstract：

```
Press Enter to search · Advanced search

Computer Science > Computation and Language

Title: Attention Is All You Need

Abstract: The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and
```

## 5. 边界与错误路径

| 用例 | 结果 |
|---|---|
| 最小合法 PDF（经典 xref、WinAnsi） | ✅ 提取 `Hello PDF world` 等文本，title 取 24pt 首行 |
| `startxref` 偏移损坏 | ✅ 暴力扫描 obj + `/Type /Catalog` 恢复，正常提取 |
| 带 `/Encrypt` 的 PDF | ✅ `[pdf:parse] encrypted PDF not supported` |
| 非 PDF 字节 | ✅ `[pdf:xref] could not locate the document catalog; ... startxref marker not found` |
| 错误入参（string） | ✅ `TypeError: [pdf:input] expected a Uint8Array or Buffer` |
| 无文本内容（模拟扫描件） | ✅ `[pdf:extract] no text found ... scanned/image-only PDF ...`（真实样例见下） |
| HTML 合成用例 | ✅ `<title>` 优先、命名/数字实体解码、`script/style/nav/header/footer/svg` 移除、`<2` 字符块过滤、`&nbsp;`/`&mdash;`/emoji 正确 |

## 6. 已知限制（按影响排序）

1. **扫描版 / 纯图片 PDF**：无 OCR，直接抛 `no text found ...`；若 PDF 带不可见 OCR 文本层则可正常提取。
2. **加密 PDF**：不支持解密，抛 `encrypted PDF not supported`。
3. **多文本层 / 逐字形定位的 PDF 可能串行**：如 VGG（arXiv:1409.1556，正文逐字符定位且存在重叠文本层）会出现同一行内两组文字交错（`convolutional(lcaoynevr.s)`），且小型大写标题导致 title 检测失败。普通 pdfTeX 输出（Attention/BERT/ResNet/AlexNet）不受影响。
4. **字体映射缺失**：无 ToUnicode 且 `/Encoding` 也缺失的 Type0/CID（部分中日韩、符号字体）会丢字；未收录的自定义字形名被跳过（不产生乱码，只缺字符）。字体表已覆盖拉丁/希腊/常用数学/连字。
5. **连字符断词**：行尾连字符一律视为断词并删除（`pre-training` 可能变 `pretraining`）；这对检索/阅读影响很小，但会影响精确原文。
6. **段落启发式**：LaTeX 常无段间距，主要靠段首缩进/行距/字号；标题识别依赖字号放大、编号或已知词（Abstract/References/…），粗体同字号且无编号的小标题可能与正文合并。公式、图表坐标轴文字会以短行/碎片段落出现（ResNet/VGG 可见），不属于乱码但会混入 paragraphs。
7. **双栏阅读顺序**：投影法 gutter + 全宽行分带，适用于常规论文两栏；三栏以上、跨栏浮动体、复杂杂志版式可能顺序错乱。
8. **表格/多栏文本**：表格单元格按行拼接为纯文本，无表格结构；图内文字会保留。
9. **旋转/竖排文字**：忽略页面 `/Rotate` 与旋转文本，边角旋转图章会被当成噪声（另有宽度≈0 的边章过滤）。
10. **页眉页脚**：仅移除跨页重复的顶部/底部行、纯页码行、arXiv 边章；单页出现一次的页眉会保留。
11. **无结构信息**：不返回 section/表格/图片/页码/引用结构，只返回 `{ title?, paragraphs }`；标题也会从 paragraphs 中剔除（避免重复）。
12. **同步阻塞**：`extractPdfText` 签名 async，内部同步 CPU 计算（2MB 论文 ~75ms），大 PDF（>50MB）会短暂阻塞 Host 事件循环；如有需要可在 Host 侧用 worker/子进程包裹。

## 7. Lead 集成注意点

- Host 侧调用：`const { extractPdfText } = await import('.../lib/pdf.js')`；入参传 `Buffer` 即可（`Uint8Array` 亦可）。用 `try/catch` 包住，错误 message 已含阶段前缀，可直接回显或记录日志。
- 返回值**不保证有 `title`**（VGG 这类小写标题 PDF 会缺失）；`paragraphs` 已按阅读顺序排列、已去页码/重复页眉，**不含标题**，可直接做全文/分段展示。
- HTML：`extractHtmlText(htmlString)` 是同步函数（非 async）；arXiv abs 页的 `<title>` 带 `[1706.03762] ` 前缀，若需要干净标题可在 Host 侧再裁一次。
- 两个模块均为纯 ESM、仅 `node:zlib`，无第三方依赖、无 `@deepseek-ai/*` import；若包 `package.json` 未声明 `"type": "module"`，Node 22 会按语法自动识别 ESM（会有 MODULE_TYPELESS_PACKAGE_JSON 警告，建议插件包声明 `"type": "module"`）。
- 不要期待表格/公式结构；如需结构化展示，建议只在 paragraphs 基础上做章节标题二次识别。
