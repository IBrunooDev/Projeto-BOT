import type { Client } from 'discord.js';
import { supabase } from './supabase.js';
import { refreshRafflePanel } from './raffle-ui.js';
import { refreshPurchaseReviewMessage } from './purchase-ui.js';

let running = false;

export async function runMaintenance(client: Client) {
  if (running) return;
  running = true;
  try {
    // Primeiro libera análises vencidas; depois expira reservas pendentes.
    // Isso evita deixar uma compra em estado intermediário após reinício da host.
    const { data: released, error: releaseError } = await supabase.rpc('release_stale_reviews');
    if (releaseError) throw releaseError;
    const { data: expired, error: expireError } = await supabase.rpc('expire_pending_reservations');
    if (expireError) throw expireError;

    if ((expired ?? 0) > 0 || (released ?? 0) > 0) {
      const { data: raffles } = await supabase
        .from('raffles')
        .select('id')
        .in('status', ['active', 'paused', 'closed'])
        .is('deleted_at', null);
      for (const r of raffles ?? []) await refreshRafflePanel(client, r.id);

      const { data: recent } = await supabase
        .from('purchases')
        .select('id')
        .in('status', ['pending', 'expired'])
        .order('created_at', { ascending: false })
        .limit(100);
      for (const p of recent ?? []) await refreshPurchaseReviewMessage(client, p.id);

      console.log(`🧹 Manutenção: ${released ?? 0} análise(s) liberada(s), ${expired ?? 0} reserva(s) expirada(s).`);
    }
  } finally {
    running = false;
  }
}
