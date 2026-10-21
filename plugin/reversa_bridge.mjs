#!/usr/bin/env node
/**
 * Reversa 插件 Node.js 桥接脚本。
 *
 * 作用：Python 侧（plugin/api.py）无法直接 import Reversa 的 ESM 库，
 * 因此通过 `npm exec --package=reversa -- node reversa_bridge.mjs <cmd>`
 * 以子进程方式调用本脚本，由本脚本直连 Reversa installer 库完成安装/卸载。
 *
 * 设计（issue #328 决策）：
 * - 绕过交互式 CLI（`npx reversa install` 是 inquirer 交互式、无静默参数），
 *   直连 lib/installer/ 的 Writer/prompts/detector/manifest/validator 库，
 *   用代码构造 answers 完成安装。
 * - 跳过外部引擎检测：不生成 CLAUDE.md/AGENTS.md 等入口文件，只安装
 *   skills（到 .agents/skills/）与 .reversa/ 结构，由 Jarvis 模型直接执行。
 *
 * 用法：
 *   node reversa_bridge.mjs install --project <dir> [--engine codex] [--name ...]
 *   node reversa_bridge.mjs uninstall --project <dir> [--keep-output]
 *   node reversa_bridge.mjs status --project <dir>
 *
 * 输出：JSON（stdout 单行），结构 {"success": bool, "data": {...} / "error": str}。
 */
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";

