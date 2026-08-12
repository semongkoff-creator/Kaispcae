import { useState } from 'react';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TeamAnalyticsPanel } from './TeamAnalyticsPanel';
import { CompanyAnalyticsPanel } from './CompanyAnalyticsPanel';

type Tier = 'individual' | 'team' | 'company';
const TIERS: { id: Tier; label: string }[] = [
  { id: 'individual', label: 'Individu' },
  { id: 'team', label: 'Team' },
  { id: 'company', label: 'Semua Perusahaan' },
];

// Bagian B.1's three tiers, presented together for whoever can already open
// AdminConsole (workspace admin — see AdminConsole.tsx's own gate). Individu
// here is the admin's OWN view (self) for a one-stop dashboard; every other
// employee reaches the same Individual tier via the separate, non-admin-
// gated "Analitik Saya" entry (see MyAnalyticsPanel.tsx) — that one is NOT
// reachable from here. Team is scoped server-side to the admin's own direct
// reports (may be empty if they don't manage anyone); the company-wide tier is
// server-gated to workspaceRole==='admin', which is redundant with
// AdminConsole's own gate but kept for defense-in-depth, same posture as
// every other admin route in this app.
export function AnalyticsTiersPanel() {
  const [tier, setTier] = useState<Tier>('company');
  return (
    <div>
      <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5 mb-3">
        {TIERS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTier(t.id)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
              tier === t.id
                ? 'bg-white dark:bg-gray-700 text-purple-700 dark:text-purple-300 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tier === 'individual' && <AnalyticsPanel />}
      {tier === 'team' && <TeamAnalyticsPanel />}
      {tier === 'company' && <CompanyAnalyticsPanel />}
    </div>
  );
}
