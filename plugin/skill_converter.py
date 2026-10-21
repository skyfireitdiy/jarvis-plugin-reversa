"""
SKILL.md → Jarvis rule 转换模块（决策 6：front matter 翻译中文、正文保留原文）。

把 Reversa 安装的 Agent Skills（.agents/skills/<agent>/SKILL.md）转换为
Jarvis rule 格式（YAML front matter: name/description + 指令式 Markdown 正文）。

转换规则：
- 解析 SKILL.md 的 YAML front matter（name/description/license/compatibility/metadata）；
  对未知/缺失字段容错，不因解析失败中断。
- front matter 的 name/description 通过内置映射表翻译为中文（覆盖核心 agent：
  reversa/scout/archaeologist/detective/architect/writer/reviewer 等）；
  未覆盖的 agent 保留原文 description，name 保持原样。
- 正文保留原文（葡语），不做翻译。
- 生成 Jarvis rule 文件：front matter（name/description + metadata 溯源）+ 正文。
- 输出到指定目录（插件 rules/ 或项目 .jarvis/rules/reversa/）。
"""
import os
import re
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


# ---------------------------------------------------------------------------
# 核心 agent 中文翻译映射（name → (中文名, 中文描述)）
# 覆盖 Reversa 5 阶段流水线核心角色；其余 agent 保留原文。
# ---------------------------------------------------------------------------
_CORE_AGENT_TRANSLATIONS: Dict[str, tuple] = {
    "reversa": (
        "Reversa 主入口",
        "Reversa 框架中央编排器。负责编排对遗留系统的完整逆向分析，生成可由 AI 代理执行的规格。"
        "当用户输入 \"/reversa\"、\"reversa\"、\"开始分析\" 或 \"逆向工程\" 时触发。"
        "是任何会话中第一个被调用的 skill。",
    ),
    "reversa-scout": (
        "侦察员（Scout）",
        "映射遗留项目的表面——目录结构、语言、框架、依赖与入口点。"
        "在逆向工程分析开始时使用，用于创建项目的初始清单（reconhecimento 阶段）。",
    ),
    "reversa-archaeologist": (
        "考古学家（Archaeologist）",
        "逐模块深入分析遗留项目代码——提取算法、控制流、数据结构与数据字典。"
        "在逆向工程分析的挖掘阶段使用（escavacao 阶段，紧随 reversa-scout）。",
    ),
    "reversa-detective": (
        "侦探（Detective）",
        "提取遗留项目中隐含的业务知识——业务规则、通过 Git 回溯的 ADR、状态机与权限矩阵。"
        "在逆向工程分析的解读阶段使用（interpretacao 阶段）。",
    ),
    "reversa-architect": (
        "架构师（Architect）",
        "将遗留项目分析综合为完整的架构文档——C4 图、完整 ERD、集成地图与规格影响矩阵。"
        "在逆向工程分析的解读阶段使用（interpretacao 阶段，紧随 reversa-detective）。",
    ),
    "reversa-writer": (
        "撰写者（Writer）",
        "将遗留系统生成为可执行的规格，作为操作契约，以按单元分文件夹的格式输出"
        "（requirements.md、design.md、tasks.md）。在逆向工程分析的生成阶段使用（geracao 阶段）。",
    ),
    "reversa-reviewer": (
        "评审员（Reviewer）",
        "批判性评审 reversa-writer 生成的规格——发现不一致、重新分类置信度并生成供人工验证的问题。"
        "在逆向工程分析的评审阶段使用（revisao 阶段）。",
    ),
    "reversa-sync": (
        "同步（Reversa Sync）",
        "将 forward 周期的交付物收敛回规格提取（_reversa_sdd/），保持提取与交付同步。",
    ),
    "reversa-forward": (
        "前向交付（Reversa Forward）",
        "基于已提取规格推进遗留系统演进，生成带 legacy-impact.md 的交付物。",
    ),
    "reversa-resume": (
        "恢复（Reversa Resume）",
        "从 .reversa/state.json 恢复中断的 Reversa 分析，继续未完成的阶段。",
    ),
    "reversa-add": (
        "添加（Reversa Add）",
        "向 Reversa 分析添加新的范围/模块，扩展待分析的代码面。",
    ),
    "reversa-new": (
        "新建（Reversa New）",
        "在已有 Reversa 工作区中启动新的分析会话/新项目范围。",
    ),
    "reversa-plan": (
        "规划（Reversa Plan）",
        "为 Reversa 逆向分析制定执行计划，分解阶段与任务。",
    ),
    "reversa-quality": (
        "质量（Reversa Quality）",
        "对 Reversa 生成的规格执行质量检查，确保一致性与完整性。",
    ),
    "reversa-audit": (
        "审计（Reversa Audit）",
        "审计 Reversa 逆向分析过程与产物，识别遗漏与风险。",
    ),
    "reversa-arbiter": (
        "仲裁（Reversa Arbiter）",
        "在 Reversa 多代理分析结果冲突时进行仲裁，收敛结论。",
    ),
    "reversa-clarify": (
        "澄清（Reversa Clarify）",
        "澄清 Reversa 分析中发现的歧义与不确定信息。",
    ),
    "reversa-requirements": (
        "需求（Reversa Requirements）",
        "从遗留系统提取并整理需求规格。",
    ),
    "reversa-refactor": (
        "重构（Reversa Refactor）",
        "基于 Reversa 规格指导遗留代码重构。",
    ),
    "reversa-migrate": (
        "迁移（Reversa Migrate）",
        "基于 Reversa 规格规划并执行系统迁移。",
    ),
    "reversa-optimize": (
        "优化（Reversa Optimize）",
        "基于 Reversa 规格识别并优化系统性能与结构。",
    ),
    "reversa-standardize": (
        "标准化（Reversa Standardize）",
        "统一 Reversa 分析产物的格式与命名规范。",
    ),
    "reversa-simplify": (
        "简化（Reversa Simplify）",
        "识别并简化遗留系统中过度复杂的实现。",
    ),
    "reversa-decouple": (
        "解耦（Reversa Decouple）",
        "识别并消除遗留系统中的耦合点。",
    ),
    "reversa-modularize": (
        "模块化（Reversa Modularize）",
        "将遗留系统拆分为清晰的模块边界。",
    ),
    "reversa-prune": (
        "裁剪（Reversa Prune）",
        "识别并移除遗留系统中的死代码与冗余。",
    ),
    "reversa-restructure": (
        "重组（Reversa Restructure）",
        "重组遗留系统的结构以提升可维护性。",
    ),
    "reversa-brainstorm": (
        "头脑风暴（Reversa Brainstorm）",
        "为遗留系统演进方向进行头脑风暴与方案探索。",
    ),
    "reversa-ideator": (
        "构思（Reversa Ideator）",
        "为遗留系统现代化生成创新方案构想。",
    ),
    "reversa-strategist": (
        "战略家（Reversa Strategist）",
        "制定遗留系统现代化的战略路线。",
    ),
    "reversa-explorer": (
        "探索者（Reversa Explorer）",
        "探索遗留系统代码库，发现关键结构与模式。",
    ),
    "reversa-inspector": (
        "检查员（Reversa Inspector）",
        "深入检查遗留系统特定模块的实现细节。",
    ),
    "reversa-researcher": (
        "研究员（Reversa Researcher）",
        "研究遗留系统相关技术栈与领域知识。",
    ),
    "reversa-docs": (
        "文档（Reversa Docs）",
        "生成与维护 Reversa 分析相关的文档。",
    ),
    "reversa-docs-mapper": (
        "文档映射（Reversa Docs Mapper）",
        "映射遗留系统文档与代码之间的关系。",
    ),
    "reversa-docs-analyst": (
        "文档分析（Reversa Docs Analyst）",
        "分析遗留系统现有文档的质量与覆盖度。",
    ),
    "reversa-docs-storyteller": (
        "文档叙事（Reversa Docs Storyteller）",
        "将 Reversa 分析结果转化为可读性强的叙事文档。",
    ),
    "reversa-docs-publisher": (
        "文档发布（Reversa Docs Publisher）",
        "发布 Reversa 生成的规格文档到目标渠道。",
    ),
    "reversa-spec-sdd": (
        "规格 SDD（Reversa Spec SDD）",
        "生成系统设计文档（SDD）规格。",
    ),
    "reversa-pre-spec": (
        "规格前置（Reversa Pre Spec）",
        "在正式规格前生成前置分析文档。",
    ),
    "reversa-drafter": (
        "起草（Reversa Drafter）",
        "起草 Reversa 规格文档的初稿。",
    ),
    "reversa-reconstructor": (
        "重建（Reversa Reconstructor）",
        "从提取的规格重建系统结构视图。",
    ),
    "reversa-data-master": (
        "数据主档（Reversa Data Master）",
        "分析遗留系统的数据模型与主数据。",
    ),
    "reversa-pricing": (
        "定价（Reversa Pricing）",
        "评估遗留系统现代化/逆向工程的定价。",
    ),
    "reversa-pricing-size": (
        "定价规模（Reversa Pricing Size）",
        "评估遗留系统规模以支撑定价。",
    ),
    "reversa-pricing-estimate": (
        "定价估算（Reversa Pricing Estimate）",
        "估算遗留系统逆向工程工作量与成本。",
    ),
    "reversa-pricing-advisor": (
        "定价顾问（Reversa Pricing Advisor）",
        "为遗留系统现代化提供定价建议。",
    ),
    "reversa-pricing-product": (
        "定价产品（Reversa Pricing Product）",
        "评估产品化定价方案。",
    ),
    "reversa-pricing-profile": (
        "定价画像（Reversa Pricing Profile）",
        "构建遗留系统定价画像。",
    ),
    "reversa-pricing-research": (
        "定价研究（Reversa Pricing Research）",
        "研究遗留系统现代化市场定价。",
    ),
    "reversa-agents-help": (
        "代理帮助（Reversa Agents Help）",
        "帮助理解 Reversa 各代理 skill 的用途与调用方式。",
    ),
    "reversa-autonomous": (
        "自主模式（Reversa Autonomous）",
        "以自主模式运行 Reversa 分析，减少人工干预。",
    ),
    "reversa-forward-autonomous": (
        "自主前向（Reversa Forward Autonomous）",
        "以自主模式运行 forward 交付周期。",
    ),
    "reversa-depth-inspection": (
        "深度检查（Reversa Depth Inspection）",
        "对遗留系统执行深度检查，发现隐藏问题。",
    ),
    "reversa-extract-soul": (
        "提取精髓（Reversa Extract Soul）",
        "提取遗留系统的核心设计意图与业务精髓。",
    ),
    "reversa-to-do": (
        "待办（Reversa To Do）",
        "管理 Reversa 分析过程中的待办事项。",
    ),
    "reversa-visor": (
        "概览（Reversa Visor）",
        "提供 Reversa 分析的整体概览视图。",
    ),
    "reversa-curator": (
        "策展（Reversa Curator）",
        "策展 Reversa 分析产物，保证质量与一致性。",
    ),
    "reversa-challenger": (
        "挑战者（Reversa Challenger）",
        "挑战 Reversa 分析结论，识别潜在错误。",
    ),
    "reversa-debugger": (
        "调试器（Reversa Debugger）",
        "调试遗留系统代码问题。",
    ),
    "reversa-debugger-debate": (
        "调试辩论（Reversa Debugger Debate）",
        "通过多视角辩论定位遗留系统根因。",
    ),
    "reversa-debugger-fix": (
        "调试修复（Reversa Debugger Fix）",
        "修复遗留系统调试发现的问题。",
    ),
    "reversa-debugger-graph": (
        "调试图谱（Reversa Debugger Graph）",
        "构建调用图谱辅助调试。",
    ),
    "reversa-code-express": (
        "代码速写（Reversa Code Express）",
        "快速生成/修改遗留系统代码。",
    ),
    "reversa-coding": (
        "编码（Reversa Coding）",
        "执行遗留系统相关编码任务。",
    ),
    "reversa-design-system": (
        "设计系统（Reversa Design System）",
        "分析遗留系统的设计系统与 UI 规范。",
    ),
    "reversa-designer": (
        "设计师（Reversa Designer）",
        "设计遗留系统现代化 UI/UX 方案。",
    ),
    "reversa-arquitetura-3d": (
        "3D 架构（Reversa Arquitetura 3D）",
        "以 3D 可视化呈现遗留系统架构。",
    ),
    "reversa-highcharts-visualizer": (
        "图表可视化（Reversa Highcharts Visualizer）",
        "用 Highcharts 可视化 Reversa 分析数据。",
    ),
    "reversa-image-prompt-json": (
        "图像提示（Reversa Image Prompt JSON）",
        "生成图像提示的 JSON 结构。",
    ),
    "reversa-screen-translator": (
        "界面翻译（Reversa Screen Translator）",
        "翻译遗留系统界面文案。",
    ),
    "reversa-selo-generativo": (
        "生成印章（Reversa Selo Generativo）",
        "为 Reversa 产物生成质量印章标记。",
    ),
    "reversa-especialista-d3": (
        "D3 专家（Reversa Especialista D3）",
        "用 D3.js 可视化 Reversa 分析数据。",
    ),
    "reversa-framer": (
        "Framer（Reversa Framer）",
        "用 Framer 构建遗留系统现代化原型。",
    ),
    "reversa-n8n": (
        "n8n 集成（Reversa n8n）",
        "将 Reversa 分析流程集成到 n8n 自动化。",
    ),
    "reversa-paradigm-advisor": (
        "范式顾问（Reversa Paradigm Advisor）",
        "为遗留系统现代化推荐编程范式。",
    ),
    "reversa-principles": (
        "原则（Reversa Principles）",
        "应用软件工程原则指导遗留系统演进。",
    ),
}


