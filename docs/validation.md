# 验证记录

本地验证环境：Windows、Node.js v24.15.0、DSH npm 发布版 0.2.1-rc.5。

基础检查：JavaScript 语法检查、npm 包文件清单检查。

自动测试覆盖：

1. 计划格式、参数边界和路径穿越拒绝。
2. 环境变量白名单与 DSH、Agent、用户目录隔离。
3. 状态根所有权与清理边界。
4. 嵌套符号链接清理不追随目标。
5. 仅按已注册计划名称启动。
6. 子进程参数包含中文、空字符串、引号和反斜杠的转发。
7. 超时结束子进程及后代进程。
8. 取消及输出上限。
9. 正常退出后清理持有管道的后代进程。
10. 真实 Cordis 工具注册和插件卸载。
11. 连续两轮真实 DSH CLI 启动不继承哨兵记忆文件；导出文件中的注入凭据被替换。
12. 真实 DSH 导入插件失败时保留失败证据并完成清理。
13. 真实 headless DSH 加载控制插件与待测插件，经本地 Messages 服务驱动真实工具调用，产生证据并完成清理。
14. 控制插件卸载后，独立运行器中止活动任务并完成清理。
15. 中断任务恢复拒绝活动进程，完成清理后生成可导出的最终记录，重复恢复不再修改结果。

没有使用真实模型 API key；没有调用公网模型服务；没有执行处理器漏洞实验。调用链集成测试中的模型响应由本地固定服务提供，不能证明真实模型会在相同任务下始终选择同样的工具。

GitHub Actions 在 Windows 与 Ubuntu 上运行同一套测试，结果以仓库 Actions 对应 commit 为准。

## v1.0.1 桌面启动修复

新增 Electron Node 模式环境传递回归测试，基础及集成测试合计 16 项。

另使用本机 `D:\DeepSeek Harness\DeepSeek Harness.exe`（Electron 44.7.0 / Node v24.21.0）运行 `scripts/desktop-smoke.mjs`：真实 Cordis 注册控制插件 → 调用 `plugin_test_start` → Electron worker → Windows Job Object 宿主 → Electron Node 模式 DSH CLI → 导出结果。实测 `state: completed`、`cleanup: succeeded`，临时 sandbox 已删除。该检查不调用公网模型。

这项检查验证桌面可执行文件下的工具调用链；更新后，原本已运行的桌面 DSH 进程仍需重启才能载入修复。
