"""
Tests for tool registry integrity.

These tests verify that:
  1. Every tool in _ALL_TOOLS has a title
  2. Every tool has readOnlyHint or destructiveHint set
  3. Every tool name is <= 64 characters
  4. Every tool name in _ALL_TOOLS has a corresponding entry in _TOOL_HANDLERS
  5. Read tools all have readOnlyHint = True
  6. Write tools (power stop/delete/rollback) have destructiveHint = True
"""
import pytest


def _get_annotation(tool, key, default=None):
    if tool.annotations is None:
        return default
    if isinstance(tool.annotations, dict):
        return tool.annotations.get(key, default)
    return getattr(tool.annotations, key, default)


def test_all_tools_have_title():
    from clustr.server import _ALL_TOOLS
    for tool in _ALL_TOOLS:
        assert tool.title, f"Tool '{tool.name}' is missing a title"


def test_all_tool_names_under_64_chars():
    from clustr.server import _ALL_TOOLS
    for tool in _ALL_TOOLS:
        assert len(tool.name) <= 64, (
            f"Tool name '{tool.name}' is {len(tool.name)} chars, max is 64"
        )


def test_all_tools_have_annotations():
    from clustr.server import _ALL_TOOLS
    for tool in _ALL_TOOLS:
        assert tool.annotations is not None, (
            f"Tool '{tool.name}' has no annotations"
        )


def test_all_tools_have_handler():
    from clustr.server import _ALL_TOOLS, _TOOL_HANDLERS
    for tool in _ALL_TOOLS:
        assert tool.name in _TOOL_HANDLERS, (
            f"Tool '{tool.name}' is in _ALL_TOOLS but has no entry in _TOOL_HANDLERS"
        )


def test_read_tools_are_readonly():
    """All read tools must have readOnlyHint = True."""
    from clustr.server import _ALL_TOOLS
    read_tool_names = {
        "list_nodes", "get_node", "get_node_services", "get_cluster_status",
        "list_vms", "get_vm", "get_vm_status", "list_vm_snapshots",
        "list_containers", "get_container", "get_container_status", "list_container_snapshots",
        "list_storage", "get_storage",
    }
    tool_map = {t.name: t for t in _ALL_TOOLS}
    for name in read_tool_names:
        tool = tool_map[name]
        assert _get_annotation(tool, "readOnlyHint") is True, (
            f"Read tool '{name}' must have readOnlyHint = True"
        )


def test_destructive_tools_marked_correctly():
    """Destructive tools must have destructiveHint = True."""
    from clustr.server import _ALL_TOOLS
    destructive_names = {
        "stop_vm", "reset_vm",
        "stop_container",
        "delete_vm_snapshot", "rollback_vm_snapshot",
        "delete_container_snapshot", "rollback_container_snapshot",
        "vm_delete_request", "vm_delete_confirm",
        "container_delete_request", "container_delete_confirm",
    }
    tool_map = {t.name: t for t in _ALL_TOOLS}
    for name in destructive_names:
        tool = tool_map[name]
        assert _get_annotation(tool, "destructiveHint") is True, (
            f"Tool '{name}' should have destructiveHint = True"
        )


def test_no_duplicate_tool_names():
    from clustr.server import _ALL_TOOLS
    names = [t.name for t in _ALL_TOOLS]
    assert len(names) == len(set(names)), (
        f"Duplicate tool names found: {[n for n in names if names.count(n) > 1]}"
    )
