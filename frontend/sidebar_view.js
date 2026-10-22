// Reversa 插件前端侧边栏视图。
// 约定：纯浏览器 ES module，用 window.Vue 渲染，导出 default 组件，不 import 'vue'。
// 功能：在编辑器左侧管理 Reversa 逆向工程工作区：
//   - 项目区：选择/添加项目目录（localStorage 按节点+项目持久化）、
//             安装/卸载 Reversa 工作区、查看分析状态（3-5s 轮询）；
//   - 分析控制：查看 5 阶段进度（reconhecimento→escavacao→interpretacao→geracao→revisao）；
//   - 产物浏览：树形浏览 _reversa_sdd/、查看内容、按置信度导出为 Jarvis rule、
//             转换已安装 SKILL.md 为 rule。
// 认证：所有读写经宿主 window.__jarvisFetch（自动携带 jarvis 认证），
//       通过插件功能代理端点 /api/plugins/<node>/function-call 调用插件私有功能层。
// 设计（issue #328）：后端无状态，设置纯前端 localStorage（按节点+项目 key 隔离）；
//       跨设备共享靠两台设备指向同一工作区目录。

const PLUGIN = "reversa";
// 每节点项目目录列表持久化 key 前缀：jarvis_reversa_dirs_<node>（JSON 数组）。
const DIRS_KEY_PREFIX = "jarvis_reversa_dirs_";
// 每节点当前激活项目目录持久化 key 前缀：jarvis_reversa_active_<node>。
const ACTIVE_DIR_KEY_PREFIX = "jarvis_reversa_active_";
// 每节点项目目录历史上限（最近使用在前，超出截断）。
const DIRS_HISTORY_MAX = 10;
// 轮询间隔（毫秒）：3-5s 轮询 state.json（决策 9）。
const POLL_INTERVAL = 4000;
// Reversa 5 阶段（state.json 的 pending/completed 字段值）
const PHASES = [
  "reconhecimento",
  "escavacao",
  "interpretacao",
  "geracao",
  "revisao",
];
const PHASE_LABELS = {
  reconhecimento: "侦察",
  escavacao: "挖掘",
  interpretacao: "解读",
  geracao: "生成",
  revisao: "评审",
};
// 置信度标记
const CONFIDENCE_CONFIRMED = "🟢CONFIRMED";
const CONFIDENCE_INFERRED = "🟡INFERRED";
const CONFIDENCE_GAP = "🔴GAP";

// 按节点生成项目目录列表存储 key
function dirsKey(nodeId) {
  return DIRS_KEY_PREFIX + (String(nodeId || "master").trim() || "master");
}
// 按节点生成激活项目目录存储 key
function activeDirKey(nodeId) {
  return ACTIVE_DIR_KEY_PREFIX + (String(nodeId || "master").trim() || "master");
}

