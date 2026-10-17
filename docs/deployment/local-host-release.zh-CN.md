# 本机 OpenDesign 源码与发布管理

> 适用范围：当前 Linux 主机的本地实例。此文档描述运行事实和升级门禁，不改变 OpenDesign 自带的发布机制。

## 目录职责（不可混用）

| 角色 | 权威位置 | 用途 |
| --- | --- | --- |
| 唯一开发 Git 仓库 | `/home/zzjjzz/open-design` | 开发、合并、提交；`origin` 为个人仓库 |
| 官方更新源 | `https://github.com/nexu-io/open-design` | 只作为上游变更来源，不能直接覆盖生产目录 |
| 固定运行版本 | `~/.local/share/open-design/releases/<版本标识>/source` | 按已验证的提交独立构建，运行期间禁止直接修改 |
| 当前发布指针 | `~/.local/share/open-design/main-source` | 指向当前发布源码的便捷入口，不等于服务的启动配置 |
| 发布元数据 | 当前发布目录下的 `deployment.json` | 唯一记录 `sourceRevision`、构建产物摘要、容器镜像及服务端口 |
| 发布健康检查 | 当前发布目录下的 `open_design_release_check.py` | 验证产物完整性、MCP 配置与服务就绪状态 |
| 用户服务 | `open-design.service`、`toolhive-open-design.service` | 由 `systemctl --user` 管理；以实际服务配置为准 |
| MCP 配置 | `/etc/toolhive/open-design/open-design.run.json` | MCP（模型上下文协议）容器镜像和代理目标 |

运行数据目录不得由脚本或文档另行推导：以发布元数据中的 `preservedDataRoot` 和项目根目录 `AGENTS.md` 的 **Daemon data directory contract（守护进程数据目录约定）**为准，升级时保持原数据根不变。

## 升级前核对基线（2026-10-17）

- 开发仓库 `HEAD`、发布元数据 `sourceRevision` 和 MCP 镜像版本标签均为 `4f01384ef3947f760fb746b76e7587e0fad8085c`。
- 升级前已发布版本为 `0.23.1`，固定发布目录名为 `20261007-canonical-4f01384`；后续运行版本应以实际 `deployment.json` 为准。
- `main-source` 指向该发布目录下的 `source`；两项用户服务运行中，完整性及 HTTP 就绪核查通过。
- 当前只有这 **一套** 发布目录；尚不存在第二套已验证的回滚版本，因此首次升级前必须保留这套原版本。

## 每次更新前：只读核对

```bash
# 通过当前发布指针定位发布目录，避免在多个路径里猜测
RELEASE_DIR="$(dirname "$(readlink -f "$HOME/.local/share/open-design/main-source")")"

# 完整性、运行状态及 MCP 配置三项合并核验
python3 -B "$RELEASE_DIR/open_design_release_check.py" \
  --manifest "$RELEASE_DIR/deployment.json" \
  --mcp-config /etc/toolhive/open-design/open-design.run.json \
  --wait-ready --include-web --timeout 10

# 人工对照：开发仓库、实际运行版本及容器标签
 git -C "$HOME/open-design" rev-parse HEAD
 jq -r '.sourceRevision,.appVersion,.mcpImage' "$RELEASE_DIR/deployment.json"
 docker inspect open-design --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
 systemctl --user is-active open-design.service toolhive-open-design.service

# 仅检查官方主分支的远端提交，不修改代码
 git ls-remote https://github.com/nexu-io/open-design.git refs/heads/main
```

**解释：** 开发仓库比发布版本新，表示“有代码尚未发布”，不代表生产版本损坏。生产版本的强制一致性应以固定发布目录、`deployment.json`、服务配置和容器镜像为准。官方上游提交不一致也只说明存在待评估更新。

## 规范化升级顺序

1. **先评估**：查看官方更新内容、安全公告、版本兼容与本地二次开发差异，不直接执行 `git pull` 修改运行目录。
2. **独立构建**：先在开发仓库的隔离分支或工作树完成适配和必要测试；以确定的 Git 提交构建新的独立发布目录和 MCP 镜像，不复用正在运行的发布目录。
3. **固化证据**：新发布目录必须含 `deployment.json`（版本号、来源提交、构建产物摘要、镜像 ID），通过目录自身的完整性校验；保留原发布目录供回滚。
4. **统一切换**：在维护窗口把 `open-design.service`、`toolhive-open-design.service` 及 MCP 配置一起指向新版本。仅修改 `main-source` 软链接不会切换实际运行服务。
5. **验收和回退**：核验 Web、守护进程和 MCP 可用性，以及运行容器的版本标签；失败时恢复原服务配置和原发布镜像，不触碰业务数据。旧版本确认正常前不得删除。

**禁止事项：** 不把 Git 工作树当生产运行目录；不直接在当前发布目录执行安装、拉取、编译或覆盖；不因上游发布新版本就自动重启生产服务；不清理唯一的已验证发布版本。
