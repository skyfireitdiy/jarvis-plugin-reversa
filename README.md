# Jarvis Reversa 插件

[Reversa](https://github.com/sandeco/reversa) 逆向工程框架的 Jarvis 包装器。
复用 Jarvis 模型对遗留项目执行规格逆向工程，生成结构化 Markdown 规格
（`_reversa_sdd/`），并导出为 Jarvis rule 知识库供后续任务复用。

设计见 [issue #328](https://github.com/skyfireitdiy/Jarvis/issues/328)。

## 功能

- **规格逆向工程**：对遗留项目执行 Reversa 5 阶段（Scout / Archaeologist /
  Detective / Architect / Writer）逆向工程，生成结构化 Markdown 规格。
- **Rule 知识库导出**：将 `_reversa_sdd/` 产物按置信度（🟢CONFIRMED /
  🟡INFERRED）导出为 Jarvis rule，供后续任务复用。
- **生命周期管理**：安装 / 状态 / 更新 / 卸载 Reversa 工作区。

## 架构

```
reversa-plugin/
├── config.yaml          # 插件声明（扩展点 + 前端 + 能力清单）
├── plugin/
│   └── api.py           # 插件私有功能（gateway 运行，前端代理调用）
├── tools/               # Agent 工具（薄封装，调用 plugin/api.py）
├── rules/               # （已废弃）转换后的 Reversa skills（SKILL.md → Jarvis rule）
├── frontend/
│   ├── sidebar_view.js  # 侧边栏视图（window.Vue 单文件自包含）
│   └── icon.svg         # 插件图标
└── test/                # 测试
```

### 关键设计决策（issue #328 讨论定稿）

1. **界面**：单一侧边栏视图 `plugin:reversa`，不做管理面板（admin_tabs 需
   管理员权限，普通用户用不了）。
2. **状态**：后端无状态（plugin/api.py 纯函数），设置纯前端 localStorage
   （按节点 + 项目 key 隔离）；跨设备共享靠两台设备指向同一工作区目录。
3. **集成**：CLI 管生命周期 + SKILL.md 转 Jarvis rules 由单个 Jarvis Agent
   自动编排执行（不用 orchestration，因其多 Agent 并行不适合 Reversa 5 阶段
   严格串行强状态依赖的流水线）。
4. **install**：绕过交互式 CLI，直连 Reversa installer 库（`lib/installer/`）
   用代码构造 answers。
5. **引擎**：跳过外部引擎检测，由 Jarvis 模型直接执行。
6. **SKILL.md**：葡语 → front matter 翻译中文，正文保留原文。
   ⚠️ **已废弃**：Jarvis 已默认扫描项目 `.agents/skills` 与 `.claude/skills`
   作为规则来源，SKILL.md 可直接被 Jarvis 加载，无需再转换为
   `.jarvis/rules/reversa/skills/`。`convert_skills` 保留仅为向后兼容。
7. **产物**：每文件一 rule + 覆盖式更新 + metadata 溯源。
8. **置信度**：默认只导出 🟢CONFIRMED / 🟡INFERRED，🔴GAP 不导出。
9. **前端**：3-5s 轮询 state.json + 断线重连 + 刷新恢复。
10. **ACL**：按项目目录 ACL 校验。

## 安装

```bash
# 本地开发（symlink 安装，改代码立即生效）
jarvis plugin install /home/skyfire/code/reversa-plugin

# 或从 git 仓库安装
jarvis plugin install https://github.com/skyfireitdiy/jarvis-plugin-reversa
```

## 开发

```bash
# 单元测试（skill_converter + api.py 核心逻辑）
python3 -m pytest test/ -v

# 后端语法检查
python3 -m py_compile plugin/api.py plugin/skill_converter.py tools/*.py

# 前端语法检查与模板编译验证
node --check frontend/sidebar_view.js
node --check plugin/reversa_bridge.mjs
```

## 依赖

- `node` / `npm`：Reversa installer 库（`npx reversa`）运行环境。
