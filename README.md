# 月度记账

一个纯前端、零依赖的 PWA 记账工具。轻量月度流水记账与分类统计，**数据只保存在你自己的设备上，不上传任何服务器**。

## 直接使用

👉 **<https://sumikuuu.github.io/expense-tracker/>**

打开就能用，不需要安装任何东西。手机上建议用浏览器的「添加到主屏」，这样会变成一个独立图标、可以离线使用的 App（iOS 上还能避免长期不打开被系统清理掉本地数据）。

## 功能

- **记账**：支出 / 收入，9 个支出分类 + 4 个收入分类，5 个支付渠道，备注与日期
- **统计**：本月收支结余、支出分类占比环形图、各渠道支出、近 6 个月支出趋势柱状图
- **预算**：每月总预算 + 分类预算，超支高亮提示
- **导入**：微信 / 支付宝账单（CSV、XLSX），自动识别 GBK / UTF-8 编码，导入前预览确认，自动去重
- **备份**：全部账目导出为 JSON，可在另一台设备导入合并
- **离线**：Service Worker 缓存，可安装到主屏（iOS / Android / 桌面）

## 本地开发

**只在修改代码时才需要。** 项目没有构建步骤，起一个静态服务器即可：

```bash
npx serve .        # 或者 python -m http.server 8080
```

然后打开 <http://localhost:8080>。

不要直接双击 `index.html` 用 `file://` 打开——Service Worker 只在 `https://` 或 `localhost` 下生效，`file://` 下注册会静默失败（没有离线缓存、无法安装）。

## 部署

已启用 **GitHub Pages**（`main` 分支根目录），所以：**推送到 `main` 就会自动重新部署**，等一两分钟刷新即可。不需要任何额外操作。

Pages 自带 HTTPS，PWA 的离线与安装能力依赖这一点。

## 数据说明

- 数据保存在浏览器的 `localStorage`，键名：`expense-tracker-v1`（账目）、`expense-budget-v1`（预算）
- **`localStorage` 按域名隔离**：不同设备、不同网址（`localhost` 与线上域名也算不同）之间数据不互通。换设备请用「💾 → 导出备份 / 导入」
- 清除浏览器数据会清空账目，建议定期导出备份
- iOS 上若未「添加到主屏」，长期不访问可能被系统清理存储，建议添加到主屏使用

## 目录结构

```
index.html          页面结构（只有标记，样式与逻辑都在外部文件）
styles.css          全部样式（:root 变量 + 分区 + 桌面端适配）
app.js              应用主逻辑：状态、渲染、存储、事件（依赖 parser.js）
parser.js           纯函数模块：账单解析、分类推断、记录规范化（无 DOM 依赖，可单测）
manifest.json       PWA 清单
service-worker.js   离线缓存（网络优先，缓存回退）
icons/              PWA 图标（192 / 512，含 maskable）
screenshots/        安装横幅截图（manifest 引用，用于 Android / 桌面的安装提示）
vendor/pako.min.js  pako 2.1.0（MIT AND Zlib），仅用于解压 xlsx
test/parser.test.js parser.js 的回归测试（零依赖）
```

## 运行测试

`parser.js` 里的解析与分类逻辑是纯函数，不需要浏览器就能测试：

```bash
npm test          # 等价于 node test/parser.test.js
```

只用 Node 内置的 `assert`，不需要安装任何依赖。新增用例时，照着 `test/parser.test.js` 里任意一个 `test(...)` 复制修改即可；断言失败脚本会以非 0 退出码结束，方便以后接 CI。

## 技术说明

- 无构建步骤、无框架、无依赖；`vendor/pako.min.js` 是唯一的第三方文件
- 金额统一以「分」的整数存储，避免浮点误差
- 浏览器要求：Chrome / Edge 87+、Safari 14.1+（用到 CSS `inset`、`aspect-ratio`、`env()` 等特性）
- 数据模型没有后端，所有解析（CSV / XLSX / GBK 解码）都在浏览器内完成

## 许可证

[MIT](./LICENSE)
