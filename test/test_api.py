"""plugin/api.py 单元测试。

覆盖核心安全与业务逻辑（不依赖真实 Reversa 安装）：
- ACL：project_dir 必须存在、路径穿越拦截
- 产物浏览：list_artifacts / read_artifact（含越界拦截）
- 置信度过滤：默认不导出 🔴GAP，include_gap=True 时导出
- PUBLIC_FUNCTIONS 白名单完整性
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin"))

import api  # noqa: E402


def _make_project(tmp_path):
    """构造一个带 _reversa_sdd/ 产物与 .agents/skills 的假项目。"""
    proj = tmp_path / "proj"
    output = proj / "_reversa_sdd"
    (output / "sdd").mkdir(parents=True)
    (output / "architecture.md").write_text(
        "# Architecture\n\n🟢CONFIRMED 架构已确认\n", encoding="utf-8"
    )
    (output / "sdd" / "domain.md").write_text(
        "# Domain\n\n🟡INFERRED 领域推断\n", encoding="utf-8"
    )
    (output / "sdd" / "gap.md").write_text(
        "# Gap\n\n🔴GAP 缺口未导出\n", encoding="utf-8"
    )
    skills = proj / ".agents" / "skills" / "reversa"
    skills.mkdir(parents=True)
    (skills / "SKILL.md").write_text(
        "---\nname: reversa\ndescription: Reversa orchestrator.\n---\n\nBody.\n",
        encoding="utf-8",
    )
    return str(proj)


def test_public_functions_whitelist():
    """PUBLIC_FUNCTIONS 白名单包含全部 8 个功能且均可调用。"""
    expected = {
        "install_project",
        "get_status",
        "uninstall_project",
        "list_artifacts",
        "read_artifact",
        "get_skills",
        "convert_skills",
        "export_rules",
    }
    assert set(api.PUBLIC_FUNCTIONS) == expected
    for fn in api.PUBLIC_FUNCTIONS:
        assert callable(getattr(api, fn, None))


def test_project_dir_required():
    """project_dir 缺失/不存在时返回错误。"""
    r = api.get_status(None)
    assert r["success"] is False
    assert "project_dir" in r["error"]

    r = api.get_status("/nonexistent/path/xyz")
    assert r["success"] is False
    assert "不存在" in r["error"]


def test_list_artifacts_tree(tmp_path):
    """list_artifacts 返回产物文件树。"""
    proj = _make_project(tmp_path)
    r = api.list_artifacts(proj)
    assert r["success"] is True
    files = r["data"]["files"]
    names = [f["name"] for f in files]
    assert "architecture.md" in names
    assert "sdd" in names


def test_read_artifact_and_path_traversal(tmp_path):
    """read_artifact 读取正常文件，拦截路径穿越。"""
    proj = _make_project(tmp_path)
    r = api.read_artifact(proj, "architecture.md")
    assert r["success"] is True
    assert "🟢CONFIRMED" in r["data"]["content"]

    r = api.read_artifact(proj, "../../etc/passwd")
    assert r["success"] is False
    assert "越界" in r["error"]

    r = api.read_artifact(proj, "sdd/domain.md")
    assert r["success"] is True
    assert "🟡INFERRED" in r["data"]["content"]


def test_export_rules_confidence_filter(tmp_path):
    """默认不导出 🔴GAP；include_gap=True 时导出。"""
    proj = _make_project(tmp_path)
    r = api.export_rules(proj)
    assert r["success"] is True
    exported = r["data"]["exported"]
    skipped = r["data"]["skipped"]
    # 3 个产物：architecture(CONFIRMED) + domain(INFERRED) 导出，gap(GAP) 跳过
    assert len(exported) == 2
    assert len(skipped) == 1
    assert skipped[0]["path"] == "sdd/gap.md"
    assert "🔴GAP" in skipped[0]["reason"]

    r2 = api.export_rules(proj, include_gap=True)
    assert len(r2["data"]["exported"]) == 3
    assert r2["data"]["skipped"] == []


def test_export_rules_writes_rule_files(tmp_path):
    """导出产物生成带 metadata 溯源的 rule 文件。"""
    proj = _make_project(tmp_path)
    r = api.export_rules(proj)
    assert r["success"] is True
    rule_dir = os.path.join(proj, ".jarvis", "rules", "reversa", "artifacts")
    assert os.path.isdir(rule_dir)
    # architecture.md -> architecture.md（文件名 = 产物名，front matter name 带 reversa_ 前缀）
    rule_file = os.path.join(rule_dir, "architecture.md")
    assert os.path.isfile(rule_file)
    content = open(rule_file, encoding="utf-8").read()
    assert "name: reversa_architecture" in content
    assert "source: reversa" in content
    assert "artifact: architecture.md" in content
    assert "confidence: 🟢CONFIRMED" in content


def test_get_skills(tmp_path):
    """get_skills 列出已安装 skills。"""
    proj = _make_project(tmp_path)
    r = api.get_skills(proj)
    assert r["success"] is True
    assert len(r["data"]["skills"]) == 1
    assert r["data"]["skills"][0]["agent"] == "reversa"
    assert r["data"]["skills"][0]["exists"] is True


def test_convert_skills(tmp_path):
    """convert_skills 把 SKILL.md 转为 rule 并写入 .jarvis/rules/reversa/skills/。"""
    proj = _make_project(tmp_path)
    r = api.convert_skills(proj)
    assert r["success"] is True
    assert r["data"]["total"] == 1
    assert r["data"]["failed"] == []
    rule_file = os.path.join(proj, ".jarvis", "rules", "reversa", "skills", "reversa.md")
    assert os.path.isfile(rule_file)
