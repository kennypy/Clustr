/**
 * cluster_review — one read-only call that produces a comprehensive Proxmox
 * review: cluster/quorum, per-node usage + version, networking, storage,
 * VMs, containers, backup coverage, and recent task failures. Every section is
 * best-effort (wrapped so one failing call doesn't sink the whole report), and
 * findings worth attention are collected into a summary at the end.
 *
 * This is the tool to run when someone asks for a "review", "health check", or
 * "audit" of the cluster.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { proxmoxGet } from "../../proxmox.js";
import { gb, safe } from "../../safe.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

type Any = Record<string, any>;

const pct = (used: number, total: number): number =>
  total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
const days = (s: number): number => Math.round((s / 86400) * 10) / 10;
const dateOf = (epoch?: number): string =>
  epoch ? new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16) : "—";

async function tryGet<T>(path: string, query: Any | undefined, fallback: T): Promise<T> {
  try {
    return (await proxmoxGet(path, query)) as T;
  } catch {
    return fallback;
  }
}

const WEEK = 7 * 86400;

async function clusterReview(): Promise<string> {
  const flags: string[] = [];
  const out: string[] = ["# Proxmox Cluster Review", `_Generated ${dateOf(Date.now() / 1000)} UTC_\n`];

  const resources = await tryGet<Any[]>("/cluster/resources", undefined, []);
  const nodes = resources.filter((r) => r.type === "node");
  const vms = resources.filter((r) => r.type === "qemu");
  const cts = resources.filter((r) => r.type === "lxc");
  const stores = resources.filter((r) => r.type === "storage");

  // ---- Cluster -------------------------------------------------------------
  const cstatus = await tryGet<Any[]>("/cluster/status", undefined, []);
  const cl = cstatus.find((i) => i.type === "cluster");
  const version = await tryGet<Any>("/version", undefined, {});
  const online = nodes.filter((n) => n.status === "online").length;
  out.push("## Cluster");
  if (cl) {
    out.push(`- **${cl.name ?? "cluster"}** — quorum: ${cl.quorate ? "✅ quorate" : "❌ NOT quorate"}`);
    if (!cl.quorate) flags.push("🔴 Cluster is **not quorate**.");
  } else {
    out.push("- Single node (no cluster) or status unavailable.");
  }
  out.push(`- Nodes: **${online}/${nodes.length}** online`);
  out.push(
    `- VMs: ${vms.filter((v) => v.status === "running").length} running / ${vms.length} total` +
      ` · Containers: ${cts.filter((c) => c.status === "running").length} running / ${cts.length} total`,
  );
  if (version.version) out.push(`- Proxmox VE: ${version.version}`);
  if (online < nodes.length) flags.push(`🟠 ${nodes.length - online} node(s) offline.`);
  out.push("");

  // ---- Nodes ---------------------------------------------------------------
  out.push("## Nodes");
  for (const n of nodes) {
    const st = await tryGet<Any>(`/nodes/${n.node}/status`, undefined, {});
    const cpuPct = Math.round((n.cpu ?? 0) * 1000) / 10;
    const memPct = pct(n.mem ?? 0, n.maxmem ?? 0);
    const diskPct = pct(n.disk ?? 0, n.maxdisk ?? 0);
    const icon = n.status === "online" ? "🟢" : "🔴";
    out.push(
      `${icon} **${n.node}** — CPU ${cpuPct}% · RAM ${gb(n.mem ?? 0)}/${gb(n.maxmem ?? 0)} GB (${memPct}%)` +
        ` · root ${gb(n.disk ?? 0)}/${gb(n.maxdisk ?? 0)} GB (${diskPct}%)` +
        ` · up ${days(n.uptime ?? 0)}d` +
        (st.pveversion ? ` · ${st.pveversion}` : ""),
    );
    if (cpuPct > 85) flags.push(`🟠 Node **${n.node}** CPU ${cpuPct}%.`);
    if (memPct > 85) flags.push(`🟠 Node **${n.node}** memory ${memPct}%.`);
    if (diskPct > 90) flags.push(`🔴 Node **${n.node}** root disk ${diskPct}% full.`);
  }
  out.push("");

  // ---- Networking ----------------------------------------------------------
  out.push("## Networking");
  for (const n of nodes) {
    const ifaces = await tryGet<Any[]>(`/nodes/${n.node}/network`, undefined, []);
    const relevant = ifaces.filter((i) => i.type === "bridge" || i.type === "bond");
    if (!relevant.length) continue;
    out.push(`### ${n.node}`);
    for (const i of relevant) {
      const addr = i.cidr || i.address || "no IP";
      const ports = i.bridge_ports || i.slaves || "—";
      const active = i.active ? "active" : "inactive";
      out.push(`- **${i.iface}** (${i.type}) — ${addr} — ports: ${ports} — ${active}`);
      if (i.autostart && !i.active) {
        flags.push(`🟠 ${n.node}: bridge **${i.iface}** is set to autostart but is down.`);
      }
    }
  }
  out.push("");

  // ---- Storage -------------------------------------------------------------
  out.push("## Storage");
  const seen = new Set<string>();
  for (const s of stores) {
    if (seen.has(s.storage)) continue; // dedupe shared storages
    seen.add(s.storage);
    const usedPct = pct(s.disk ?? 0, s.maxdisk ?? 0);
    out.push(
      `- **${s.storage}** (${s.plugintype ?? s.type ?? "?"}${s.shared ? ", shared" : ""}) — ` +
        `${gb(s.disk ?? 0)}/${gb(s.maxdisk ?? 0)} GB (${usedPct}%)`,
    );
    if (usedPct > 85) flags.push(`🟠 Storage **${s.storage}** is ${usedPct}% full.`);
  }
  out.push("");

  // ---- Guests --------------------------------------------------------------
  const guestLine = (g: Any, kind: string): string => {
    if (g.template) return `📋 ${g.vmid} ${g.name ?? ""} (${g.node}) — ${kind} template`;
    const icon = g.status === "running" ? "🟢" : "⚫";
    const usage =
      g.status === "running"
        ? ` — CPU ${Math.round((g.cpu ?? 0) * 1000) / 10}% · RAM ${gb(g.mem ?? 0)}/${gb(g.maxmem ?? 0)} GB`
        : "";
    return `${icon} ${g.vmid} ${g.name ?? ""} (${g.node}) — ${g.status}${usage}`;
  };
  const sortById = (a: Any, b: Any) => Number(a.vmid) - Number(b.vmid);

  out.push(`## Virtual machines (${vms.length})`);
  for (const v of [...vms].sort(sortById)) {
    out.push(guestLine(v, "VM"));
    if (v.status === "running" && pct(v.mem ?? 0, v.maxmem ?? 0) > 90) {
      flags.push(`🟠 VM **${v.vmid} ${v.name ?? ""}** memory >90%.`);
    }
  }
  out.push("");
  out.push(`## Containers (${cts.length})`);
  for (const c of [...cts].sort(sortById)) {
    out.push(guestLine(c, "CT"));
    if (c.status === "running" && pct(c.mem ?? 0, c.maxmem ?? 0) > 90) {
      flags.push(`🟠 CT **${c.vmid} ${c.name ?? ""}** memory >90%.`);
    }
  }
  out.push("");

  // ---- Backups -------------------------------------------------------------
  out.push("## Backups");
  const backupStores = stores.filter((s) => String(s.content ?? "").includes("backup"));
  const latestByVmid = new Map<number, number>();
  let totalBackups = 0;
  const doneStores = new Set<string>();
  for (const s of backupStores) {
    if (doneStores.has(s.storage)) continue;
    doneStores.add(s.storage);
    const rows = await tryGet<Any[]>(
      `/nodes/${s.node}/storage/${s.storage}/content`,
      { content: "backup" },
      [],
    );
    totalBackups += rows.length;
    for (const r of rows) {
      const id = Number(r.vmid);
      if (!id) continue;
      const prev = latestByVmid.get(id) ?? 0;
      if ((r.ctime ?? 0) > prev) latestByVmid.set(id, r.ctime ?? 0);
    }
  }
  out.push(
    `- ${totalBackups} archive(s) across ${doneStores.size} backup storage(s): ` +
      `${[...doneStores].join(", ") || "none"}.`,
  );
  const nowSec = Date.now() / 1000;
  const stale: string[] = [];
  for (const g of [...vms, ...cts]) {
    if (g.template || g.status !== "running") continue;
    const last = latestByVmid.get(Number(g.vmid));
    if (!last) stale.push(`${g.vmid} ${g.name ?? ""} (no backup)`);
    else if (nowSec - last > WEEK)
      stale.push(`${g.vmid} ${g.name ?? ""} (last ${dateOf(last)})`);
  }
  if (stale.length) {
    out.push(`- ⚠️ Running guests without a recent (<7d) backup: ${stale.join("; ")}`);
    flags.push(`🟠 ${stale.length} running guest(s) lack a recent backup.`);
  } else if (totalBackups > 0) {
    out.push("- ✅ All running guests have a backup within the last 7 days.");
  }
  out.push("");

  // ---- Recent failures -----------------------------------------------------
  out.push("## Recent task failures");
  let anyFail = false;
  for (const n of nodes) {
    const tasks = await tryGet<Any[]>(
      `/nodes/${n.node}/tasks`,
      { errors: 1, limit: 6 },
      [],
    );
    for (const t of tasks) {
      anyFail = true;
      out.push(
        `❌ ${n.node} — **${t.type}**${t.id ? ` ${t.id}` : ""} — ${t.status} (${dateOf(t.starttime)})`,
      );
    }
  }
  if (!anyFail) out.push("- ✅ No recent task failures.");
  else flags.push("🟠 There are recent task failures (see above).");
  out.push("");

  // ---- Attention -----------------------------------------------------------
  out.push("## ⚠️ Attention");
  if (flags.length) out.push(...flags.map((f) => `- ${f}`));
  else out.push("- ✅ Nothing flagged — cluster looks healthy.");

  return out.join("\n");
}

export function register(server: McpServer): void {
  server.registerTool(
    "cluster_review",
    {
      title: "Review Proxmox Cluster",
      description:
        "Run a comprehensive Proxmox review in one call: cluster/quorum, per-node " +
        "CPU/memory/disk usage and version, networking (bridges/bonds), storage " +
        "usage, all VMs and containers, backup coverage (flags guests with no " +
        "recent backup), and recent task failures — ending with a summary of " +
        "things to look at. Use this whenever the user asks for a review, health " +
        "check, audit, or overview of the cluster.",
      annotations: READ,
    },
    async () => safe("cluster_review", clusterReview),
  );
}
