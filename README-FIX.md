# edgeone-pyoxy 404 修复说明

## 一、问题定位

排查了仓库源码、腾讯云官方 [TencentEdgeOne/pages-templates](https://github.com/TencentEdgeOne/pages-templates) 的 Functions 约定，以及同类的 [6Kmfi6HP/edgeone-proxy](https://github.com/6Kmfi6HP/edgeone-proxy)（本仓库的原始来源）。`functions/proxy.js` 的 `export onRequest` 写法和 `functions/` 文件路由约定本身都符合官方规范，**404 一般出在「部署配置」和「上游代理服务已失效」两处**：

### 原因 1：上游代理服务已死（功能性 bug）

旧版 `functions/proxy.js` 把所有请求转发给 `https://cors-anywhere.herokuapp.com/`。该公共服务早已名存实亡：

- Heroku 免费层 2022 年底关停，演示实例常年限流；
- 现在必须先手动访问 `/corsdemo` 申请临时访问权限，否则一律拒绝；
- 代码注释里写的 "CRITICAL FIX: Use a professional proxy service" 实际上把问题转移给了一个不可靠的第三方。

结果：即使部署成功，`/proxy?url=...` 也会返回 403/429/502 等错误，代理功能完全不可用。

**修复**：重写 `functions/proxy.js`，在边缘函数内直接转发请求——透传原始方法、请求头和请求体，清洗逐跳头与平台注入头，删除响应中的 `Set-Cookie`、`CSP`、`X-Frame-Options` 等会干扰浏览器渲染的头，并补齐 CORS 支持（可当 API 代理用）。

### 原因 2：部署配置不匹配（最常见 404 来源）

EdgeOne Pages 对「静态目录 + 函数」项目的路由规则是：

- 静态资源按 **输出目录** 提供；
- `functions/` 目录按文件路径映射路由（`functions/proxy.js` → `/proxy`），**函数目录固定在仓库根目录**，不受输出目录影响。

因此最容易踩的坑是：

| 错误配置 | 现象 |
| --- | --- |
| 输出目录留空 / 误填 `dist`、`./` | 首页 `/` 直接 404 |
| 构建预设选了 Vue/React 等，但仓库没有 `package.json` | 构建失败，整站 404 |
| 根目录误填为 `static` | 平台去 `static/functions` 找函数，`/proxy` 404 |

**修复**（容错加固）：

- 新增 `package.json`（无依赖、空构建脚本），即使预设选错也能通过构建；
- 新增仓库根目录 `index.html` 兜底跳转页：万一输出目录被误配成 `./`，访问 `/` 会自动跳到 `static/index.html`，首页不再 404。

## 二、修复后的文件结构

```
.
├── functions/
│   └── proxy.js      # 重写：直接转发，不再依赖 cors-anywhere
├── static/
│   └── index.html    # 静态首页（未改动）
├── index.html        # 新增：输出目录误配时的兜底跳转
├── package.json      # 新增：空构建脚本，兼容任意框架预设
├── LICENSE
└── README-FIX.md     # 本文件
```

## 三、部署配置清单（EdgeOne 控制台，务必逐项核对）

1. **部署方式**：关联 Git 仓库，选择你 Fork 后的仓库，生产分支 `main`。
2. **构建框架预设**：**其他**（Other）。
3. **构建命令**：**留空**（填了 `package.json` 后，填 `npm run build` 也可以）。
4. **根目录**：保持默认 `./`（不要填 `static`，否则函数找不到）。
5. **输出目录**：**`static`**（最关键的一项，首页能不能打开就看它）。
6. 保存并部署，等待构建完成，用平台分配的 `*.edgeonepage.com` 域名访问。

> 若使用「手动上传」方式部署，必须上传包含 `functions/` 和 `static/` 的完整目录结构，只传 `static/` 会导致 `/proxy` 404。

## 四、部署后验证

```text
1. 打开 https://<你的域名>/              → 应显示「代理万物」首页
2. 打开 https://<你的域名>/proxy?url=https://www.example.com
                                          → 应返回 example.com 的页面内容
3. 首页输入框填 https://www.example.com 点「开始代理」 → 新窗口返回目标页
```

如果 `/` 正常但 `/proxy` 仍 404：说明函数没被部署，重点检查「根目录」是否被改成了非 `./` 的值，以及是否用的手动上传只传了 `static/`。
如果两个都 404：说明输出目录/构建配置不对，按上面清单第 2–5 项重新核对后重新部署。
