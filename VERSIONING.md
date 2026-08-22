# 版本管理规范

> 适用项目：FAQ 智能客服机器人（faq-bot）
> 本文件定义本项目从编码到发布全流程的版本管理约定，解决此前「代码版本与发布物脱节、无远端备份、功能悬空在分支上」的问题。

---

## 1. 版本号规范（SemVer）

遵循语义化版本 `MAJOR.MINOR.PATCH`，定义如下：

| 段位 | 何时递增 | 示例 |
|---|---|---|
| MAJOR | 不兼容的 API/表结构变更、架构重构、安全修复 | 1.0.0 → 2.0.0 |
| MINOR | 新增功能（向后兼容） | 1.0.0 → 1.1.0 |
| PATCH | Bug 修复、文案/样式调整（向后兼容） | 1.0.0 → 1.0.1 |

**版本号三处必须同步：**

1. `package.json` 的 `version` 字段
2. git tag（格式 `v1.2.3`，如 `v1.1.0`）
3. 发布物文件名（tar / 镜像 tag，如 `faq-bot-v1.1.0.tar`、镜像 tag `v1.1.0`）

> 参考：历史遗留 `v1.0.0` tag 注解为「封板版本，已部署到测试环境」，即为本规范的起点版本。

---

## 2. 分支模型（单人/小团队精简版）

```
main (长期分支，始终可发布)
 ├── feat/xxx   （新功能，从 main 切出，合并回 main）
 ├── fix/xxx    （修复，从 main 切出，合并回 main）
 └── release/v1.1.0 （发布前冻结分支，可选）
```

规则：

- **`main` 是唯一长期分支**，替代现在的 `master`（可选重命名，见 §6）。
- **禁止在 `main` 上直接提交功能代码**；开发一律在 `feat/*`、`fix/*` 分支进行，经代码检查后合并。
- 合并用 `--no-ff` 保留合并记录，或 squash 为单个清晰提交（推荐 squash：单人项目提交历史更干净）。
- **禁止 detached HEAD 状态**：所有操作前先 `git checkout main` 并确认 `git status` 干净。
- 未完成的工作使用**功能分支 + 定期提交**，不要依赖 `git stash` 存放长期 WIP（stash 不可追溯、易丢失）。

---

## 3. 提交信息规范

格式：`<type>(<scope>): <subject>`

```
feat(task): 新增任务流程管理 API
fix(chat): 修复追问确认时 FAQ 不存在导致的空指针
perf(nlp): 意图识别改用 ANN 索引，查询耗时降低 80%
security(auth): 移除明文密码比较分支，强制 bcrypt
refactor(engine): 拆分 FAQEngine，SQL 收敛到 repositories
docs: 补充版本管理规范
```

| type | 含义 |
|---|---|
| feat | 新功能 |
| fix | 缺陷修复 |
| perf | 性能优化 |
| security | 安全修复 |
| refactor | 重构（无行为变化） |
| docs | 文档 |
| chore | 构建/工具/依赖等杂项 |

提交内容应单一（一次提交只做一件事），便于回滚与追溯。

---

## 4. Tag 与发布流程

### 4.1 发布流程（每次发版按序执行）

```bash
# 1) 确保 main 是最新且干净
git checkout main && git pull
git status --porcelain   # 必须无输出

# 2) 更新版本号（三处同步）
#    - package.json:  "version": "1.1.0"
#    - 如有 CHANGELOG.md，追加本次变更

# 3) 提交版本变更
git add package.json CHANGELOG.md
git commit -m "chore: release v1.1.0"

# 4) 打 tag（annotated tag，带说明）
git tag -a v1.1.0 -m "v1.1.0: 新增任务型多轮对话引擎"

# 5) 推送代码 + tag 到远端（必须，见 §5）
git push && git push --tags

# 6) 构建发布物，命名与版本一致
#    tar 包:  faq-bot-v1.1.0.tar  （含 node_modules + model_cache + 源码）
#    镜像:    docker tag faq-bot faq-bot:v1.1.0 && docker save -o faq-bot-v1.1.0.tar faq-bot:v1.1.0

# 7) 部署（deploy.sh 或 PM2），并在发布记录中注明部署目标环境
```

### 4.2 热修复流程

线上发现紧急 bug 时：从 `main` 切 `fix/xxx` → 修复 → 合并回 main → **递增 PATCH 版本** → 按 4.1 流程发布。

---

## 5. 备份与异地保护（必须补齐）

当前仓库是**纯本地仓库（无 remote）**，这是单点故障风险。至少做到以下两项：

1. **Git 远端**（推荐，优先级最高）：
   ```bash
   git remote add origin <你的私有仓库地址>   # Gitee/GitHub Private/自建 GitLab
   git push -u origin main --tags
   ```
2. **本地异地备份**：定期将仓库打包异地保存：
   ```bash
   git bundle create faq-bot-repo.bundle --all   # 完整仓库备份，可随时 git clone 恢复
   ```

> 说明：`scripts/backup.sh` 只备份数据库（mysqldump），**不包含代码**；`faq-bot-v1.0.0.tar` 是全量快照但不可追溯差异。三者职责不同，不能互相替代。

---

## 6. 当前仓库遗留问题清单（建议尽快处理）

| # | 问题 | 处理建议 |
|---|---|---|
| 1 | HEAD 曾处于 detached（停在旧 tag v1.0.0），工作区一度落后 master 两个功能提交 | ✅ 已切换到 master，新功能（任务引擎）已同步到工作区 |
| 2 | `stash@{0}` 有一条 WIP「任务对话智能化」 | 确认内容后决定：丢弃（`git stash drop`）或恢复继续开发（`git stash pop`，可能有冲突） |
| 3 | `.dockerignore`、`Dockerfile` 有未提交修改 | 审核后提交，或丢弃 |
| 4 | 无 git remote，代码无异地备份 | 按 §5 立即补远端 |
| 5 | 分支名 `master` | 可选重命名：`git branch -m master main` |
| 6 | 无 CHANGELOG.md | 从 v1.0.0 开始维护，记录每次发布变更 |
| 7 | 表结构无版本管理 | 新增表（如 task）由代码 `CREATE TABLE IF NOT EXISTS` 自建；结构变更建议引入 migration 脚本目录 `migrations/`，按时间戳命名 |

---

## 7. 数据与配置的版本归属

| 类型 | 归属 | 是否进 git |
|---|---|---|
| 应用代码 | git | ✅ |
| 数据库表结构 | 代码内建表 + `migrations/`（待建） | ✅ |
| 业务数据（FAQ/日志/任务） | 数据库 | ❌（`scripts/backup.sh` 负责） |
| NLP 模型（model_cache/） | 发布物 tar/镜像 | ❌（体积大，git 忽略，随发布物分发） |
| 依赖（node_modules/） | 发布物 tar/镜像 + package-lock.json | package-lock ✅ / node_modules ❌ |
| 环境变量（.env） | 部署环境手工维护 | ❌（`/.env` 已在 .gitignore） |
| 对话规则配置（sys_config） | 数据库 | ❌（有独立版本号，可导出 JSON 归档） |

---

## 8. 速查命令

```bash
# 开始一个新功能
git checkout main && git pull
git checkout -b feat/xxx

# 开发完合并回 main（squash 方式）
git checkout main
git merge --squash feat/xxx && git commit -m "feat(xxx): 描述"

# 发版
# 见 §4.1 流程

# 检查状态是否干净
git status --porcelain
```
