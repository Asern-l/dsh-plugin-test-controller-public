# Changelog

## 1.11.2 — 2026-11-02

- npm 包冻结在 1.6.0，文档不再引导按包名安装：安装章节改为从仓库 clone，并去掉 npm 徽章。
- 说明「兼容基线」指本插件适配的 DSH 版本（`0.2.1-rc.5`），不是本插件发布到 npm。

## 1.11.1 — 2026-11-02

- 修正文档与界面里的过期说法：工具数量改为 7（含 `plugin_test_open` / `plugin_test_destroy`），计划已可在面板新建与删除。
- 更新面板截图（v1.11 界面、新建计划按钮、运行删除）。
- 测试断言可在 Windows/macOS/Linux 一致通过：路径比较走 `realpath` 规范化（兼容 runner 的 8.3 短路径），绝对路径样本改用 `path.resolve`。

## 1.11.0 — 2026-10-31

- 面板内新建计划：粘贴 JSON，用与 CLI 相同的校验后写入 `plans/<name>.json`（相对模块路径按状态根解析）。
- 计划与已结束运行支持删除（运行删除会一并移除证据目录；运行中必须先取消/销毁）。
- 面板页面支持滚动，长列表与展开详情不再被截断。
- 共享配置模块 `src/settings.mjs`：面板改状态根后，工具、面板、CLI 立即指向同一目录；新增 `GET/POST/DELETE /plugin-test/config`。

## 1.9.0 — 2026-10-31

- 面板信息更全：顶部概览（计划/运行/进行中/镜像 + 状态根）、运行筛选框。
- 运行详情：状态与耗时、错误与清理错误、检查项与逐条断言、安装信息（是否来自镜像、包版本、镜像 key）、环境（DSH/Node/平台）、证据文件清单与大小、install/stderr/stdout 日志尾部。
- 新增只读接口 `GET /plugin-test/run?id=`、`GET /plugin-test/images`。
- 安装镜像区块：列出已缓存的镜像（key、DSH 版本、包数量、构建时间）。

## 1.8.0 — 2026-10-31

- 安装镜像：首次安装后把 profile 存到 `<状态根>/images/<key>/`，后续同输入直接硬链接克隆，安装阶段从约 2 秒降到 11 毫秒。
- key 覆盖 DSH 版本、安装源与 `file:` 目录内容哈希；镜像内指向自身的链接会重写，原 sandbox 删除后仍可用。
- 新增 `installMode: "cached" | "fresh"` 与 `dsh-test images`；`environment.json` 记录 `cached` / `imageKey` / `imageError`。

## 1.7.0 — 2026-10-31

- 面板里可以点开计划看详情：模式、等价 DSH 命令、插件入口与 config、安装来源、凭据、证据、超时、断言。
- 新增只读接口 `GET /plugin-test/plan?name=`，返回计划内容与文件路径；计划仍然只能由操作者用 CLI 注册。

## 1.6.0 — 2026-10-31

- 新增 `expect` 断言：跑完自动检查证据内容（JSON 深比较 + 路径、文本包含、正则），失败即判 `failed`。
- 断言结果写入 `status.check.assertions`，附 `expected`/`actual`；面板显示 `expect x/y` 徽标。
- 计划文件允许带 BOM（Windows 记事本保存的 JSON 不再解析失败）。
- 示例计划 `examples/expect-fixture.json`；README 增加面板截图。

## 1.5.0 — 2026-10-31

- 交互模式：`mode: "open"` 起一个常驻的一次性 DSH，打印带 token 的地址；`destroy` 结束并清理。
- 新增工具 `plugin_test_open` / `plugin_test_destroy`，面板里对应「打开」「销毁」。
- 空闲上限 `openTimeoutSeconds`（默认 7200 秒），超时按 `timed_out` 收尾。

## 1.4.0 — 2026-10-31

- 界面从设置页移到侧边栏独立面板（`sidebar.panellist` + `main`），不经过聊天即可操作。
- 面板显示每个计划的模式，`open` 计划直接给「打开」按钮。

## 1.3.0 — 2026-10-31

- 状态根默认改为 `%DSH_HOME%/plugin-test-controller`：备份 `.dsh` 即备份全部计划、运行和证据。
- 解析顺序 `config.root` → `DSH_TEST_ROOT` → `DSH_HOME` 默认值。

## 1.2.0 — 2026-10-31

- 新增 `install` 阶段：在一次性 profile 里安装 `file:` / `npm:@exact` 包，强制 `--ignore-scripts`。
- 安装结果（包名、版本、锁文件哈希、耗时）写入 `evidence/environment.json`，日志写入 `evidence/install.log`。
- 安装阶段独立超时 `installTimeoutSeconds`，失败即终止本轮。

## 1.1.0 — 2026-10-31

- 成为完整的 DSH 客户端插件：`exports["./client"]` + `dsh.client` 声明。
- 宿主侧 `/plugin-test/*` JSON 路由；面板可查看计划、启动、取消、导出证据。
- 面板内测试凭据只存宿主内存，不落盘、不进 argv，名字并入该轮 `credentialEnv` 参与脱敏与审计。

## 1.0.1 — 2026-10-31

- 修复桌面版 `Worker exited before readiness (0)`：worker 与 DSH 子进程显式使用 Electron Node 模式。
- 新增桌面冒烟脚本 `scripts/desktop-smoke.mjs`。

## 1.0.0 — 2026-10-30

- 首个版本：一次性 DSH 环境、证据导出、取消与清理、`recover`、CLI 与 agent 工具。
