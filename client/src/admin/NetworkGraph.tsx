export interface NetworkNode { userId: string; name: string; departmentId: string | null }
export interface NetworkEdge { a: string; b: string; weight: number; crossDept: boolean }

// v2 Bagian B.5 #6 — Top Connectors network detail. Hand-rolled SVG (nodes
// placed on a circle via cos/sin, no force-directed physics) — no graph
// library is installed, and a real force-directed layout is overkill for
// what will realistically be a few dozen nodes at this company's scale.
const SIZE = 320;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 36;
const DEPT_PALETTE = ['#7c3aed', '#2563eb', '#d97706', '#0891b2', '#dc2626', '#16a34a', '#db2777'];

function deptColor(departmentId: string | null, deptOrder: string[]): string {
  if (!departmentId) return '#9ca3af';
  const idx = deptOrder.indexOf(departmentId);
  return DEPT_PALETTE[idx % DEPT_PALETTE.length];
}

export function NetworkGraph({ nodes, edges }: { nodes: NetworkNode[]; edges: NetworkEdge[] }) {
  if (!nodes.length) return <p className="text-xs text-gray-400">Belum ada anggota untuk dipetakan.</p>;

  const deptOrder = [...new Set(nodes.map((n) => n.departmentId).filter((d): d is string => !!d))];
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(n.userId, { x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) });
  });
  const maxWeight = Math.max(1, ...edges.map((e) => e.weight));

  return (
    <svg width="100%" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Network koneksi antar anggota">
      {edges.map((e, i) => {
        const pa = positions.get(e.a);
        const pb = positions.get(e.b);
        if (!pa || !pb) return null;
        return (
          <line
            key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
            stroke={e.crossDept ? '#f59e0b' : '#a78bfa'}
            strokeOpacity={0.5}
            strokeWidth={1 + (e.weight / maxWeight) * 4}
          />
        );
      })}
      {nodes.map((n) => {
        const p = positions.get(n.userId)!;
        return (
          <g key={n.userId}>
            <circle cx={p.x} cy={p.y} r={7} fill={deptColor(n.departmentId, deptOrder)} stroke="white" strokeWidth={1.5} />
            <text x={p.x} y={p.y - 11} textAnchor="middle" fontSize={9} fill="currentColor" className="text-gray-600 dark:text-gray-300">
              {n.name.length > 12 ? n.name.slice(0, 11) + '…' : n.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