// ---------------------------------------------------------------------------
// 定位 reversa 包
// ---------------------------------------------------------------------------
function findReversaPkg() {
  // npm exec 会把 <npx缓存>/node_modules/.bin 加入 PATH，
  // reversa 可执行文件在 <pkgRoot>/node_modules/.bin/reversa，
  // 包根 = dirname(dirname(dirname(bin)))。逐级向上找 package.json 兜底。
  const pathEntries = (process.env.PATH || "").split(":");
  for (const entry of pathEntries) {
    const bin = join(entry, "reversa");
    if (existsSync(bin)) {
      let pkgRoot = resolve(dirname(dirname(dirname(bin))));
      // 向上回溯直到找到含 package.json 的目录
      while (pkgRoot && pkgRoot !== "/") {
        if (existsSync(join(pkgRoot, "package.json"))) return pkgRoot;
        pkgRoot = dirname(pkgRoot);
      }
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function fail(message) {
  console.log(JSON.stringify({ success: false, error: message }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------
async function cmdInstall(args) {
  const projectRoot = resolve(args.project || process.cwd());
  if (!existsSync(projectRoot) || !isDir(projectRoot)) {
    fail(`项目目录不存在: ${projectRoot}`);
  }
  const pkgRoot = findReversaPkg();
  if (!pkgRoot) fail("未找到 reversa npm 包（请确认已通过 npm exec --package=reversa 运行）");
  const { createRequire } = await import("module");
  const req = createRequire(join(pkgRoot, "x.js"));
  const pkgDir = dirname(req.resolve("reversa/package.json"));
  const { Writer } = await import(join(pkgDir, "lib/installer/writer.js"));
  const { listAllAgents } = await import(join(pkgDir, "lib/installer/prompts.js"));
  const { ENGINES } = await import(join(pkgDir, "lib/installer/detector.js"));
  const { checkExistingInstallation } = await import(
    join(pkgDir, "lib/installer/validator.js")
  );
  const { buildManifest, saveManifest, loadManifest } = await import(
    join(pkgDir, "lib/installer/manifest.js")
  );
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const version = pkg.version || "0.0.0";

  // 构造 answers（跳过 inquirer 交互）
  const engineId = args.engine || "codex";
  const engine = ENGINES.find((e) => e.id === engineId);
  if (!engine) {
    fail(
      `未知 engine: ${engineId}。可选: ${ENGINES.map((e) => e.id).join(", ")}`
    );
  }
  const agents = listAllAgents();
  const answers = {
    engines: [engineId],
    project_name: args.name || dirname(projectRoot).split(/[\\/]/).pop(),
    user_name: args.user || "user",
    chat_language: args.chat_language || "zh-cn",
    doc_language: args.doc_language || "中文",
    output_folder: args.output_folder || "_reversa_sdd",
    forward_folder: "_reversa_forward",
    git_strategy: "gitignore",
    answer_mode: "file",
    agents,
  };

  const existing = checkExistingInstallation(projectRoot);
  const writer = new Writer(projectRoot);
  try {
    // 安装 skills 到 .agents/skills/<agentId>
    for (const agent of agents) {
      await writer.installSkill(agent, engine.skillsDir);
      if (engine.universalSkillsDir && engine.universalSkillsDir !== engine.skillsDir) {
        await writer.installSkill(agent, engine.universalSkillsDir);
      }
    }
    // 创建 .reversa/ 结构（不安装 entry file——Jarvis 模式不需要）
    writer.createReversaDir(answers, version);
    // 若已安装：更新 state.json 的 engines/agents/answer_mode/output_folder
    if (existing.installed) {
      const statePath = join(projectRoot, ".reversa", "state.json");
      if (existsSync(statePath)) {
        const s = JSON.parse(readFileSync(statePath, "utf8"));
        s.engines = answers.engines;
        s.agents = answers.agents;
        s.answer_mode = answers.answer_mode;
        s.output_folder = answers.output_folder;
        writeJson(statePath, s);
      }
    }
    // .gitignore
    writer.updateGitignore(answers.output_folder);
    writer.saveCreatedFiles();
    // manifest
    const existingManifest = existing.installed ? loadManifest(projectRoot) : {};
    const newManifest = buildManifest(projectRoot, writer.manifestPaths);
    saveManifest(projectRoot, { ...existingManifest, ...newManifest });
  } catch (e) {
    fail(`安装失败: ${e.message || e}`);
  }

  console.log(
    JSON.stringify({
      success: true,
      data: {
        version,
        project: answers.project_name,
        engine: engineId,
        agents: agents.length,
        output_folder: answers.output_folder,
        reinstalled: existing.installed,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// 卸载
// ---------------------------------------------------------------------------
async function cmdUninstall(args) {
  const projectRoot = resolve(args.project || process.cwd());
  const keepOutput = args.keep_output === "true" || args.keep_output === "1";
  const { existsSync: _ex, rmSync, statSync, unlinkSync } = await import("fs");
  const statePath = join(projectRoot, ".reversa", "state.json");
  if (!_ex(statePath)) {
    fail("该项目未安装 Reversa（无 .reversa/state.json）");
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const createdFiles = state.created_files || [];
  const outputFolder = state.output_folder || "_reversa_sdd";

  // 依据 created_files 删除安装产物（跳过用户修改过的文件——用 manifest 校验）
  let removed = 0;
  let errors = 0;
  const keptModified = [];
  try {
    const pkgRoot = findReversaPkg();
    if (pkgRoot) {
      const { createRequire } = await import("module");
      const req = createRequire(join(pkgRoot, "x.js"));
      const pkgDir = dirname(req.resolve("reversa/package.json"));
      const { loadManifest, fileStatus } = await import(
        join(pkgDir, "lib/installer/manifest.js")
      );
      const manifest = loadManifest(projectRoot);
      for (const relPath of createdFiles) {
        const hash = manifest[relPath];
        if (hash) {
          const status = fileStatus(projectRoot, relPath, hash);
          if (status === "modified") {
            keptModified.push(relPath);
            continue;
          }
        }
        const absPath = join(projectRoot, relPath);
        try {
          if (_ex(absPath)) {
            if (statSync(absPath).isDirectory()) rmSync(absPath, { recursive: true, force: true });
            else unlinkSync(absPath);
            removed++;
          }
        } catch {
          errors++;
        }
      }
    } else {
      // 无 manifest 能力时保守删除 .agents/skills 与 .reversa
      const skillsDir = join(projectRoot, ".agents", "skills");
      if (_ex(skillsDir)) {
        rmSync(skillsDir, { recursive: true, force: true });
        removed++;
      }
    }
    // 删除 .reversa/
    const reversaDir = join(projectRoot, ".reversa");
    if (_ex(reversaDir)) {
      rmSync(reversaDir, { recursive: true, force: true });
      removed++;
    }
    // 清理可能残留的空目录（.agents/skills、.agents）
    for (const rel of [".agents/skills", ".agents"]) {
      const dir = join(projectRoot, rel);
      if (_ex(dir)) {
        try {
          if (statSync(dir).isDirectory() && readdirEmpty(dir)) {
            rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    fail(`卸载失败: ${e.message || e}`);
  }

  // 输出目录默认保留（决策 10：卸载保留 _reversa_sdd/ 产物）
  console.log(
    JSON.stringify({
      success: true,
      data: {
        removed,
        errors,
        kept_modified: keptModified.length,
        output_folder: outputFolder,
        output_kept: true,
        output_removed: false,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
async function cmdStatus(args) {
  const projectRoot = resolve(args.project || process.cwd());
  const statePath = join(projectRoot, ".reversa", "state.json");
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ success: true, data: { installed: false } }));
    return;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (e) {
    fail(`读取 state.json 失败: ${e.message}`);
  }
  console.log(
    JSON.stringify({
      success: true,
      data: {
        installed: true,
        version: state.version,
        project: state.project,
        user_name: state.user_name,
        chat_language: state.chat_language,
        doc_language: state.doc_language,
        answer_mode: state.answer_mode,
        output_folder: state.output_folder,
        phase: state.phase,
        completed: state.completed || [],
        pending: state.pending || [],
        checkpoints: state.checkpoints || {},
        engines: state.engines || [],
        agents: (state.agents || []).length,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function readdirEmpty(p) {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const command = process.argv[2];

(async () => {
  try {
    if (command === "install") await cmdInstall(args);
    else if (command === "uninstall") await cmdUninstall(args);
    else if (command === "status") await cmdStatus(args);
    else fail(`未知命令: ${command}（可选 install/uninstall/status）`);
  } catch (e) {
    fail(`执行失败: ${e.message || e}`);
  }
})();