# ---------------------------------------------------------------------------
# front matter 解析
# ---------------------------------------------------------------------------
def _split_front_matter(content: str) -> tuple:
    """把 Markdown 拆成 (front_matter_dict, body)。

    支持 --- 包裹的 YAML front matter；无 front matter 时返回 ({}, content)。
    解析失败时容错返回 ({}, content) 并保留正文。
    """
    content = content.lstrip("\ufeff")
    if not content.startswith("---"):
        return {}, content
    # 找第二个 --- 行
    lines = content.splitlines()
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return {}, content
    fm_text = "\n".join(lines[1:end_idx])
    body = "\n".join(lines[end_idx + 1:]).strip()
    if yaml is None:
        return {}, content
    try:
        data = yaml.safe_load(fm_text) or {}
        if not isinstance(data, dict):
            return {}, content
    except Exception:  # noqa: BLE001 未知字段/语法容错
        return {}, content
    return data, body


def _translate_agent(name: str, description: str) -> tuple:
    """翻译核心 agent 的 (name, description)；未覆盖则保留原文。"""
    key = name.strip()
    if key in _CORE_AGENT_TRANSLATIONS:
        zh_name, zh_desc = _CORE_AGENT_TRANSLATIONS[key]
        return zh_name, zh_desc
    # 未覆盖：name 保留原样，description 保留原文
    return name, description


