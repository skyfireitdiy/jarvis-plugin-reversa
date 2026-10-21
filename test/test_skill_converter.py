"""skill_converter 单元测试。

覆盖核心转换逻辑（不依赖真实 Reversa 安装）：
- front matter 解析与中文翻译（核心 agent 有映射、未知 agent 保留原文）
- 正文保留原文
- 未知字段/无 front matter/metadata 非 dict 容错
- 批量转换与输出文件结构
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin"))

from skill_converter import convert_skill_file  # noqa: E402
from skill_converter import convert_skills_dir  # noqa: E402
from skill_converter import convert_installed_skills  # noqa: E402


def _write_skill(skills_dir, agent, content):
    d = os.path.join(skills_dir, agent)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "SKILL.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    return p


CORE_SKILL = """---
name: reversa
description: |-
  Reversa framework central orchestrator.
license: MIT
compatibility:
  - codex
metadata:
  version: 1.0.0
---

# Reversa

Execute the full reverse analysis pipeline.
"""

UNKNOWN_SKILL = """---
name: custom-agent
description: Custom agent description.
---

Body of custom agent.
"""

NO_FRONTMATTER_SKILL = """# No Front Matter

Just body text.
"""


def test_core_agent_translated(tmp_path):
    """核心 agent（reversa）front matter 翻译中文、正文保留原文。"""
    skills_dir = tmp_path / "skills"
    _write_skill(str(skills_dir), "reversa", CORE_SKILL)
    out = tmp_path / "out"
    result = convert_skills_dir(str(skills_dir), str(out))
    assert result["success"] is True
    assert len(result["converted"]) == 1
    assert result["failed"] == []

    rule_path = out / "reversa.md"
    assert rule_path.is_file()
    content = rule_path.read_text(encoding="utf-8")
    # front matter 中文翻译
    assert "Reversa 主入口" in content
    assert "中央编排器" in content
    # 正文保留原文
    assert "Execute the full reverse analysis pipeline." in content
    # metadata 溯源
    assert "source: reversa" in content


def test_unknown_agent_keeps_original(tmp_path):
    """未知 agent 保留原文 description，name 不变。"""
    skills_dir = tmp_path / "skills"
    _write_skill(str(skills_dir), "custom-agent", UNKNOWN_SKILL)
    out = tmp_path / "out"
    result = convert_skills_dir(str(skills_dir), str(out))
    assert result["success"] is True
    assert len(result["converted"]) == 1

    content = (out / "custom-agent.md").read_text(encoding="utf-8")
    assert "Custom agent description." in content
    assert "Body of custom agent." in content


def test_no_frontmatter_tolerated(tmp_path):
    """无 front matter 的文件不报错，正文保留。"""
    skills_dir = tmp_path / "skills"
    _write_skill(str(skills_dir), "no-fm", NO_FRONTMATTER_SKILL)
    out = tmp_path / "out"
    result = convert_skills_dir(str(skills_dir), str(out))
    assert result["success"] is True
    assert len(result["converted"]) == 1
    assert result["failed"] == []
    content = (out / "no-fm.md").read_text(encoding="utf-8")
    assert "Just body text." in content


def test_missing_skills_dir_returns_empty(tmp_path):
    """skills 目录不存在时返回空结果（不报错）。"""
    result = convert_skills_dir(str(tmp_path / "nonexistent"), str(tmp_path / "out"))
    assert result["success"] is True
    assert result["converted"] == []
    assert result["total"] == 0


def test_convert_installed_skills_default_output(tmp_path):
    """convert_installed_skills 默认输出到 <project>/.jarvis/rules/reversa/skills/。"""
    project = tmp_path / "proj"
    skills_dir = project / ".agents" / "skills"
    _write_skill(str(skills_dir), "reversa", CORE_SKILL)
    result = convert_installed_skills(str(project))
    assert result["success"] is True
    assert result["total"] == 1
    out = project / ".jarvis" / "rules" / "reversa" / "skills" / "reversa.md"
    assert out.is_file()


def test_convert_skill_file_returns_metadata(tmp_path):
    """convert_skill_file 返回结构化结果（含 rule_file）。"""
    skills_dir = tmp_path / "skills"
    p = _write_skill(str(skills_dir), "reversa", CORE_SKILL)
    out = tmp_path / "out"
    result = convert_skill_file(p, str(out))
    assert result["success"] is True
    assert result["rule_file"] == "reversa.md"
    assert os.path.isfile(os.path.join(str(out), "reversa.md"))
