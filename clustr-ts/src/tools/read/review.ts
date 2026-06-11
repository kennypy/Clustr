/**
 * cluster_review — one read-only call that produces a comprehensive Proxmox
 * review: cluster/quorum, per-node usage + version, disk & pool health (SMART /
 * ZFS), networking, storage, every VM and container (with disk/uptime/onboot/
 * agent detail), a snapshot inventory, backup coverage, and recent task
 * failures. Every section is best-effort (wrapped so one failing call doesn't
 * sink the report), and findings worth attention are collected into a summary.
 *
 * Run this when someone asks for a "review", "health check", or "audit".
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { proxmoxGet } from "../../proxmox.js";
import { gb, safe } from "../../safe.js";
import { agentEnabled } from "./vms.js";

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

interface Enriched {
  onboot: boolean;
  agent?: boolean; // VMs only
  snaps: { name: string; snaptime: number }[];
}

async function enrich(g: Any): Promise<Enriched> {
  const kind = g.type === "qemu" ? "qemu" : "lxc";
  const base = `/nodes/${g.node}/${kind}/${g.vmid}`;
  const [config, snaps] = await Promise.all([
    tryGet<Any>(`${base}/config`, undefined, {}),
    tryGet<Any[]>(`${base}/snapshot`, undefined, []),
  ]);
  return {
    onboot: !!config.onboot,
    agent: g.type === "qemu" ? agentEnabled(config.agent) : undefined,
    snaps: snaps
      .filter((s) => s.name !== "current")
      .map((s) => ({ name: s.name, snaptime: Number(s.snaptime ?? 0) })),
  };
}

async function clusterReview(): Promise<string> {
  const flags: string[] = [];
  const out: string[] = [
    "# Proxmox Cluster Review",
    `_Generated ${dateOf(Date.now() / 1000)} UTC_\n`,
  ];

  const resources = await tryGet<Any[]>("/cluster/resources", undefined, []);
  const nodes = resources.filter((r) => r.type === "node");
  const vms = resources.filter((r) => r.type === "qemu");
  const cts = resources.filter((r) => r.type === "lxc");
  const stores = resources.filter((r) => r.type === "storage");

  // Per-guest enrichment (config + snapshots), fetched concurrently.
  const guests = [...vms, ...cts];
  const enriched = new Map<string, Enriched>();
  await Promise.all(
    guests.map(async (g) => enriched.set(`${g.type}/${g.vmid}`, await enrich(g))),
  );
  const enrichOf = (g: Any): Enriched =>
    enriched.get(`${g.type}/${g.vmid}`) ?? { onboot: false, snaps: [] };

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

  // ---- Disk & pool health --------------------------------------------------
  out.push("## Disk & pool health");
  let anyDiskInfo = false;
  for (const n of nodes) {
    const disks = await tryGet<Any[]>(`/nodes/${n.node}/disks/list`, undefined, []);
    const zpools = await tryGet<Any[]>(`/nodes/${n.node}/disks/zfs`, undefined, []);
    if (!disks.length && !zpools.length) continue;
    anyDiskInfo = true;
    out.push(`### ${n.node}`);
    for (const d of disks) {
      const health = String(d.health ?? "unknown");
      const wear = d.wearout !== undefined && d.wearout !== "N/A" ? ` · wearout ${d.wearout}` : "";
      const hIcon = /pass|ok/i.test(health) ? "🟢" : /unknown/i.test(health) ? "⚪" : "🔴";
      out.push(
        `- ${hIcon} ${d.devpath ?? "?"} — ${d.model ?? d.type ?? "?"} — ${gb(d.size ?? 0)} GB — SMART: ${health}${wear}`,
      );
      if (!/pass|ok|unknown/i.test(health)) {
        flags.push(`🔴 Disk **${d.devpath}** on ${n.node} SMART status: ${health}.`);
      }
    }
    for (const z of zpools) {
      const h = String(z.health ?? "?");
      const zIcon = /online/i.test(h) ? "🟢" : "🔴";
      out.push(
        `- ${zIcon} ZFS **${z.name}** — ${h} — ${gb(z.alloc ?? 0)}/${gb(z.size ?? 0)} GB` +
          (z.frag !== undefined ? ` · frag ${z.frag}%` : ""),
      );
      if (!/online/i.test(h)) flags.push(`🔴 ZFS pool **${z.name}** on ${n.node} is ${h}.`);
    }
  }
  if (!anyDiskInfo) out.push("- No disk/pool detail available (token may lack Sys.Audit on node disks).");
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
      out.push(`- **${i.iface}** (${i.type}) — ${addr} — ports: ${ports} — ${i.active ? "active" : "inactive"}`);
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
    if (seen.has(s.storage)) continue;
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
    const e = enrichOf(g);
    if (g.template) return `📋 ${g.vmid} ${g.name ?? ""} (${g.node}) — ${kind} template`;
    const icon = g.status === "running" ? "🟢" : "⚫";
    const parts: string[] = [];
    if (g.status === "running") {
      parts.push(`CPU ${Math.round((g.cpu ?? 0) * 1000) / 10}%`);
      parts.push(`RAM ${gb(g.mem ?? 0)}/${gb(g.maxmem ?? 0)} GB (${pct(g.mem ?? 0, g.maxmem ?? 0)}%)`);
      // CTs report real disk usage; VMs usually only know the provisioned size.
      parts.push(
        g.disk > 0
          ? `disk ${gb(g.disk)}/${gb(g.maxdisk ?? 0)} GB (${pct(g.disk, g.maxdisk ?? 0)}%)`
          : `disk ${gb(g.maxdisk ?? 0)} GB prov.`,
      );
      parts.push(`up ${days(g.uptime ?? 0)}d`);
    }
    parts.push(`onboot ${e.onboot ? "✓" : "✗"}`);
    if (e.agent !== undefined) parts.push(`agent ${e.agent ? "✓" : "✗"}`);
    if (e.snaps.length) parts.push(`📸${e.snaps.length}`);
    return `${icon} ${g.vmid} ${g.name ?? ""} (${g.node}) — ${g.status} — ${parts.join(" · ")}`;
  };
  const sortById = (a: Any, b: Any) => Number(a.vmid) - Number(b.vmid);

  out.push(`## Virtual machines (${vms.length})`);
  for (const v of [...vms].sort(sortById)) {
    out.push(guestLine(v, "VM"));
    if (v.status === "running" && pct(v.mem ?? 0, v.maxmem ?? 0) > 90) {
      flags.push(`🟠 VM **${v.vmid} ${v.name ?? ""}** memory >90%.`);
    }
    if (v.status === "running" && enrichOf(v).agent === false) {
      flags.push(`🟡 VM **${v.vmid} ${v.name ?? ""}** has no guest agent (degrades backups/shutdown).`);
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

  // ---- Snapshots -----------------------------------------------------------
  out.push("## Snapshots");
  const nowSec = Date.now() / 1000;
  let anySnap = false;
  for (const g of guests.sort(sortById)) {
    const e = enrichOf(g);
    if (!e.snaps.length) continue;
    anySnap = true;
    const oldest = Math.min(...e.snaps.map((s) => s.snaptime || nowSec));
    const ageDays = Math.round((nowSec - oldest) / 86400);
    const stale = ageDays > 7;
    out.push(
      `- ${stale ? "⚠️ " : ""}${g.vmid} ${g.name ?? ""} — ${e.snaps.length} snapshot(s), oldest ${ageDays}d` +
        ` (${e.snaps.map((s) => s.name).join(", ")})`,
    );
    if (stale) {
      flags.push(
        `🟡 ${g.vmid} ${g.name ?? ""} has a ${ageDays}d-old snapshot — snapshots aren't backups and bloat storage.`,
      );
    }
  }
  if (!anySnap) out.push("- No snapshots present.");
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
  const stale: string[] = [];
  for (const g of guests) {
    if (g.template || g.status !== "running") continue;
    const last = latestByVmid.get(Number(g.vmid));
    if (!last) stale.push(`${g.vmid} ${g.name ?? ""} (no backup)`);
    else if (nowSec - last > WEEK) stale.push(`${g.vmid} ${g.name ?? ""} (last ${dateOf(last)})`);
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
    const tasks = await tryGet<Any[]>(`/nodes/${n.node}/tasks`, { errors: 1, limit: 6 }, []);
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
        "CPU/memory/disk usage and version, disk & pool health (SMART/ZFS), " +
        "networking, storage usage, every VM and container (with disk/uptime/" +
        "onboot/guest-agent detail), a snapshot inventory, backup coverage (flags " +
        "guests with no recent backup), and recent task failures — ending with a " +
        "summary of things to look at. Use this whenever the user asks for a " +
        "review, health check, audit, or overview of the cluster.",
      annotations: READ,
    },
    async () => safe("cluster_review", clusterReview),
  );
}
