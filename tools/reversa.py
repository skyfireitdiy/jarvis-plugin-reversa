"""
Reversa 逆向工程工具（Agent 侧）。

薄封装插件私有功能层 plugin/api.py，让 Jarvis Agent 能对指定项目执行
Reversa 逆向工程全流程：安装工作区、查看状态/产物、转换 SKILL.md 为
Jarvis rule、导出规格产物为 rule、卸载工作区。

用法（action 区分）:
- install: 安装 Reversa 工作区到项目目录（绕过交互式 CLI 直连 installer 库）
- status: 读取 .reversa/state.json 返回分析进度（phase/checkpoints）
- skills: 列出已安装的 Reversa skills（.agents/skills/<agent>/SKILL.md）
- convert_skills: 把已安装的 SKILL.md 转换为 Jarvis rule（front matter 翻译中文）
- artifacts: 列出 _reversa_sdd/ 产物文件树
- read_artifact: 读取单个产物文件内容
- export_rules: 把产物按置信度导出为 Jarvis rule（默认只导出 CONFIRMED/INFERRED）
- uninstall: 卸载 Reversa 工作区（保留 _reversa_sdd/ 产物）

参数:
- action (str): 上述动作之一（必填）
- project_dir (str): 目标项目目录（必填）
- path (str): read_artifact 的产物相对路径
- include_gap (bool): export_rules 是否导出 🔴GAP（默认 false）
- include_unknown (bool): export_rules 是否导出无置信度标记的产物（默认 true）
- engine (str): install 的 engine（默认 codex）
- name/user (str): install 的项目名/用户名（可选）
- keep_output (bool): uninstall 是否保留 _reversa_sdd/（默认 true）

返回 {"success": bool, "stdout": JSON, "stderr": str}。
"""
import importlib.util
import json
import os
import sys
from typing import Any
from typing import Dict

_KNOWN_ACTIONS = {
    "install",
    "status",
    "skills",
    "convert_skills",
    "artifacts",
    "read_artifact",
    "export_rules",
    "uninstall",
}


def _load_api():
    """用 importlib 按路径加载插件私有功能层 plugin/api.py。

    plugin/ 不在 sys.path，故按文件路径加载；模块名固定以便复用缓存。
    """
    # tools/reversa.py -> 插件根目录 -> plugin/api.py
    plugin_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    api_path = os.path.join(plugin_root, "plugin", "api.py")
    if not os.path.isfile(api_path):
        raise FileNotFoundError(f"未找到插件私有功能层: {api_path}")
    mod_name = "reversa_plugin_api"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, api_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载模块: {api_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


class ReversaTool:
    # 文件名必须与工具名一致，便于注册表自动加载
    name = "reversa"
    description = (
        "Reversa 逆向工程：对遗留项目执行规格逆向工程并导出为 Jarvis rule 知识库。"
        "可安装 Reversa 工作区（install）、查看分析进度（status）、列出/转换已安装的 "
        "Reversa skills 为 rule（skills/convert_skills）、浏览规格产物（artifacts/"
        "read_artifact）、把产物按置信度导出为 rule（export_rules）、卸载工作区（uninstall）。"
        "适合用户要求「逆向分析某项目」「生成项目规格」「把 Reversa 产物转成 rule」等场景。"
        "注意：本工具只做生命周期管理与产物转换，不直接执行 5 阶段分析——分析由 Jarvis "
        "Agent 依据转换后的 rules 编排执行。"
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "install",
                    "status",
                    "skills",
                    "convert_skills",
                    "artifacts",
                    "read_artifact",
                    "export_rules",
                    "uninstall",
                ],
                "description": "要执行的动作",
            },
            "project_dir": {
                "type": "string",
                "description": "目标项目目录（必填，需为已存在目录）",
            },
            "path": {
                "type": "string",
                "description": "read_artifact 的产物相对路径（_reversa_sdd/ 下）",
            },
            "include_gap": {
                "type": "boolean",
                "description": "export_rules 是否导出 🔴GAP 置信度产物（默认 false）",
            },
            "include_unknown": {
                "type": "boolean",
                "description": "export_rules 是否导出无置信度标记的产物（默认 true）",
            },
            "engine": {
                "type": "string",
                "description": "install 的 engine（默认 codex）",
            },
            "name": {
                "type": "string",
                "description": "install 的项目名（默认取目录名）",
            },
            "user": {
                "type": "string",
                "description": "install 的用户名（可选）",
            },
            "keep_output": {
                "type": "boolean",
                "description": "uninstall 是否保留 _reversa_sdd/ 产物（默认 true）",
            },
        },
        "required": ["action", "project_dir"],
    }

    def check() -> bool:
        """工具始终可用（node/npm 依赖在 api 层运行时校验）。"""
        return True

    def execute(self, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            action = str(args.get("action") or "").strip()
            if not action:
                return self._err("参数错误：action 不能为空")
            if action not in _KNOWN_ACTIONS:
                return self._err(f"未知 action: {action}")
            project_dir = args.get("project_dir")
            project_dir = str(project_dir).strip() if project_dir else ""
            if not project_dir:
                return self._err("参数错误：project_dir 不能为空")
            api = _load_api()
            if action == "install":
                result = api.install_project(
                    project_dir=project_dir,
                    engine=args.get("engine") or "codex",
                    name=args.get("name"),
                    user=args.get("user"),
                )
            elif action == "status":
                result = api.get_status(project_dir=project_dir)
            elif action == "skills":
                result = api.get_skills(project_dir=project_dir)
            elif action == "convert_skills":
                result = api.convert_skills(project_dir=project_dir)
            elif action == "artifacts":
                result = api.list_artifacts(project_dir=project_dir)
            elif action == "read_artifact":
                result = api.read_artifact(project_dir=project_dir, path=args.get("path"))
            elif action == "export_rules":
                result = api.export_rules(
                    project_dir=project_dir,
                    include_gap=bool(args.get("include_gap")),
                    include_unknown=bool(args.get("include_unknown", True)),
                )
            elif action == "uninstall":
                result = api.uninstall_project(
                    project_dir=project_dir,
                    keep_output=bool(args.get("keep_output", True)),
                )
            else:
                return self._err(f"未知 action: {action}")
            return self._ok(result)
        except Exception as e:
            return self._err(f"reversa 执行异常: {e}")

    @staticmethod
    def _ok(result: Dict[str, Any]) -> Dict[str, Any]:
        """把 api 返回统一包装成工具返回格式。"""
        success = bool(result.get("success"))
        return {
            "success": success,
            "stdout": json.dumps(result, ensure_ascii=False, indent=2),
            "stderr": "" if success else str(result.get("error") or "操作失败"),
        }

    @staticmethod
    def _err(message: str) -> Dict[str, Any]:
        return {"success": False, "stdout": "", "stderr": message}