def _sanitize_rule_name(agent: str) -> str:
    """把 agent 名转为 rule 文件名（去 reversa- 前缀、非字母数字转下划线）。"""
    stem = re.sub(r"^reversa[-_]?", "", agent)
    stem = re.sub(r"[^A-Za-z0-9_\-\u4e00-\u9fff]+", "_", stem)
    stem = stem.strip("_")
    return stem or "reversa"


# ---------------------------------------------------------------------------
# 转换
# ---------------------------------------------------------------------------
def convert_skill_file(
    skill_path: str, output_dir: str, source: str = "reversa"
) -> Dict[str, Any]:
    """转换单个 SKILL.md 为 Jarvis rule 文件。

    参数:
        skill_path: SKILL.md 路径
        output_dir: 输出目录（写入 <output_dir>/<name>.md）
        source: 溯源标记（默认 reversa）

    返回 {"success": bool, "rule_file": str, "agent": str, "error": str?}。
    未知 front matter 字段容错：解析失败时仍以原文生成 rule。
    """
    try:
        with open(skill_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"读取失败: {e}"}

    fm, body = _split_front_matter(content)
    agent = str(fm.get("name", os.path.basename(os.path.dirname(skill_path)) or "reversa"))
    raw_description = str(fm.get("description", "")).strip()
    license_ = str(fm.get("license", "")).strip()
    compatibility = str(fm.get("compatibility", "")).strip()
    metadata = fm.get("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}

    zh_name, zh_desc = _translate_agent(agent, raw_description)
    rule_name = _sanitize_rule_name(agent)

    # 组装 front matter（name/description + metadata 溯源；未知字段忽略不报错）
    fm_lines = ["---", f"name: {rule_name}", f"description: {zh_desc or raw_description}"]
    if zh_name and zh_name != agent:
        fm_lines.append(f"title: {zh_name}")
    if license_:
        fm_lines.append(f"license: {license_}")
    if compatibility:
        fm_lines.append(f"compatibility: {compatibility}")
    fm_lines.append("metadata:")
    fm_lines.append(f"  source: {source}")
    fm_lines.append(f"  agent: {agent}")
    if metadata:
        for k, v in metadata.items():
            fm_lines.append(f"  {k}: {v}")
    fm_lines.append("---")

    rule_content = "\n".join(fm_lines) + "\n\n" + (body or raw_description).strip() + "\n"

    os.makedirs(output_dir, exist_ok=True)
    rule_file = os.path.join(output_dir, f"{rule_name}.md")
    with open(rule_file, "w", encoding="utf-8") as f:
        f.write(rule_content)

    return {
        "success": True,
        "rule_file": f"{rule_name}.md",
        "agent": agent,
        "title": zh_name or agent,
    }


def convert_skills_dir(
    skills_dir: str, output_dir: str, source: str = "reversa"
) -> Dict[str, Any]:
    """批量转换 skills 目录下的所有 SKILL.md。

    目录结构：<skills_dir>/<agent>/SKILL.md（Reversa 安装格式）。
    返回 {"success": True, "converted": [...], "failed": [...], "total": int}。
    """
    converted: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    if not os.path.isdir(skills_dir):
        return {"success": True, "converted": [], "failed": [], "total": 0}
    try:
        agents = sorted(os.listdir(skills_dir))
    except Exception:  # noqa: BLE001
        agents = []
    for agent in agents:
        skill_path = os.path.join(skills_dir, agent, "SKILL.md")
        if not os.path.isfile(skill_path):
            continue
        result = convert_skill_file(skill_path, output_dir, source=source)
        if result["success"]:
            converted.append(result)
        else:
            failed.append({"agent": agent, "error": result.get("error")})
    return {"success": True, "converted": converted, "failed": failed, "total": len(converted) + len(failed)}


def convert_installed_skills(
    project_dir: str, output_dir: Optional[str] = None, source: str = "reversa"
) -> Dict[str, Any]:
    """从项目已安装的 .agents/skills/ 转换所有 SKILL.md 为 Jarvis rule。

    参数:
        project_dir: 已安装 Reversa 的项目目录
        output_dir: 输出目录；默认 <project_dir>/.jarvis/rules/reversa/
        source: 溯源标记

    返回 {"success": True, "converted": [...], "failed": [...], "total": int}。
    """
    skills_dir = os.path.join(project_dir, ".agents", "skills")
    if output_dir is None:
        output_dir = os.path.join(project_dir, ".jarvis", "rules", "reversa")
    return convert_skills_dir(skills_dir, output_dir, source=source)