// 复刻 App.vue 的 gateway 地址解析（侧边栏组件无 props 注入，需自行解析）
function parseGatewayAddress(address) {
  address = (address || "").trim();
  if (!address) return null;
  if (address.includes("://")) {
    try {
      const url = new URL(address);
      return {
        protocol: url.protocol.replace(":", ""),
        host: url.hostname,
        port:
          url.port ||
          (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80"),
        path: url.pathname,
      };
    } catch {
      return null;
    }
  }
  if (address.includes(":")) {
    const parts = address.split(":");
    if (parts.length === 2) {
      return { protocol: null, host: parts[0], port: parts[1], path: "" };
    }
  }
  return { protocol: null, host: address, port: "8000", path: "" };
}
// 获取当前页面的 HTTP 协议（与 App.vue getHttpProtocol 一致）
function getHttpProtocol() {
  return window.location.protocol === "https:" ? "https" : "http";
}
function gatewayBase() {
  const parsed = parseGatewayAddress(
    localStorage.getItem("jarvis_gateway_url") || "",
  );
  const host = (parsed && parsed.host) || "127.0.0.1";
  const port = (parsed && parsed.port) || "8000";
  const protocol =
    parsed && parsed.protocol === "https" ? "https" : getHttpProtocol();
  return `${protocol}://${host}:${port}`;
}

// 通过 gateway 插件功能代理端点调用插件私有功能
// nodeId 指定目标节点（默认 master）：Reversa 生命周期与产物都在该节点本地执行
async function callFunction(functionName, args, nodeId) {
  const authedFetch =
    (typeof window !== "undefined" && window.__jarvisFetch) || fetch;
  const targetNodeId = String(nodeId || "master").trim() || "master";
  const resp = await authedFetch(
    `${gatewayBase()}/api/plugins/${encodeURIComponent(targetNodeId)}/function-call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plugin: PLUGIN,
        function: functionName,
        arguments: args || {},
      }),
    },
  );
  let result;
  try {
    result = await resp.json();
  } catch (e) {
    throw new Error("网关响应异常", { cause: e });
  }
  if (!result.success) {
    const err = result.error || {};
    throw new Error(err.message || err.code || "调用失败");
  }
  const payload = result.result || {};
  if (payload.success === false) {
    throw new Error(payload.error || "操作失败");
  }
  return payload;
}

export default {
  name: "ReversaSidebarView",
  props: {
    workingDir: { type: String, default: "" },
  },
  data() {
    return {
      // 节点与当前节点（master 恒在列）
      nodes: [],
      nodeId: "master",
      // 项目目录列表与当前激活目录（localStorage 按节点持久化）
      dirs: [],
      projectDir: "",
      projectInput: "",
      // 状态
      status: null,
      loading: false,
      busy: false,
      error: "",
      message: "",
      // 产物浏览
      artifacts: [],
      artifactOpen: {}, // path -> bool（树展开状态）
      selectedArtifact: null,
      artifactContent: "",
      artifactLoading: false,
      // 导出
      exportBusy: false,
      convertBusy: false,
      includeGap: false,
      // 帮助弹层
      helpVisible: false,
    };
  },
  computed: {
    // 当前激活项目目录（无则空）
    activeProject() {
      return this.projectDir;
    },
    // 是否已安装（status.installed）
    installed() {
      return !!(this.status && this.status.installed);
    },
    // 当前阶段索引（-1 表示未开始/未知）
    currentPhaseIndex() {
      if (!this.status || !Array.isArray(this.status.completed)) return -1;
      let idx = -1;
      PHASES.forEach((p, i) => {
        if (this.status.completed.includes(p)) idx = i;
      });
      return idx;
    },
    // 阶段进度列表：[{key, label, state: done|current|todo}]
    phaseList() {
      const done = new Set(
        (this.status && Array.isArray(this.status.completed)
          ? this.status.completed
          : []
        ).map((p) => String(p)),
      );
      const cur = this.status && this.status.phase ? String(this.status.phase) : "";
      return PHASES.map((p) => {
        let state = "todo";
        if (done.has(p)) state = "done";
        else if (cur === p) state = "current";
        return { key: p, label: PHASE_LABELS[p] || p, state };
      });
    },
  },
  mounted() {
    this.initNodes();
    this.restoreDirs();
    // 订阅宿主 agent_changed 事件：切换 Agent 时同步刷新
    const on = typeof window !== "undefined" && window.__jarvisOn;
    if (typeof on === "function") {
      this._offAgentChanged = on("agent_changed", () => {
        this.refresh();
      });
    }
    // 3-5s 轮询状态（决策 9）
    this._pollTimer = setInterval(() => {
      this.pollStatus();
    }, POLL_INTERVAL);
    this.refresh();
  },
  beforeUnmount() {
    if (typeof this._offAgentChanged === "function") this._offAgentChanged();
    if (this._pollTimer) clearInterval(this._pollTimer);
  },
  watch: {
    workingDir() {
      this.refresh();
    },
  },
  methods: {
    // ---- 节点管理 ----
    // 加载节点列表（__jarvisGetNodes，master 恒在列），并恢复上次选中的节点
    initNodes() {
      const getNodes =
        typeof window !== "undefined" && window.__jarvisGetNodes;
      if (typeof getNodes !== "function") {
        this.nodes = [{ node_id: "master", status: "running" }];
        return;
      }
      try {
        const list = getNodes() || [];
        const nodes = Array.isArray(list)
          ? list.filter((n) => n && String(n.node_id || "").trim())
          : [];
        this.nodes = nodes.length ? nodes : [{ node_id: "master", status: "running" }];
      } catch (e) {
        this.nodes = [{ node_id: "master", status: "running" }];
      }
      const saved = (localStorage.getItem("jarvis_reversa_node") || "master").trim();
      this.nodeId = saved || "master";
      this.restoreDirs();
    },
    onNodeChange() {
      localStorage.setItem("jarvis_reversa_node", this.nodeId);
      this.restoreDirs();
      this.refresh();
    },
    // ---- 项目目录（localStorage 按节点持久化）----
    restoreDirs() {
      const raw = localStorage.getItem(dirsKey(this.nodeId));
      let dirs = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) dirs = parsed;
      } catch (e) {
        dirs = [];
      }
      this.dirs = dirs.filter((d) => d && String(d).trim());
      const active = (localStorage.getItem(activeDirKey(this.nodeId)) || "").trim();
      this.projectDir = active || "";
      this.projectInput = this.projectDir;
    },
    persistDirs() {
      localStorage.setItem(dirsKey(this.nodeId), JSON.stringify(this.dirs));
      if (this.projectDir) {
        localStorage.setItem(activeDirKey(this.nodeId), this.projectDir);
      } else {
        localStorage.removeItem(activeDirKey(this.nodeId));
      }
    },
    // 添加项目目录（去重、最近使用在前、上限截断）
    addProject() {
      const dir = (this.projectInput || "").trim();
      if (!dir) {
        this.error = "请输入项目目录";
        return;
      }
      this.dirs = [dir, ...this.dirs.filter((d) => d !== dir)].slice(
        0,
        DIRS_HISTORY_MAX,
      );
      this.projectDir = dir;
      this.persistDirs();
      this.error = "";
      this.refresh();
    },
    selectProject(dir) {
      this.projectDir = dir;
      this.projectInput = dir;
      this.persistDirs();
      this.refresh();
    },
    removeProject(dir) {
      this.dirs = this.dirs.filter((d) => d !== dir);
      if (this.projectDir === dir) {
        this.projectDir = "";
        this.projectInput = "";
        localStorage.removeItem(activeDirKey(this.nodeId));
      }
      this.persistDirs();
      this.refresh();
    },
    // ---- 状态 ----
    async refresh() {
      this.loading = true;
      this.error = "";
      try {
        if (this.projectDir) {
          await this.loadStatus();
          await this.loadArtifacts();
        } else {
          this.status = null;
          this.artifacts = [];
        }
      } catch (e) {
        this.error = e.message || "刷新失败";
        this.status = null;
      } finally {
        this.loading = false;
      }
    },
    // 轮询：静默刷新状态（不打断用户操作）
    async pollStatus() {
      if (!this.projectDir || this.busy || this.loading) return;
      try {
        await this.loadStatus();
      } catch (e) {
        // 轮询失败静默（断线重连：下次轮询自动恢复）
      }
    },
    async loadStatus() {
      const payload = await callFunction("get_status", { project_dir: this.projectDir }, this.nodeId);
      this.status = payload.data || {};
    },
    // ---- 安装/卸载 ----
    async doInstall() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      this.busy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "install_project",
          { project_dir: this.projectDir, engine: "codex" },
          this.nodeId,
        );
        this.message = `安装成功：${payload.data.version}，${payload.data.agents} 个 skills`;
        await this.loadStatus();
        await this.loadArtifacts();
      } catch (e) {
        this.error = e.message || "安装失败";
      } finally {
        this.busy = false;
      }
    },
    async doUninstall() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!window.confirm("确定卸载 Reversa 工作区？_reversa_sdd/ 产物会保留。")) {
        return;
      }
      this.busy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "uninstall_project",
          { project_dir: this.projectDir, keep_output: true },
          this.nodeId,
        );
        this.message = `卸载完成：移除 ${payload.data.removed} 个文件`;
        await this.loadStatus();
        await this.loadArtifacts();
      } catch (e) {
        this.error = e.message || "卸载失败";
      } finally {
        this.busy = false;
      }
    },
    // ---- 产物浏览 ----
    async loadArtifacts() {
      const payload = await callFunction("list_artifacts", { project_dir: this.projectDir }, this.nodeId);
      this.artifacts = (payload.data && payload.data.files) || [];
    },
    // 树形展开/收起
    toggleDir(node) {
      this.artifactOpen[node.path] = !this.artifactOpen[node.path];
    },
    isDirOpen(node) {
      return !!this.artifactOpen[node.path];
    },
    async openArtifact(node) {
      if (node.type !== "file") return;
      this.artifactLoading = true;
      this.error = "";
      try {
        const payload = await callFunction(
          "read_artifact",
          { project_dir: this.projectDir, path: node.path },
          this.nodeId,
        );
        this.selectedArtifact = payload.data;
        this.artifactContent = payload.data.content || "";
      } catch (e) {
        this.error = e.message || "读取产物失败";
      } finally {
        this.artifactLoading = false;
      }
    },
    // 置信度徽标
    confidenceBadge(content) {
      if (!content) return "";
      if (content.includes(CONFIDENCE_GAP)) return CONFIDENCE_GAP;
      if (content.includes(CONFIDENCE_CONFIRMED)) return CONFIDENCE_CONFIRMED;
      if (content.includes(CONFIDENCE_INFERRED)) return CONFIDENCE_INFERRED;
      return "";
    },
    // ---- 导出 ----
    async doExportRules() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      this.exportBusy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "export_rules",
          {
            project_dir: this.projectDir,
            include_gap: this.includeGap,
            include_unknown: true,
          },
          this.nodeId,
        );
        const d = payload.data || {};
        this.message = `导出 ${d.exported ? d.exported.length : 0} 条 rule 到 ${d.rule_dir || ""}` +
          (d.skipped && d.skipped.length ? `（跳过 ${d.skipped.length} 条）` : "");
      } catch (e) {
        this.error = e.message || "导出失败";
      } finally {
        this.exportBusy = false;
      }
    },
    async doConvertSkills() {
      // convert_skills 已废弃：Jarvis 已默认扫描 .agents/skills，SKILL.md 可直接加载。
      // 保留按钮仅为向后兼容，点击时提示用户无需转换。
      this.error = "";
      this.message = "convert_skills 已废弃：Jarvis 已默认扫描 .agents/skills 与 .claude/skills，SKILL.md 可直接加载，无需转换。";
      return;
    },
  },
  template: `
  <div style="display:flex;flex-direction:column;height:100%;font-size:12px;color:#ddd;overflow:hidden;">
    <!-- 头部 -->
    <div style="padding:8px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:6px;flex-shrink:0;">
      <span style="font-weight:bold;font-size:13px;">🔄 Reversa 逆向工程</span>
      <span style="flex:1;"></span>
      <select v-model="nodeId" @change="onNodeChange"
        style="padding:3px 6px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;">
        <option v-for="n in nodes" :key="n.node_id" :value="n.node_id">{{ n.node_id }}</option>
      </select>
      <button @click="helpVisible = true" title="使用说明"
        style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;">?</button>
    </div>

    <!-- 项目区 -->
    <div style="padding:8px 10px;border-bottom:1px solid #333;flex-shrink:0;">
      <div style="font-size:11px;color:#888;margin-bottom:4px;">项目目录</div>
      <div style="display:flex;gap:4px;margin-bottom:4px;">
        <input v-model="projectInput" placeholder="输入项目目录（如 /path/to/legacy）"
          @keydown.enter.prevent="addProject"
          style="flex:1;min-width:0;padding:4px 6px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:12px;">
        <button @click="addProject" :disabled="busy"
          style="padding:4px 10px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">添加</button>
      </div>
      <div v-if="dirs.length" style="display:flex;flex-wrap:wrap;gap:4px;">
        <span v-for="d in dirs" :key="d" @click="selectProject(d)"
          :title="d"
          :style="{display:'inline-flex',alignItems:'center',gap:'3px',padding:'2px 6px',borderRadius:'10px',cursor:'pointer',fontSize:'11px',maxWidth:'180px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',background: d === projectDir ? '#1f6feb' : '#2d2d2d', color: d === projectDir ? '#fff' : '#aaa'}">
          {{ d }}
          <span @click.stop="removeProject(d)" style="color:inherit;opacity:.7;">×</span>
        </span>
      </div>
    </div>

    <!-- 状态区 -->
    <div v-if="projectDir" style="padding:8px 10px;border-bottom:1px solid #333;flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <span style="font-size:11px;color:#888;">状态：</span>
        <span v-if="loading" style="color:#888;">加载中…</span>
        <span v-else-if="installed" style="color:#3fb950;">已安装 v{{ status.version }}</span>
        <span v-else style="color:#d29922;">未安装</span>
        <span style="flex:1;"></span>
        <button @click="refresh" :disabled="busy" title="刷新"
          style="padding:3px 8px;background:#2d2d2d;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:11px;">刷新</button>
      </div>
      <!-- 阶段进度条 -->
      <div v-if="installed" style="display:flex;gap:2px;margin-bottom:6px;">
        <div v-for="p in phaseList" :key="p.key" :title="p.key"
          :style="{flex:'1',height:'6px',borderRadius:'3px',background: p.state === 'done' ? '#3fb950' : (p.state === 'current' ? '#1f6feb' : '#333')}">
        </div>
      </div>
      <div v-if="installed" style="display:flex;gap:6px;font-size:11px;color:#888;margin-bottom:6px;flex-wrap:wrap;">
        <span v-for="p in phaseList" :key="p.key"
          :style="{color: p.state === 'done' ? '#3fb950' : (p.state === 'current' ? '#79c0ff' : '#888')}">
          {{ p.state === 'done' ? '✓' : (p.state === 'current' ? '▶' : '○') }} {{ p.label }}
        </span>
      </div>
      <div v-if="installed" style="font-size:11px;color:#888;margin-bottom:6px;">
        项目：{{ status.project }} · 语言：{{ status.chat_language }} · 输出：{{ status.output_folder }}
      </div>
      <!-- 操作按钮 -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button v-if="!installed" @click="doInstall" :disabled="busy || loading"
          style="padding:5px 12px;background:#238636;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
          {{ busy ? '安装中…' : '安装 Reversa' }}
        </button>
        <button v-if="installed" @click="doUninstall" :disabled="busy || loading"
          style="padding:5px 12px;background:#da3633;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
          {{ busy ? '卸载中…' : '卸载' }}
        </button>
        <button @click="doConvertSkills" :disabled="convertBusy || !installed" title="已废弃：Jarvis 已默认扫描 .agents/skills，SKILL.md 可直接加载"
          style="padding:5px 12px;background:#8957e5;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;opacity:.6;">
          {{ convertBusy ? '转换中…' : 'SKILL→Rule（已废弃）' }}
        </button>
        <button @click="doExportRules" :disabled="exportBusy || !installed"
          style="padding:5px 12px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
          {{ exportBusy ? '导出中…' : '导出 Rules' }}
        </button>
      </div>
      <label v-if="installed" style="display:flex;align-items:center;gap:4px;margin-top:6px;font-size:11px;color:#888;cursor:pointer;">
        <input type="checkbox" v-model="includeGap"> 导出 🔴GAP（默认只导出 🟢CONFIRMED/🟡INFERRED）
      </label>
    </div>

    <!-- 消息/错误 -->
    <div v-if="message" style="padding:4px 10px;background:#1f3d2b;color:#3fb950;font-size:11px;flex-shrink:0;">{{ message }}</div>
    <div v-if="error" style="padding:4px 10px;background:#3d1f1f;color:#f85149;font-size:11px;flex-shrink:0;">{{ error }}</div>

    <!-- 产物浏览 -->
    <div v-if="projectDir" style="flex:1;display:flex;flex-direction:column;min-height:0;">
      <div style="padding:6px 10px;font-size:11px;color:#888;border-bottom:1px solid #333;flex-shrink:0;">
        规格产物（_reversa_sdd/）
      </div>
      <div style="flex:1;overflow:auto;padding:4px 0;">
        <div v-if="!artifacts.length" style="padding:10px;color:#666;font-size:11px;">
          {{ installed ? '暂无产物，请运行 Reversa 分析' : '安装后运行 Reversa 分析生成产物' }}
        </div>
        <div v-for="node in artifacts" :key="node.path">
          <!-- 目录 -->
          <div v-if="node.type === 'dir'" @click="toggleDir(node)"
            style="padding:3px 10px;cursor:pointer;color:#79c0ff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            {{ isDirOpen(node) ? '▾' : '▸' }} 📁 {{ node.name }}
          </div>
          <div v-if="node.type === 'dir' && isDirOpen(node)" style="padding-left:14px;">
            <div v-for="child in node.children" :key="child.path">
              <div v-if="child.type === 'dir'" @click="toggleDir(child)"
                style="padding:3px 10px;cursor:pointer;color:#79c0ff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {{ isDirOpen(child) ? '▾' : '▸' }} 📁 {{ child.name }}
              </div>
              <div v-if="child.type === 'dir' && isDirOpen(child)" style="padding-left:14px;">
                <div v-for="g in child.children" :key="g.path" @click="openArtifact(g)"
                  :style="{padding:'3px 10px',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color: selectedArtifact && selectedArtifact.path === g.path ? '#1f6feb' : '#ddd'}">
                  📄 {{ g.name }}
                  <span v-if="confidenceBadge(g.path)" style="margin-left:4px;font-size:10px;"></span>
                </div>
              </div>
              <div v-else @click="openArtifact(child)"
                :style="{padding:'3px 10px',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color: selectedArtifact && selectedArtifact.path === child.path ? '#1f6feb' : '#ddd'}">
                📄 {{ child.name }}
              </div>
            </div>
          </div>
          <!-- 文件 -->
          <div v-else @click="openArtifact(node)"
            :style="{padding:'3px 10px',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color: selectedArtifact && selectedArtifact.path === node.path ? '#1f6feb' : '#ddd'}">
            📄 {{ node.name }}
          </div>
        </div>
      </div>
    </div>

    <!-- 产物内容 -->
    <div v-if="selectedArtifact" style="border-top:1px solid #333;flex-shrink:0;max-height:40%;display:flex;flex-direction:column;">
      <div style="padding:4px 10px;font-size:11px;color:#888;display:flex;align-items:center;gap:6px;border-bottom:1px solid #333;">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ selectedArtifact.path }}</span>
        <span v-if="confidenceBadge(selectedArtifact.content)" style="font-size:10px;">{{ confidenceBadge(selectedArtifact.content) }}</span>
        <button @click="selectedArtifact = null; artifactContent = ''"
          style="background:none;border:none;color:#888;cursor:pointer;font-size:12px;">×</button>
      </div>
      <pre style="flex:1;overflow:auto;margin:0;padding:8px 10px;font-size:11px;color:#ccc;white-space:pre-wrap;word-break:break-word;">{{ artifactContent }}</pre>
    </div>

    <!-- 帮助弹层 -->
    <div v-if="helpVisible" @click.self="helpVisible = false"
      style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;">
      <div style="background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:420px;max-height:80%;overflow:auto;font-size:12px;color:#ddd;">
        <div style="font-weight:bold;font-size:13px;margin-bottom:8px;">Reversa 逆向工程插件</div>
        <div style="line-height:1.6;">
          <p><b>用途</b>：对遗留项目执行规格逆向工程，生成结构化 Markdown 规格（_reversa_sdd/），并导出为 Jarvis rule 知识库。</p>
          <p><b>使用步骤</b>：</p>
          <ol style="padding-left:18px;margin:4px 0;">
            <li>添加项目目录（需为已存在目录）</li>
            <li>点击「安装 Reversa」安装工作区（绕过交互式 CLI）</li>
            <li>由 Jarvis Agent 依据转换后的 rules 编排执行 5 阶段分析</li>
            <li>浏览产物，按置信度「导出 Rules」复用</li>
          </ol>
          <p><b>5 阶段</b>：侦察 → 挖掘 → 解读 → 生成 → 评审</p>
          <p><b>置信度</b>：🟢CONFIRMED 已确认 / 🟡INFERRED 推断 / 🔴GAP 缺口（默认不导出）</p>
          <p><b>数据</b>：设置存于浏览器 localStorage（按节点+项目隔离）；跨设备共享靠两台设备指向同一工作区目录。</p>
        </div>
        <div style="text-align:right;margin-top:10px;">
          <button @click="helpVisible = false"
            style="padding:5px 14px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;">关闭</button>
        </div>
      </div>
    </div>
  </div>
  `,
};
