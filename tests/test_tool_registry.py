"""
Tests for tool registry integrity (FastMCP).

These tests introspect the registered tools via ``mcp.list_tools()`` and verify:
  1. Every tool has a title
  2. Every tool name is <= 64 characters
  3. Every tool has readOnlyHint or destructiveHint set explicitly
  4. The full expected tool set is registered (no missing/extra/duplicate)
  5. Read tools all have readOnlyHint = True
  6. Destructive tools (force stop/hard reset/delete/rollback) have destructiveHint = True
"""
import pytest

EXPECTED_TOOLS = {
    # Read (14)
    "list_nodes", "get_node", "get_node_services", "get_cluster_status",
    "list_vms", "get_vm", "get_vm_status", "list_vm_snapshots",
    "list_containers", "get_container", "get_container_status", "list_container_snapshots",
    "list_storage", "get_storage",
    # Write — power (9)
    "start_vm", "shutdown_vm", "stop_vm", "reboot_vm", "reset_vm",
    "start_container", "shutdown_container", "stop_container", "reboot_container",
    # Write — snapshots (6)
    "create_vm_snapshot", "delete_vm_snapshot", "rollback_vm_snapshot",
    "create_container_snapshot", "delete_container_snapshot", "rollback_container_snapshot",
    # Write — delete (4)
    "vm_delete_request", "vm_delete_confirm",
    "container_delete_request", "container_delete_confirm",
    # Write — create (2)
    "create_vm", "create_container",
}

READ_TOOL_NAMES = {
    "list_nodes", "get_node", "get_node_services", "get_cluster_status",
    "list_vms", "get_vm", "get_vm_status", "list_vm_snapshots",
    "list_containers", "get_container", "get_container_status", "list_container_snapshots",
    "list_storage", "get_storage",
}

DESTRUCTIVE_NAMES = {
    "stop_vm", "reset_vm",
    "stop_container",
    "delete_vm_snapshot", "rollback_vm_snapshot",
    "delete_container_snapshot", "rollback_container_snapshot",
    "vm_delete_request", "vm_delete_confirm",
    "container_delete_request", "container_delete_confirm",
}


async def _tools():
    from clustr.server import mcp
    return await mcp.list_tools()


async def test_expected_tools_registered():
    tools = await _tools()
    names = [t.name for t in tools]
    assert set(names) == EXPECTED_TOOLS, (
        f"missing={EXPECTED_TOOLS - set(names)} extra={set(names) - EXPECTED_TOOLS}"
    )
    assert len(names) == len(set(names)), "duplicate tool names registered"
    assert len(names) == 35


async def test_all_tools_have_title():
    for tool in await _tools():
        assert tool.title, f"Tool '{tool.name}' is missing a title"


async def test_all_tool_names_under_64_chars():
    for tool in await _tools():
        assert len(tool.name) <= 64, (
            f"Tool name '{tool.name}' is {len(tool.name)} chars, max is 64"
        )


async def test_all_tools_have_hint_set():
    for tool in await _tools():
        ann = tool.annotations
        assert ann is not None, f"Tool '{tool.name}' has no annotations"
        has_hint = (ann.readOnlyHint is not None) or (ann.destructiveHint is not None)
        assert has_hint, f"Tool '{tool.name}' sets neither readOnlyHint nor destructiveHint"


async def test_read_tools_are_readonly():
    tool_map = {t.name: t for t in await _tools()}
    for name in READ_TOOL_NAMES:
        assert tool_map[name].annotations.readOnlyHint is True, (
            f"Read tool '{name}' must have readOnlyHint = True"
        )


async def test_destructive_tools_marked_correctly():
    tool_map = {t.name: t for t in await _tools()}
    for name in DESTRUCTIVE_NAMES:
        assert tool_map[name].annotations.destructiveHint is True, (
            f"Tool '{name}' should have destructiveHint = True"
        )
