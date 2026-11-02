# 接口与数据格式

## 计划

只有 CLI 的 `plan FILE` 能注册计划。控制插件只能按已批准的名称启动，不能从工具调用动态传入代码、路径或凭据。

| 字段 | 默认值 | 约束 |
|---|---|---|
| `name` | 必填 | 字母或数字开头，字母数字、下划线和连字符，最长 64 字符 |
| `mode` | `inspect` | `inspect`、`headless`（跑一轮）或 `open`（可交互，等 destroy） |
| `prompt` | 空 | headless 必填，最大 100000 字符 |
| `plugins` | `[]` | 最大 32 项，每项为 `module` 和可选 `config` |
| `timeoutSeconds` | 120 | 整数，1–86400 |
| `maxOutputBytes` | 8388608 | stdout/stderr 合计，1024–67108864 字节 |
| `credentialEnv` | `[]` | 最大 32 项；显式继承的变量名称，不允许运行时控制变量 |
| `evidence` | `[]` | 最大 64 个显式工作区相对文件名；每个最大 16 MiB |
| `install` | `[]` | 最大 16 项；每项只有 `source`，取 `file:<路径>` 或 `npm:<包名>@<精确版本>` |
| `installTimeoutSeconds` | 300 | 整数，1–3600；安装阶段独立于运行超时 |
| `installMode` | `cached` | `cached` 复用 `<状态根>/images/<key>` 镜像；`fresh` 强制重新安装 |
| `openTimeoutSeconds` | 7200 | 整数，60–86400；`open` 模式的空闲上限，超时后按 `timed_out` 收尾 |
| `expect` | `[]` | 最大 64 条断言；每条 `file` + `path`（可选）+ `equals`/`contains`/`matches` 三者之一 |

未知顶层字段和未知插件字段会被拒绝。禁止父目录穿越、绝对证据路径和证据通配符。导出文件需要是普通文件，规范化后的真实路径必须位于临时工作区。

`install` 的 `file:` 相对路径以计划文件位置为基准，解析成绝对路径后写回计划；安装发生在一次性 profile 里，强制 `--ignore-scripts`，解析结果（包名、版本、锁文件哈希、耗时）写入 `evidence/environment.json`，安装输出写入 `evidence/install.log`。

`expect` 在证据收集完成后执行，读的是证据目录内的文件（`stdout.log`、`stderr.log`、`environment.json`、`files.json`、`install.log`、`files/<导出文件>`）。任一条失败会把本轮 `state` 置为 `failed`，逐条结果写入 `status.check.assertions`；`result.json` 在断言之后生成，不能作为断言目标。

操作者负责提供无密钥的计划和 plugin config。`credentialEnv` 的值不落入计划或进程参数；环境中缺少变量时，启动会报错。

## 运行器 API

```javascript
import { Controller } from 'dsh-plugin-test-controller/runner';

const c = new Controller({ root: '/absolute/owned-state-directory' });
await c.addPlan('/absolute/plan.json');
const started = await c.start('plan-name');
const final = await c.wait(started.id);
const evidence = await c.export(started.id);
```

`start` 支持 `{ signal }`。返回 ID 后，任务生命周期独立于调用方；通过 `cancel` 请求停止。`wait` 的超时只结束等待，不自动中止后台任务。

## 结果

```json
{
  "format": 1,
  "id": "run-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "plan": "example",
  "state": "completed",
  "cleanup": "succeeded",
  "verdict": "not_evaluated",
  "check": { "kind": "headless", "passed": true, "finalReason": { "kind": "completed" } }
}
```

`cleanup` 为 pending、succeeded 或 failed。恢复操作将中断任务标记为 interrupted。基础设施错误通过 `error`，清理错误通过 `cleanupError` 保存。

DSH 返回 completed 只证明 Agent 回合完成；生成用例有效性和漏洞验证成功都需要额外检查。运行器不读取 Agent 文本中的“成功”字样来判定漏洞。

## 插件版本

环境记录保存 DSH/Node 版本、操作系统、架构、计划 SHA-256、插件入口文件 SHA-256。入口哈希不覆盖全部依赖；正式实验还应保留待测插件的 Git commit 和依赖锁文件，避免运行中修改插件源码。
